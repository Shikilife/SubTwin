(function (root) {
  class NetflixAdapter {
    constructor() {
      this.tracks = [];
      this.cues = new Map();
      this.pending = new Map();
      this.activeTrackId = null;
      this.playerReady = false;
      this.sessionId = null;
      this.lastBridgeError = null;
      this.lastSubtitleFormat = null;
      this.lastParseDiagnostics = null;
      this.playerDiagnostics = {
        playerFound: false,
        trackApi: null,
        selectedTrack: null,
        requestedTrack: null,
        activeTrackLimit: "UNKNOWN",
        observedTransports: ["window.fetch", "XMLHttpRequest"],
        unobservedTransports: ["MediaSource/binary pipelines", "requests initiated wholly inside workers or Netflix internal networking"],
        counters: { observedFetchRequests: 0, observedXHRRequests: 0, subtitleRequestsObserved: 0, subtitleResponsesObserved: 0, lastSubtitleUrl: null, lastSubtitleContentType: null, lastSubtitleTransport: null, lastSubtitleTrackId: null, trackSelectionCalls: 0, distinctSelectedTracksObserved: [] },
        trackMetadata: []
      };
      this.parseSuccessCount = 0;
      this.parseFailureCount = 0;
      this.unattributedResponseCount = 0;
      this.trackParseAttempts = new Map();
      this.trackParseCounts = new Map();
      this.trackParseFailures = new Map();
      this.trackErrors = new Map();
      this.trackSignature = "";
      this.sessionChangeHandler = null;
      this.pendingSelections = new Map();
      this.selectionResults = new Map();
      this.pendingDiagnostics = new Map();
      this.pendingBridgeRequests = new Map();
      this.rawResponseCacheHits = 0;
      this.parsedCueCacheHits = 0;
      this.trackSelectionsAvoidedByCache = 0;
      this.bridgeInstalledAt = null;
      this.playerReadyAt = null;
      this.originalNativeTrackId = null;
      this.restoredNativeTrackId = null;
      this.nativeCaptionFlashDetected = "MANUAL_ONLY";
      this.acquisitionLock = Promise.resolve();
      this.destroyed = false;
      this.messageHandler = (event) => this.handleBridgeMessage(event);
      window.addEventListener("message", this.messageHandler);
      this.post({ type: "adapterReady" });
      this.post({ type: "getTracks" });
      console.info("[SubTwin][Netflix] waiting for player session");
    }

    handleBridgeMessage(event) {
      if (this.destroyed || event.source !== window || event.origin !== location.origin || !event.data || event.data.source !== "DUALSUB_NFLX") return;
      const message = event.data;
      if (message.type === "player") {
        this.playerReady = message.ready === true;
        return;
      }
      if (message.type === "session") {
        const changed = this.sessionId !== null && this.sessionId !== message.sessionId;
        const previousSessionId = this.sessionId;
        if (changed) {
          this.tracks = [];
          this.trackSignature = "";
          this.cues.clear();
          this.trackParseAttempts.clear();
          this.trackParseCounts.clear();
          this.trackParseFailures.clear();
          this.trackErrors.clear();
          this.originalNativeTrackId = null;
          this.restoredNativeTrackId = null;
          this.rejectPending(new Error("NETFLIX_SESSION_CHANGED: Netflix playback session changed."));
          for (const [requestId, pending] of this.pendingBridgeRequests) {
            clearTimeout(pending.timer);
            this.pendingBridgeRequests.delete(requestId);
            pending.reject(new Error("NETFLIX_SESSION_CHANGED: Netflix playback session changed."));
          }
          for (const [requestId, pending] of this.pendingSelections) {
            clearTimeout(pending.timer);
            this.pendingSelections.delete(requestId);
            pending.reject(new Error("NETFLIX_SESSION_CHANGED: Netflix playback session changed."));
          }
        }
        this.sessionId = message.sessionId || null;
        this.activeTrackId = null;
        if (changed) this.sessionChangeHandler?.({ reason: "player-session", previousSessionId, sessionId: this.sessionId });
        return;
      }
      if (message.type === "cachedSubtitleResponses") {
        const pending = this.pendingBridgeRequests.get(message.requestId);
        if (!pending || pending.kind !== "cache") return;
        clearTimeout(pending.timer);
        this.pendingBridgeRequests.delete(message.requestId);
        if (this.sessionId && message.sessionId && String(message.sessionId) !== String(this.sessionId)) {
          pending.resolve([]);
          return;
        }
        const entries = Array.isArray(message.entries) ? message.entries : [];
        this.rawResponseCacheHits += entries.length > 0 ? 1 : 0;
        for (const entry of entries) this.ingestSubtitleMessage({ ...entry, trackId: message.trackId, sessionId: message.sessionId, contentType: entry.contentType, transport: "raw-cache" });
        pending.resolve(entries);
        return;
      }
      if (message.type === "nativeTrackSnapshot" || message.type === "nativeTrackRestored") {
        const pending = this.pendingBridgeRequests.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingBridgeRequests.delete(message.requestId);
        if (message.type === "nativeTrackSnapshot") this.originalNativeTrackId = message.trackId || null;
        else if (message.ok) this.restoredNativeTrackId = message.trackId || null;
        if (message.ok === false) pending.reject(new Error(message.message || "Netflix native track operation failed."));
        else pending.resolve(message.trackId || null);
        return;
      }
      if (message.type === "error") {
        this.lastBridgeError = { code: message.code || "NETFLIX_PLAYER_NOT_FOUND", message: message.message || "Netflix page bridge error." };
        console.warn(`[SubTwin][Netflix] ${this.lastBridgeError.code}`, this.lastBridgeError.message);
        if (this.activeTrackId && this.lastBridgeError.code !== "NETFLIX_SUBTITLE_REQUEST_NOT_FOUND") {
          this.rejectPendingForTrack(this.activeTrackId, new Error(`${this.lastBridgeError.code}: ${this.lastBridgeError.message}`));
        }
        for (const [requestId, pending] of this.pendingSelections) {
          if (pending.trackId !== this.activeTrackId || this.lastBridgeError.code === "NETFLIX_SUBTITLE_REQUEST_NOT_FOUND") continue;
          clearTimeout(pending.timer);
          this.pendingSelections.delete(requestId);
          pending.reject(new Error(`${this.lastBridgeError.code}: ${this.lastBridgeError.message}`));
        }
        return;
      }
      if (message.type === "diagnostics") {
        this.playerDiagnostics = { ...this.playerDiagnostics, ...message };
        this.bridgeInstalledAt = message.bridgeInstalledAt || this.bridgeInstalledAt;
        this.playerReadyAt = message.playerReadyAt || this.playerReadyAt;
        if (message.requestId && this.pendingDiagnostics.has(message.requestId)) {
          const pending = this.pendingDiagnostics.get(message.requestId);
          clearTimeout(pending.timer);
          this.pendingDiagnostics.delete(message.requestId);
          pending.resolve(this.getDiagnostics());
        }
        return;
      }
      if (message.type === "selectionResult") {
        const pending = this.pendingSelections.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pendingSelections.delete(message.requestId);
        if (message.ok) {
          this.selectionResults.set(pending.trackId, message);
          pending.resolve(message);
        } else {
          const error = new Error(message.expectedAbort ? "AbortError: subtitle request aborted during track switch." : `NETFLIX_TRACKS_NOT_FOUND: ${message.message || "Netflix rejected the selected text track."}`);
          if (message.expectedAbort) error.name = "AbortError";
          pending.reject(error);
        }
        return;
      }
      if (message.type === "tracks") {
        if (this.sessionId && message.sessionId && this.sessionId !== message.sessionId) return;
        if (!this.sessionId && message.sessionId) this.sessionId = String(message.sessionId);
        this.playerReady = true;
        this.lastBridgeError = null;
        const nextTracks = (message.tracks || []).map(root.DualSubtitle.types.normalizeTrack);
        const nextSignature = JSON.stringify(nextTracks.map(({ id, language }) => `${id}|${language}`).sort());
        const changed = !!this.trackSignature && nextSignature !== this.trackSignature;
        this.tracks = nextTracks;
        this.trackSignature = nextSignature;
        if (this.tracks.length) console.info(`[SubTwin][Netflix] ${this.tracks.length} subtitle tracks found`);
        if (changed) this.sessionChangeHandler?.({ reason: "track-list-changed", sessionId: this.sessionId });
        return;
      }
      if (message.type === "subtitle") {
        this.ingestSubtitleMessage(message);
      }
    }

    ingestSubtitleMessage(message) {
      this.playerDiagnostics.counters.lastSubtitleTransport = message.transport || null;
      const id = message.trackId;
      if (!id) { this.unattributedResponseCount++; return; }
      if (this.sessionId && message.sessionId && String(message.sessionId) !== String(this.sessionId)) return;
      if (!this.tracks.some((track) => track.id === id)) { this.unattributedResponseCount++; return; }
      const body = String(message.body || "");
      this.trackParseAttempts.set(id, (this.trackParseAttempts.get(id) || 0) + 1);
      const parsed = root.DualSubtitle.types.parseCuesDetailed(body);
      const incoming = parsed.cues;
      this.lastParseDiagnostics = parsed.diagnostics;
      this.lastSubtitleFormat = parsed.diagnostics.format || this.detectFormat(message.contentType, body);
      console.info(`[SubTwin][Netflix] subtitle format=${this.lastSubtitleFormat}; parsed cues=${incoming.length}`);
      if (!incoming.length) {
        this.parseFailureCount++;
        this.trackParseFailures.set(id, (this.trackParseFailures.get(id) || 0) + 1);
        const reason = parsed.diagnostics.parseError || "NO_CUES";
        const error = { code: "NETFLIX_PARSE_FAILED", trackId: id, message: `${reason}; no cues parsed from ${this.lastSubtitleFormat || "unknown subtitle format"}.` };
        this.trackErrors.set(id, error);
        this.lastBridgeError = error;
        console.warn(`[SubTwin][Netflix] NETFLIX_PARSE_FAILED (${this.lastSubtitleFormat || "unknown format"})`, parsed.diagnostics);
        this.rejectPendingForTrack(id, new Error(`${error.code}: ${error.message}`));
        return;
      }
      const byStart = new Map((this.cues.get(id) || []).map((cue) => [cue.startMs, cue]));
      incoming.forEach((cue) => byStart.set(cue.startMs, cue));
      const merged = [...byStart.values()].sort((a, b) => a.startMs - b.startMs);
      this.cues.set(id, merged);
      this.parseSuccessCount++;
      this.trackParseCounts.set(id, (this.trackParseCounts.get(id) || 0) + 1);
      this.trackErrors.delete(id);
      if (this.lastBridgeError?.trackId === id) this.lastBridgeError = null;
      const waiting = this.pending.get(id);
      if (waiting) {
        clearTimeout(waiting.timer);
        waiting.resolve(merged);
        this.pending.delete(id);
      }
    }

    detectFormat(contentType, body) {
      const prefix = String(body || "").trimStart().slice(0, 200).toLowerCase();
      if (/webvtt/.test(prefix) || /text\/vtt/i.test(contentType || "")) return "WebVTT";
      if (/<(?:\w+:)?tt\b/.test(prefix) || /ttml|dfxp/i.test(contentType || "")) return "TTML/DFXP";
      if (prefix.startsWith("{") || prefix.startsWith("[")) return "JSON timed text";
      if (/<(?:\w+:)?p\b/.test(prefix)) return "XML timed text";
      return "unknown";
    }

    rejectPendingForTrack(trackId, error) {
      const waiting = this.pending.get(trackId);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(trackId);
      waiting.reject(error);
    }

    rejectPending(error) {
      for (const [trackId, waiting] of this.pending) {
        clearTimeout(waiting.timer);
        waiting.reject(error);
        this.pending.delete(trackId);
      }
    }

    post(data) {
      window.postMessage({ ...data, source: "DUALSUB_NFLX_CONTENT" }, location.origin);
    }

    onSessionChange(handler) {
      this.sessionChangeHandler = typeof handler === "function" ? handler : null;
    }

    getOverlayContainer() {
      const video = document.querySelector("video");
      const fullscreen = document.fullscreenElement;
      if (fullscreen && fullscreen !== video && video && fullscreen.contains(video)) return fullscreen;
      if (!video) return null;
      const videoRect = video.getBoundingClientRect();
      let container = video.parentElement;
      while (container && container !== document.body && container !== document.documentElement) {
        const rect = container.getBoundingClientRect();
        if (rect.width + 2 >= videoRect.width && rect.height + 2 >= videoRect.height) return container;
        container = container.parentElement;
      }
      return video.parentElement || null;
    }

    async getAvailableTracks() {
      for (let i = 0; i < 60 && !this.tracks.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!document.querySelector("video")) throw new Error("NO_VIDEO");
      if (!this.playerReady && this.lastBridgeError?.code === "NETFLIX_PLAYER_NOT_FOUND") {
        throw new Error(`${this.lastBridgeError.code}: ${this.lastBridgeError.message}`);
      }
      if (!this.tracks.length) {
        if (this.lastBridgeError) throw new Error(`${this.lastBridgeError.code}: ${this.lastBridgeError.message}`);
        throw new Error(this.playerReady ? "NETFLIX_TRACKS_NOT_FOUND: player is ready but exposes no timed text tracks." : "NETFLIX_PLAYER_NOT_FOUND: player session was not detected.");
      }
      console.info("[SubTwin][Netflix] player ready");
      return this.tracks;
    }

    async selectTrack(trackId) {
      const track = this.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error("NETFLIX_TRACKS_NOT_FOUND: unknown track id.");
      this.activeTrackId = track.id;
      const requestId = `nflx-select-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const result = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingSelections.delete(requestId);
          reject(new Error("NETFLIX_TRACKS_NOT_FOUND: player did not acknowledge the text track selection."));
        }, 3000);
        this.pendingSelections.set(requestId, { resolve, reject, timer, trackId: track.id });
      });
      this.post({ type: "selectTrack", trackId: track.id, requestId });
      await result;
      return track;
    }

    async selectTracks(primaryId, secondaryId) {
      const run = this.acquisitionLock.then(() => this.acquireTracks(primaryId, secondaryId));
      this.acquisitionLock = run.catch(() => {});
      return run;
    }

    async requestBridge(type, responseType, extra = {}, timeoutMs = 1500) {
      const requestId = `nflx-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingBridgeRequests.delete(requestId);
          reject(new Error(`NETFLIX_BRIDGE_TIMEOUT: ${type} did not respond.`));
        }, timeoutMs);
        this.pendingBridgeRequests.set(requestId, { resolve, reject, timer, kind: type === "getCachedSubtitleResponses" ? "cache" : type });
      });
      this.post({ type, requestId, ...extra });
      return response;
    }

    async acquireTracks(primaryId, secondaryId) {
      const acquisitionSessionId = this.sessionId;
      let snapshotTaken = false;
      let changedNativeTrack = false;
      const acquire = async (trackId) => {
        if (!trackId) return { cues: [], selected: false, error: null };
        let cached = this.getCachedCues(trackId);
        if (cached.length) {
          this.parsedCueCacheHits++;
          this.trackSelectionsAvoidedByCache++;
          return { cues: cached, selected: false, cache: "parsed", error: null };
        }
        try {
          await this.requestBridge("getCachedSubtitleResponses", "cachedSubtitleResponses", { trackId }, 1200);
        } catch (_) {
          // The bridge cache is an optimization; fall through to player acquisition.
        }
        if (acquisitionSessionId !== this.sessionId) throw new Error("NETFLIX_SESSION_CHANGED: Netflix playback session changed during acquisition.");
        cached = this.getCachedCues(trackId);
        if (cached.length) {
          this.trackSelectionsAvoidedByCache++;
          return { cues: cached, selected: false, cache: "raw-response", error: null };
        }

        let selected = false;
        try {
          if (!snapshotTaken) {
            await this.requestBridge("beginTrackAcquisition", "nativeTrackSnapshot");
            snapshotTaken = true;
          }
          if (acquisitionSessionId !== this.sessionId) throw new Error("NETFLIX_SESSION_CHANGED: Netflix playback session changed during acquisition.");
          changedNativeTrack = true;
          await this.selectTrack(trackId);
          selected = true;
          const cues = await this.getCues(trackId, 4500);
          this.trackErrors.delete(trackId);
          console.info(`[SubTwin][Netflix] track acquisition complete: ${trackId}; cues=${cues.length}`);
          return { cues, selected, error: null };
        } catch (error) {
          const message = String(error?.message || error);
          const code = error?.name === "AbortError" ? "REQUEST_ABORTED" : /^(NETFLIX_SESSION_CHANGED|NETFLIX_PARSE_FAILED|NETFLIX_SUBTITLE_REQUEST_NOT_FOUND)/.exec(message)?.[1] || "NETFLIX_SUBTITLE_REQUEST_NOT_FOUND";
          if (code === "NETFLIX_SESSION_CHANGED") return { cues: [], selected: false, error: { code, trackId, message } };
          const metadata = this.playerDiagnostics.trackMetadata?.find((entry) => entry.id === trackId);
          const metadataReportsLoaded = metadata?.summary?.isCached === true || metadata?.summary?.isLoaded === true;
          const failure = metadataReportsLoaded
            ? { code: "NO_OBSERVABLE_RESPONSE", trackId, message: `Track metadata reports cached/loaded, but no cue data was exposed: ${message}` }
            : { code, trackId, message };
          this.trackErrors.set(trackId, failure);
          if (/AbortError|aborted during track switch/i.test(message)) console.info("[SubTwin][Netflix] subtitle request aborted during track switch");
          else console.warn(`[SubTwin][Netflix] track acquisition timed out/failed: ${trackId}`, failure.message);
          return { cues: this.getCachedCues(trackId), selected, error: failure };
        }
      };

      try {
        const primary = await acquire(primaryId);
        const secondary = secondaryId == null ? { cues: [], selected: false, error: null } : await acquire(secondaryId);
        console.info("[SubTwin][Netflix] dual acquisition result", {
          primary: { trackId: primaryId, selected: primary.selected, cueCount: primary.cues.length, error: primary.error?.code || null },
          secondary: { trackId: secondaryId || null, selected: secondary.selected, cueCount: secondary.cues.length, error: secondary.error?.code || null }
        });
        return { primary: primary.cues, secondary: secondary.cues, acquisition: { primary, secondary } };
      } finally {
        if (changedNativeTrack && snapshotTaken) {
          if (acquisitionSessionId !== this.sessionId) return;
          try { await this.requestBridge("restoreNativeTrack", "nativeTrackRestored", {}, 2500); }
          catch (error) { console.warn("[SubTwin][Netflix] native subtitle track restore failed", String(error?.message || error)); }
        }
      }
    }

    getCachedCues(trackId) {
      return this.cues.get(trackId) || [];
    }

    async acquireCuesForExport(trackId) {
      const cached = this.getCachedCues(trackId);
      if (cached.length) {
        this.parsedCueCacheHits++;
        this.trackSelectionsAvoidedByCache++;
        return cached;
      }
      const result = await this.selectTracks(trackId, null);
      if (!result.primary.length) throw new Error(result.acquisition.primary.error?.message || `NETFLIX_SUBTITLE_REQUEST_NOT_FOUND: no cues available for ${trackId}.`);
      return result.primary;
    }

    getDiagnostics() {
      const cueCounts = Object.fromEntries(this.tracks.map((track) => [track.id, this.cues.get(track.id)?.length || 0]));
      const pageTrackMetadata = this.playerDiagnostics.trackMetadata || [];
      const latestSelection = pageTrackMetadata.find((entry) => entry.id === this.playerDiagnostics.requestedTrack)?.acquisition || {};
      const tracks = Object.fromEntries(this.tracks.map((track) => {
        const metadata = pageTrackMetadata.find((entry) => entry.id === track.id);
        const acquisition = metadata?.acquisition || {};
        const cueCount = cueCounts[track.id] || 0;
        const isCached = metadata?.summary?.isCached ?? null;
        const isLoaded = metadata?.summary?.isLoaded ?? null;
        return [track.id, {
          language: track.language,
          label: track.label,
          rawType: metadata?.rawType ?? null,
          rawTrackType: metadata?.rawTrackType ?? null,
          trackType: metadata?.trackType ?? null,
          isForced: metadata?.isForced ?? null,
          isForcedNarrative: metadata?.isForcedNarrative ?? null,
          isSDH: metadata?.isSDH ?? null,
          isCC: metadata?.isCC ?? null,
          isDubbed: metadata?.isDubbed ?? null,
          isOriginal: metadata?.isOriginal ?? null,
          isNone: metadata?.isNone ?? null,
          isOff: metadata?.isOff ?? null,
          selectable: metadata?.selectable ?? null,
          profile: metadata?.profile ?? null,
          trackWasRequested: acquisition.trackWasRequested === true,
          trackWasObserved: acquisition.trackWasObserved === true,
          trackWasParsed: (this.trackParseAttempts.get(track.id) || 0) > 0,
          selectedSuccessfully: acquisition.selectedSuccessfully === true,
          selectionRequestedAt: acquisition.selectionRequestedAt || null,
          selectionObservedAt: acquisition.selectionObservedAt || null,
          requestedTrackId: acquisition.requestedTrackId || null,
          observedSelectedTrackId: acquisition.observedSelectedTrackId || null,
          selectionSetterResolved: acquisition.selectionSetterResolved ?? null,
          selectedTrackMatchedRequested: acquisition.selectedTrackMatchedRequested ?? null,
          selectionChangedToNone: acquisition.selectionChangedToNone ?? null,
          selectionOutcome: acquisition.selectionOutcome || "not-tested",
          trackSelectionCount: acquisition.trackSelectionCount || 0,
          selectionSucceededCount: acquisition.selectionSucceededCount || 0,
          subtitleRequestCount: acquisition.subtitleRequestCount || 0,
          subtitleResponseCount: acquisition.subtitleResponseCount || 0,
          abortedRequestCount: acquisition.abortedRequestCount || 0,
          abortedAfterTrackSwitchCount: acquisition.abortedAfterTrackSwitchCount || 0,
          lastTransport: acquisition.lastTransport || null,
          requestsAtLastSelection: acquisition.requestsAtLastSelection || null,
          subtitleRequestsAfterSelection: acquisition.subtitleRequestsAfterSelection || 0,
          fetchRequestsAfterSelection: acquisition.fetchRequestsAfterSelection || 0,
          xhrRequestsAfterSelection: acquisition.xhrRequestsAfterSelection || 0,
          subtitleRequestsBeforeLastSelection: acquisition.subtitleRequestsAtLastSelection || 0,
          resourceCount: metadata?.summary?.resourceCount ?? null,
          profiles: metadata?.summary?.profiles || [],
          hasUrls: metadata?.summary?.hasUrls ?? false,
          isCached,
          isLoaded,
          cacheStatus: cueCount > 0 ? "subtwin-cue-cache" : isCached === true || isLoaded === true ? "metadata-reports-cached-or-loaded" : isCached === false || isLoaded === false ? "metadata-reports-not-cached-or-loaded" : "unknown",
          cachedBeforeInterception: "UNKNOWN",
          cueCount,
          parseAttemptCount: this.trackParseAttempts.get(track.id) || 0,
          parseSuccessCount: this.trackParseCounts.get(track.id) || 0,
          parseFailureCount: this.trackParseFailures.get(track.id) || 0,
          lastError: this.trackErrors.get(track.id) || acquisition.lastError || null
        }];
      }));
      for (const metadata of pageTrackMetadata) {
        if (!tracks[metadata.id]) tracks[metadata.id] = {
          language: metadata.language || "und",
          label: metadata.label || metadata.id,
          rawType: metadata.rawType ?? null,
          rawTrackType: metadata.rawTrackType ?? null,
          trackType: metadata.trackType ?? null,
          isForced: metadata.isForced ?? null,
          isForcedNarrative: metadata.isForcedNarrative ?? null,
          isSDH: metadata.isSDH ?? null,
          isCC: metadata.isCC ?? null,
          isDubbed: metadata.isDubbed ?? null,
          isOriginal: metadata.isOriginal ?? null,
          isNone: metadata.isNone ?? null,
          isOff: metadata.isOff ?? null,
          selectable: metadata.selectable ?? null,
          resourceCount: metadata.resourceCount ?? null,
          profiles: metadata.summary?.profiles || [],
          cueCount: 0,
          parseAttemptCount: 0,
          parseSuccessCount: 0,
          parseFailureCount: 0,
          selectionOutcome: metadata.acquisition?.selectionOutcome || "not-tested",
          selectedTrackMatchedRequested: metadata.acquisition?.selectedTrackMatchedRequested ?? null,
          selectionChangedToNone: metadata.acquisition?.selectionChangedToNone ?? null,
          requestedTrackId: metadata.acquisition?.requestedTrackId || null,
          observedSelectedTrackId: metadata.acquisition?.observedSelectedTrackId || null
        };
      }
      return {
        playerFound: this.playerDiagnostics.playerFound,
        bridgeInstalledAt: this.playerDiagnostics.bridgeInstalledAt || this.bridgeInstalledAt,
        playerReadyAt: this.playerDiagnostics.playerReadyAt || this.playerReadyAt,
        earlySubtitleRequestsCaptured: this.playerDiagnostics.earlySubtitleRequestsCaptured || 0,
        earlySubtitleResponsesCaptured: this.playerDiagnostics.earlySubtitleResponsesCaptured || 0,
        rawResponseCacheHits: this.rawResponseCacheHits,
        rawResponseCacheEntries: this.playerDiagnostics.rawResponseCacheEntries || 0,
        rawResponseCacheBytes: this.playerDiagnostics.rawResponseCacheBytes || 0,
        parsedCueCacheHits: this.parsedCueCacheHits,
        trackSelectionsAvoidedByCache: this.trackSelectionsAvoidedByCache,
        originalNativeTrackId: this.originalNativeTrackId,
        restoredNativeTrackId: this.restoredNativeTrackId,
        nativeSuppressionActive: this.playerDiagnostics.nativeSuppressionActive === true,
        nativeCaptionFlashDetected: this.nativeCaptionFlashDetected,
        trackApi: this.playerDiagnostics.trackApi,
        selectedTrack: this.playerDiagnostics.selectedTrack,
        requestedTrack: this.playerDiagnostics.requestedTrack,
        selectionRequestedAt: latestSelection.selectionRequestedAt || null,
        selectionObservedAt: latestSelection.selectionObservedAt || null,
        requestedTrackId: latestSelection.requestedTrackId || this.playerDiagnostics.requestedTrack || null,
        observedSelectedTrackId: latestSelection.observedSelectedTrackId || this.playerDiagnostics.selectedTrack || null,
        selectionSetterResolved: latestSelection.selectionSetterResolved ?? null,
        selectedTrackMatchedRequested: latestSelection.selectedTrackMatchedRequested ?? null,
        selectionChangedToNone: latestSelection.selectionChangedToNone ?? null,
        selectionOutcome: latestSelection.selectionOutcome || "not-tested",
        activeTrackLimit: this.playerDiagnostics.activeTrackLimit,
        observedTransports: this.playerDiagnostics.observedTransports,
        unobservedTransports: this.playerDiagnostics.unobservedTransports,
        observedFetchRequests: this.playerDiagnostics.counters.observedFetchRequests,
        observedXHRRequests: this.playerDiagnostics.counters.observedXHRRequests,
        subtitleRequestsObserved: this.playerDiagnostics.counters.subtitleRequestsObserved,
        subtitleResponsesObserved: this.playerDiagnostics.counters.subtitleResponsesObserved,
        lastSubtitleUrl: this.playerDiagnostics.counters.lastSubtitleUrl,
        lastSubtitleContentType: this.playerDiagnostics.counters.lastSubtitleContentType,
        lastSubtitleTransport: this.playerDiagnostics.counters.lastSubtitleTransport,
        lastSubtitleTrackId: this.playerDiagnostics.counters.lastSubtitleTrackId,
        lastSubtitleFormat: this.lastSubtitleFormat,
        lastParseDiagnostics: this.lastParseDiagnostics,
        parseSuccessCount: this.parseSuccessCount,
        parseFailureCount: this.parseFailureCount,
        unattributedResponseCount: this.unattributedResponseCount,
        perTrackCueCounts: cueCounts,
        tracks,
        trackMetadata: this.playerDiagnostics.trackMetadata,
        selectionCalls: this.playerDiagnostics.counters.trackSelectionCalls,
        distinctSelectedTracksObserved: this.playerDiagnostics.counters.distinctSelectedTracksObserved
      };
    }

    async getDiagnosticsAsync() {
      const requestId = `nflx-diagnostics-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pendingDiagnostics.delete(requestId);
          reject(new Error("NETFLIX_PLAYER_NOT_FOUND: page bridge did not return diagnostics."));
        }, 2500);
        this.pendingDiagnostics.set(requestId, { resolve, reject, timer });
      });
      this.post({ type: "getDiagnostics", requestId });
      return response;
    }

    async testTrackById(trackId, timeoutMs = 4500) {
      if (typeof trackId !== "string" || !trackId || trackId.length > 256) throw new TypeError("Use testTrackById(trackId) with a current Netflix track ID.");
      if (!this.tracks.some((track) => track.id === trackId)) throw new Error("NETFLIX_TRACKS_NOT_FOUND: track id is not in the current listTracks() result.");
      const startedAt = Date.now();
      const before = this.getDiagnostics().tracks[trackId] || {};
      let setterResult = null;
      let error = null;
      this.selectionResults.delete(trackId);
      let snapshotTaken = false;
      try {
        await this.requestBridge("beginTrackAcquisition", "nativeTrackSnapshot");
        snapshotTaken = true;
        await this.selectTrack(trackId);
        setterResult = this.selectionResults.get(trackId) || null;
      } catch (failure) {
        error = String(failure?.message || failure);
      }
      const maxWait = Math.min(4500, Math.max(0, Number(timeoutMs) || 4500));
      const remaining = Math.max(0, maxWait - (Date.now() - startedAt));
      const deadline = Date.now() + remaining;
      let current = this.getDiagnostics().tracks[trackId] || {};
      while (Date.now() < deadline) {
        const requestSeen = (current.subtitleRequestsAfterSelection || 0) > 0;
        const responseSeen = (current.subtitleResponseCount || 0) > (before.subtitleResponseCount || 0);
        const parseSeen = (this.trackParseAttempts.get(trackId) || 0) > (before.parseAttemptCount || 0);
        const cues = this.getCachedCues(trackId);
        if (requestSeen || responseSeen || parseSeen || cues.length) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
        current = this.getDiagnostics().tracks[trackId] || current;
      }
      if (snapshotTaken) {
        try { await this.requestBridge("restoreNativeTrack", "nativeTrackRestored", {}, 2500); }
        catch (failure) { error ||= String(failure?.message || failure); }
      }
      current = this.getDiagnostics().tracks[trackId] || current;
      const observedId = current.observedSelectedTrackId || this.playerDiagnostics.selectedTrack || null;
      return {
        requestedTrackId: trackId,
        selectionSucceeded: setterResult?.selectionSetterResolved === true && (setterResult?.selectedTrackMatchedRequested === true || current.selectedTrackMatchedRequested === true || !!current.selectionObservedAt),
        selectionSetterResolved: setterResult?.selectionSetterResolved === true,
        selectedTrackAfterSetter: setterResult?.selectedTrackId || null,
        observedSelectedTrackId: observedId,
        requestObserved: (current.subtitleRequestsAfterSelection || 0) > 0,
        responseObserved: (current.subtitleResponseCount || 0) > (before.subtitleResponseCount || 0),
        parseAttempted: (this.trackParseAttempts.get(trackId) || 0) > (before.parseAttemptCount || 0),
        cueCount: this.getCachedCues(trackId).length,
        revertedToNone: current.selectionChangedToNone === true,
        selectionOutcome: current.selectionOutcome || setterResult?.selectionOutcome || "unknown",
        selectionRequestedAt: current.selectionRequestedAt || setterResult?.selectionRequestedAt || null,
        selectionObservedAt: current.selectionObservedAt || setterResult?.selectionObservedAt || null,
        error
      };
    }

    async getCues(trackId, timeoutMs = 20000) {
      if (this.cues.get(trackId)?.length) return this.cues.get(trackId);
      const existing = this.pending.get(trackId);
      if (existing) return existing.promise;
      let resolveCue;
      let rejectCue;
      const promise = new Promise((resolve, reject) => {
        resolveCue = resolve;
        rejectCue = reject;
      });
      const timer = setTimeout(() => {
        this.pending.delete(trackId);
        rejectCue(new Error(`NETFLIX_SUBTITLE_REQUEST_NOT_FOUND: no usable subtitle response observed for ${trackId}${this.lastSubtitleFormat ? ` (${this.lastSubtitleFormat})` : ""}.`));
      }, timeoutMs);
      this.pending.set(trackId, { resolve: resolveCue, reject: rejectCue, timer, promise });
      return promise;
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      window.removeEventListener("message", this.messageHandler);
      this.rejectPending(new Error("NETFLIX_SESSION_CHANGED: Netflix adapter was disposed."));
      for (const [requestId, pending] of this.pendingSelections) {
        clearTimeout(pending.timer);
        pending.reject(new Error("NETFLIX_SESSION_CHANGED: Netflix adapter was disposed."));
        this.pendingSelections.delete(requestId);
      }
      for (const [requestId, pending] of this.pendingDiagnostics) {
        clearTimeout(pending.timer);
        pending.reject(new Error("NETFLIX_SESSION_CHANGED: Netflix adapter was disposed."));
        this.pendingDiagnostics.delete(requestId);
      }
      for (const [requestId, pending] of this.pendingBridgeRequests) {
        clearTimeout(pending.timer);
        pending.reject(new Error("NETFLIX_SESSION_CHANGED: Netflix adapter was disposed."));
        this.pendingBridgeRequests.delete(requestId);
      }
      this.tracks = [];
      this.cues.clear();
      this.sessionChangeHandler = null;
    }
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.NetflixAdapter = NetflixAdapter;
})(globalThis);
