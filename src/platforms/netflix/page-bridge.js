(() => {
  if (window.__dualSubtitleNetflixBridge) return;
  window.__dualSubtitleNetflixBridge = true;

  const SOURCE = "DUALSUB_NFLX";
  const bridgeInstalledAt = new Date().toISOString();
  let activeTrackId = null;
  let nativeTracks = [];
  let allNativeTracks = [];
  let lastSessionId = null;
  let lastTrackSignature = "";
  let discoverTimer = 0;
  let trackApi = null;
  let selectedTrackId = null;
  let playerReadyAt = null;
  let originalNativeTrack = null;
  let restoredNativeTrackId = null;
  const responseCache = new Map();
  let responseCacheBytes = 0;
  const RESPONSE_CACHE_MAX_BYTES = 8 * 1024 * 1024;
  const RESPONSE_CACHE_MAX_ENTRIES = 64;
  const RESPONSE_CACHE_MAX_PER_TRACK = 12;
  const trackDiagnostics = new Map();
  const selectionMonitors = new Map();
  const diagnostics = {
    observedFetchRequests: 0,
    observedXHRRequests: 0,
    subtitleRequestsObserved: 0,
    subtitleResponsesObserved: 0,
    lastSubtitleUrl: null,
    lastSubtitleContentType: null,
    lastSubtitleTransport: null,
    lastSubtitleTrackId: null,
    trackSelectionCalls: 0,
    distinctSelectedTracksObserved: [],
    earlySubtitleRequestsCaptured: 0,
    earlySubtitleResponsesCaptured: 0,
    rawResponseCacheHits: 0
  };
  const send = (data) => window.postMessage({ ...data, source: SOURCE }, location.origin);

  function clearResponseCache() {
    responseCache.clear();
    responseCacheBytes = 0;
  }

  function cacheSubtitleResponse(trackId, body, format, contentType, sessionKey, transport) {
    if (!trackId || typeof body !== "string" || !body) return;
    if (sessionKey != null && lastSessionId != null && String(sessionKey) !== String(lastSessionId)) return;
    const bodyBytes = body.length * 2;
    if (bodyBytes > RESPONSE_CACHE_MAX_BYTES) return;
    const entry = { trackId, body, format, contentType: String(contentType || "") || null, capturedAt: Date.now(), sessionKey: sessionKey == null ? null : String(sessionKey), transport };
    const entries = responseCache.get(trackId) || [];
    entries.push(entry);
    responseCache.set(trackId, entries);
    responseCacheBytes += bodyBytes;
    while (responseCacheBytes > RESPONSE_CACHE_MAX_BYTES || [...responseCache.values()].reduce((sum, values) => sum + values.length, 0) > RESPONSE_CACHE_MAX_ENTRIES || entries.length > RESPONSE_CACHE_MAX_PER_TRACK) {
      const firstKey = responseCache.keys().next().value;
      const firstEntries = responseCache.get(firstKey);
      const evicted = firstEntries.shift();
      responseCacheBytes -= evicted.body.length * 2;
      if (!firstEntries.length) responseCache.delete(firstKey);
      if (!responseCache.has(trackId)) break;
    }
    diagnostics.earlySubtitleResponsesCaptured++;
  }

  function cachedResponsesFor(trackId) {
    const entries = responseCache.get(String(trackId || "")) || [];
    const usable = entries.filter((entry) => entry.sessionKey == null || lastSessionId == null || String(entry.sessionKey) === String(lastSessionId));
    diagnostics.rawResponseCacheHits += usable.length > 0 ? 1 : 0;
    return usable.map((entry) => ({ ...entry }));
  }

  function trackState(trackId) {
    if (!trackId) return null;
    if (!trackDiagnostics.has(trackId)) trackDiagnostics.set(trackId, {
      trackWasRequested: false,
      trackWasObserved: false,
      trackWasParsed: false,
      trackSelectionCount: 0,
      selectionSucceededCount: 0,
      selectedSuccessfully: false,
      subtitleRequestCount: 0,
      subtitleResponseCount: 0,
      abortedRequestCount: 0,
      abortedAfterTrackSwitchCount: 0,
      lastTransport: null,
      lastError: null,
      requestsAtLastSelection: null,
      subtitleRequestsAtLastSelection: 0,
      selectionRequestedAt: null,
      selectionObservedAt: null,
      requestedTrackId: null,
      observedSelectedTrackId: null,
      selectionSetterResolved: null,
      selectedTrackMatchedRequested: null,
      selectionChangedToNone: null,
      selectionOutcome: "not-tested"
    });
    return trackDiagnostics.get(trackId);
  }

  function metadataSummary(track) {
    const urls = new Set();
    const profiles = new Set();
    let isCached = null;
    let isLoaded = null;
    const visit = (value, key = "", depth = 0) => {
      if (depth > 5 || value == null) return;
      const normalized = String(key).toLowerCase();
      if (/(token|signature|cookie|authorization|password|account|email|user.?id|profile.?id)/i.test(normalized)) return;
      if (typeof value === "string") {
        if (/^(?:https?:)?\/\//i.test(value) && /(url|uri|resource|downloadable|segment|manifest|cdn)/i.test(normalized)) urls.add(value.split("?")[0]);
        if (/^(profile|trackprofile|ttmlprofile|profilename)$/i.test(normalized) && value.length < 100) profiles.add(value);
        return;
      }
      if (typeof value === "boolean" || (typeof value === "string" && /^(true|false)$/i.test(value))) {
        const flag = typeof value === "boolean" ? value : value.toLowerCase() === "true";
        if (/(cached|cacheAvailable|isCached)/i.test(normalized)) isCached = flag;
        if (/(loaded|downloaded|isLoaded)/i.test(normalized)) isLoaded = flag;
        return;
      }
      if (typeof value !== "object") return;
      if (Array.isArray(value)) {
        for (const child of value.slice(0, 50)) visit(child, key, depth + 1);
      } else {
        for (const [childKey, child] of Object.entries(value).slice(0, 100)) visit(child, childKey, depth + 1);
      }
    };
    try { visit(track); } catch (_) {}
    const directProfile = track?.profile ?? track?.ttmlProfile ?? track?.trackProfile ?? null;
    return { resourceCount: urls.size, profiles: [...profiles].slice(0, 12), profile: typeof directProfile === "string" || typeof directProfile === "number" ? String(directProfile).slice(0, 120) : null, hasUrls: urls.size > 0, isCached, isLoaded };
  }

  function metadataField(track, names) {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    const visit = (value, depth = 0) => {
      if (!value || typeof value !== "object" || depth > 4) return undefined;
      for (const [key, child] of Object.entries(value)) {
        if (wanted.has(key.toLowerCase()) && child != null && typeof child !== "object") return child;
      }
      for (const child of Object.values(value)) {
        if (Array.isArray(child)) {
          for (const item of child.slice(0, 20)) {
            const found = visit(item, depth + 1);
            if (found !== undefined) return found;
          }
        } else {
          const found = visit(child, depth + 1);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    return visit(track);
  }

  function booleanMetadata(track, names) {
    const value = metadataField(track, names);
    if (typeof value === "boolean") return value;
    if (value === 1 || value === 0) return value === 1;
    if (typeof value === "string" && /^(true|false|1|0)$/i.test(value.trim())) return /^(true|1)$/i.test(value.trim());
    return null;
  }

  function trackClassification(track) {
    const typeValue = metadataField(track, ["rawType", "type"]);
    const rawTrackTypeValue = metadataField(track, ["rawTrackType"]);
    const trackTypeValue = metadataField(track, ["trackType", "textTrackType"]);
    const summary = metadataSummary(track);
    return {
      rawType: typeof typeValue === "string" || typeof typeValue === "number" ? String(typeValue).slice(0, 120) : null,
      rawTrackType: typeof rawTrackTypeValue === "string" || typeof rawTrackTypeValue === "number" ? String(rawTrackTypeValue).slice(0, 120) : null,
      trackType: typeof trackTypeValue === "string" || typeof trackTypeValue === "number" ? String(trackTypeValue).slice(0, 120) : null,
      isForced: booleanMetadata(track, ["isForced", "forced"]),
      isForcedNarrative: booleanMetadata(track, ["isForcedNarrative", "forcedNarrative"]),
      isSDH: booleanMetadata(track, ["isSDH", "sdh", "isHearingImpaired"]),
      isCC: booleanMetadata(track, ["isCC", "isClosedCaption", "closedCaption"]),
      isDubbed: booleanMetadata(track, ["isDubbed", "dubbed"]),
      isOriginal: booleanMetadata(track, ["isOriginal", "original"]),
      isNone: booleanMetadata(track, ["isNone", "isNoneTrack", "none"]),
      isOff: booleanMetadata(track, ["isOff", "isOffTrack", "off", "isDisabled"]),
      selectable: booleanMetadata(track, ["selectable", "isSelectable", "canSelect"]),
      profile: summary.profile,
      resourceCount: summary.resourceCount
    };
  }

  function trackDebug(track, index) {
    const id = trackIdOf(track, index);
    const language = String(track.language || track.languageCode || track.bcp47 || "und");
    const label = String(track.displayName || track.label || track.name || track.language || `Subtitle ${index + 1}`);
    const classification = trackClassification(track);
    return {
      id,
      language,
      label,
      ...classification,
      metadata: sanitizeMetadata(track),
      summary: metadataSummary(track),
      acquisition: { ...trackState(id) }
    };
  }

  function displayLabel(track, label, classification) {
    const tags = [];
    const rawTrackType = String(classification.rawTrackType || classification.rawType || "").toUpperCase();
    const explicitlyCC = classification.isCC === true || rawTrackType === "CLOSEDCAPTIONS";
    if (explicitlyCC && !/\bcc\b|closed caption/i.test(label)) tags.push("CC");
    if (classification.isSDH === true && !/\bsd[h]?\b|hearing impaired/i.test(label)) tags.push("SDH");
    if (classification.isForced === true && !/forced/i.test(label)) tags.push("Forced");
    if (classification.isForcedNarrative === true && !/forced narrative/i.test(label)) tags.push("Forced narrative");
    return tags.length ? `${label} [${tags.join(", ")}]` : label;
  }

  function recordTrackRequest(trackId) {
    const state = trackState(trackId);
    if (state) {
      state.trackWasRequested = true;
      state.subtitleRequestCount++;
      state.lastError = null;
    }
  }

  function recordTrackResponse(trackId, transport) {
    const state = trackState(trackId);
    if (!state) return;
    state.trackWasObserved = true;
    state.subtitleResponseCount++;
    state.lastTransport = transport;
    state.lastError = null;
  }

  function recordTrackAbort(trackId, message) {
    const state = trackState(trackId);
    if (!state) return;
    state.abortedRequestCount++;
    if (selectedTrackId && selectedTrackId !== trackId) state.abortedAfterTrackSwitchCount++;
    state.lastError = { code: "REQUEST_ABORTED", message: String(message || "Subtitle request aborted.").slice(0, 200) };
  }

  function reportAbort(requestTrackId, message) {
    recordTrackAbort(requestTrackId, message);
    const expected = !!requestTrackId && !!selectedTrackId && requestTrackId !== selectedTrackId;
    if (expected) console.info("[SubTwin][Netflix] subtitle request aborted during track switch");
    sendDiagnostics();
  }

  function reportCaptureError(error, requestTrackId) {
    if (error?.name === "AbortError") {
      reportAbort(requestTrackId, error.message);
      return;
    }
    send({ type: "error", code: "NETFLIX_SUBTITLE_REQUEST_NOT_FOUND", message: String(error?.message || error) });
  }

  function redactUrl(value) {
    try {
      const url = new URL(String(value), location.origin);
      return `${url.origin}${url.pathname}${url.search ? "?REDACTED" : ""}`;
    } catch (_) { return "[unavailable]"; }
  }

  function sanitizeMetadata(value, key = "", depth = 0) {
    const normalizedKey = String(key).toLowerCase();
    if (/(token|signature|cookie|authorization|password|account|email|user.?id|profile.?id)/i.test(normalizedKey)) return "[REDACTED]";
    if (/(url|uri|downloadable|resource|segment|cdn|manifest)/i.test(normalizedKey) && typeof value === "string" && /[/?#]/.test(value)) return redactUrl(value);
    if (value == null || ["string", "number", "boolean"].includes(typeof value)) {
      if (typeof value === "string" && /^https?:/i.test(value)) return redactUrl(value);
      return typeof value === "string" ? value.slice(0, 300) : value;
    }
    if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : "[object]";
    if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeMetadata(item, key, depth + 1));
    if (typeof value !== "object") return `[${typeof value}]`;
    const result = {};
    for (const childKey of Object.keys(value).slice(0, 80)) {
      if (/(cookie|authorization|password|account|email|user.?id|profile.?id)/i.test(childKey)) continue;
      try { result[childKey] = sanitizeMetadata(value[childKey], childKey, depth + 1); }
      catch (_) { result[childKey] = "[unavailable]"; }
    }
    return result;
  }

  function trackIdOf(track, index = 0) {
    return String(track?.trackId || track?.id || track?.languageCode || track?.language || `track-${index}`);
  }

  function selectedTrackOf(player) {
    for (const method of ["getTimedTextTrack", "getTextTrack"]) {
      try {
        const track = player?.[method]?.();
        if (track) return trackIdOf(track);
      } catch (_) {}
    }
    return selectedTrackId;
  }

  function actualSelectedTrackOf(player) {
    for (const method of ["getTimedTextTrack", "getTextTrack"]) {
      try {
        const track = player?.[method]?.();
        if (track) return trackIdOf(track);
      } catch (_) {}
    }
    return null;
  }

  function actualSelectedTrackObjectOf(player) {
    for (const method of ["getTimedTextTrack", "getTextTrack"]) {
      try {
        const track = player?.[method]?.();
        if (track) return track;
      } catch (_) {}
    }
    return null;
  }

  function isNoneSelected(player, selectedId = actualSelectedTrackOf(player)) {
    const selectedObject = actualSelectedTrackObjectOf(player);
    if (selectedObject && isOffTrack(selectedObject)) return true;
    const listed = allNativeTracks.find((track, index) => trackIdOf(track, index) === selectedId);
    if (listed) return isOffTrack(listed);
    return /(?:^|[;:])NONE(?:[;:]|$)|^(none|off|disabled)$/i.test(String(selectedId || ""));
  }

  function observeSelection(trackId, player, state) {
    const observedId = actualSelectedTrackOf(player);
    state.observedSelectedTrackId = observedId;
    if (observedId === trackId) {
      state.selectionObservedAt ||= new Date().toISOString();
      state.selectedTrackMatchedRequested = true;
      state.selectionOutcome = "applied";
      return "applied";
    }
    if (isNoneSelected(player, observedId)) {
      state.selectedTrackMatchedRequested = false;
      if (state.selectionObservedAt) {
        state.selectionChangedToNone = true;
        state.selectionOutcome = "reverted-to-none";
        return "reverted-to-none";
      }
      state.selectionOutcome = "none-without-applying";
      return "none-without-applying";
    }
    if (observedId) {
      state.selectionOutcome = "other-track-selected";
      return "other-track-selected";
    }
    return "unobserved";
  }

  function monitorSelection(trackId, player, state) {
    clearInterval(selectionMonitors.get(trackId));
    const startedAt = Date.now();
    const timer = setInterval(() => {
      if (selectedTrackId !== trackId || Date.now() - startedAt >= 1800) {
        clearInterval(timer);
        selectionMonitors.delete(trackId);
        if (selectedTrackId === trackId && !state.selectionObservedAt && state.selectionOutcome === "none-without-applying") {
          state.selectionChangedToNone = false;
        }
        sendDiagnostics();
        return;
      }
      const previousId = state.observedSelectedTrackId;
      const previousOutcome = state.selectionOutcome;
      const outcome = observeSelection(trackId, player, state);
      if (outcome === "reverted-to-none") {
        clearInterval(timer);
        selectionMonitors.delete(trackId);
        sendDiagnostics();
        return;
      }
      if (previousId !== state.observedSelectedTrackId || previousOutcome !== state.selectionOutcome) sendDiagnostics();
    }, 100);
    selectionMonitors.set(trackId, timer);
  }

  function captureRequestTrack() {
    const context = getPlayerContext();
    if (activeTrackId) return { trackId: activeTrackId, sessionKey: context?.sessionId == null ? lastSessionId : String(context.sessionId) };
    if (!context) return { trackId: null, sessionKey: lastSessionId == null ? null : String(lastSessionId) };
    const selectedObject = actualSelectedTrackObjectOf(context.player);
    const selected = selectedObject ? trackIdOf(selectedObject) : actualSelectedTrackOf(context.player);
    return { trackId: selected && selectedObject && !isOffTrack(selectedObject) ? selected : null, sessionKey: String(context.sessionId) };
  }

  function sendDiagnostics(requestId = null) {
    const context = getPlayerContext();
    send({
      type: "diagnostics",
      requestId,
      playerFound: !!context,
      trackApi,
      selectedTrack: context ? actualSelectedTrackOf(context.player) : null,
      requestedTrack: selectedTrackId,
      bridgeInstalledAt,
      playerReadyAt,
      earlySubtitleRequestsCaptured: diagnostics.earlySubtitleRequestsCaptured,
      earlySubtitleResponsesCaptured: diagnostics.earlySubtitleResponsesCaptured,
      rawResponseCacheHits: diagnostics.rawResponseCacheHits,
      rawResponseCacheEntries: [...responseCache.values()].reduce((sum, values) => sum + values.length, 0),
      rawResponseCacheBytes: responseCacheBytes,
      originalNativeTrackId: originalNativeTrack?.id ?? null,
      restoredNativeTrackId,
      nativeSuppressionActive: document.documentElement?.classList.contains("subtwin-netflix-native-caption-suppressed") === true,
      nativeCaptionFlashDetected: "MANUAL_ONLY",
      activeTrackLimit: "UNKNOWN",
      observedTransports: ["window.fetch", "XMLHttpRequest"],
      unobservedTransports: ["MediaSource/binary pipelines", "requests initiated wholly inside workers or Netflix internal networking"],
      counters: { ...diagnostics },
      trackMetadata: allNativeTracks.map((track, index) => {
        const detail = trackDebug(track, index);
        const state = detail.acquisition;
        const requestBaseline = state.requestsAtLastSelection || { fetch: diagnostics.observedFetchRequests, xhr: diagnostics.observedXHRRequests };
        return {
          ...detail,
          acquisition: {
            ...state,
            subtitleRequestsAfterSelection: Math.max(0, state.subtitleRequestCount - state.subtitleRequestsAtLastSelection),
            fetchRequestsAfterSelection: Math.max(0, diagnostics.observedFetchRequests - requestBaseline.fetch),
            xhrRequestsAfterSelection: Math.max(0, diagnostics.observedXHRRequests - requestBaseline.xhr)
          }
        };
      })
    });
  }

  function getPlayerContext() {
    try {
      const videoPlayer = window.netflix?.appContext?.state?.playerApp?.getAPI?.()?.videoPlayer;
      if (!videoPlayer) return null;
      const ids = videoPlayer.getAllPlayerSessionIds?.() || [];
      const sessionId = ids[0];
      if (sessionId == null) return null;
      const player = videoPlayer.getVideoPlayerBySessionId?.(sessionId);
      return player ? { videoPlayer, player, sessionId } : null;
    } catch (error) {
      send({ type: "error", code: "NETFLIX_PLAYER_NOT_FOUND", message: String(error) });
      return null;
    }
  }

  function readTracks(player) {
    let emptyResult = [];
    for (const method of ["getTimedTextTrackList", "getTextTrackList"]) {
      if (typeof player?.[method] !== "function") continue;
      try {
        const result = player[method]();
        const list = Array.isArray(result) ? result : (result?.tracks || result?.timedTextTrackList || []);
        if (Array.isArray(list) && list.length) {
          trackApi = method;
          return list;
        }
        if (Array.isArray(list)) emptyResult = list;
        trackApi ||= method;
      } catch (error) {
        trackApi ||= method;
        console.warn(`[SubTwin][Netflix] ${method} failed`, String(error));
      }
    }
    return emptyResult;
  }

  function isOffTrack(track) {
    for (const key of ["isNone", "isNoneTrack", "isOff", "isOffTrack", "isDisabled", "none", "off"]) {
      if (track[key] === true || track[key] === 1 || String(track[key]).toLowerCase() === "true") return true;
    }
    const type = String(track.trackType || track.type || "").trim().toLowerCase();
    if (["none", "off", "disabled", "no-subtitles"].includes(type)) return true;
    const id = String(track.trackId || track.id || "").trim().toLowerCase();
    if (/^(none|off|disabled)$/.test(id)) return true;
    const label = String(track.displayName || track.label || track.name || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
    return /^(off|none|disabled|deaktiviert|aus|desactivee?|desactivado|desativado|disattivato|uit|オフ|字幕オフ|關閉|关闭|關|关闭字幕|끔|자막 끔)$/.test(label);
  }

  function discoverTracks(force = false) {
    const context = getPlayerContext();
    if (!context) {
      send({ type: "player", ready: false });
      return false;
    }
    const { player, sessionId } = context;
    if (sessionId !== lastSessionId) {
      const hadSession = lastSessionId !== null;
      lastSessionId = sessionId;
      if (hadSession) {
        clearResponseCache();
        for (const timer of selectionMonitors.values()) clearInterval(timer);
        selectionMonitors.clear();
        trackDiagnostics.clear();
        originalNativeTrack = null;
        restoredNativeTrackId = null;
        diagnostics.lastSubtitleTrackId = null;
        activeTrackId = null;
        selectedTrackId = null;
      } else {
        for (const entries of responseCache.values()) for (const entry of entries) if (entry.sessionKey == null) entry.sessionKey = String(sessionId);
      }
      playerReadyAt ||= new Date().toISOString();
      activeTrackId = null;
      selectedTrackId = null;
      trackApi = null;
      lastTrackSignature = "";
      send({ type: "session", sessionId: String(sessionId) });
      send({ type: "player", ready: true, sessionId: String(sessionId) });
    }
    try {
      const rawTracks = readTracks(player);
      allNativeTracks = rawTracks.filter(Boolean);
      nativeTracks = allNativeTracks.filter((track) => !isOffTrack(track));
      const tracks = nativeTracks.map((track, index) => {
        const id = trackIdOf(track, index);
        const language = String(track.language || track.languageCode || track.bcp47 || "und");
        const baseLabel = String(track.displayName || track.label || track.name || track.language || `Subtitle ${index + 1}`);
        const classification = trackClassification(track);
        const label = displayLabel(track, baseLabel, classification);
        return { id, language, label, debug: { classification, summary: metadataSummary(track), metadata: sanitizeMetadata(track) } };
      });
      const signature = JSON.stringify(tracks.map(({ id, language, label, debug }) => ({ id, language, label, classification: debug.classification })));
      const changed = signature !== lastTrackSignature;
      if (changed || force) {
        lastTrackSignature = signature;
        send({ type: "tracks", sessionId: String(sessionId), tracks });
        if (changed && tracks.length) console.info(`[SubTwin][Netflix] ${tracks.length} subtitle tracks found`);
      }
      if (force) sendDiagnostics();
      return tracks.length > 0;
    } catch (error) {
      send({ type: "error", code: "NETFLIX_TRACKS_NOT_FOUND", message: String(error) });
      return false;
    }
  }

  async function applyTrackObject(context, track, trackId) {
    const { player, videoPlayer } = context;
    if (typeof player.setTimedTextTrack === "function") return player.setTimedTextTrack(track);
    if (typeof player.setTextTrack === "function") return player.setTextTrack(track);
    if (typeof player.setTimedTextTrackId === "function") return player.setTimedTextTrackId(trackId);
    if (typeof videoPlayer.setTimedTextTrack === "function") return videoPlayer.setTimedTextTrack(track);
    throw new Error("No supported timed text selection method is exposed by this player session.");
  }

  function getNativeTrackById(trackId) {
    return allNativeTracks.find((item, index) => trackIdOf(item, index) === trackId) || null;
  }

  const urlHint = (url) => /timed.?text|subtitle|caption|ttml|\.vtt|\.dfxp/i.test(String(url));
  const mimeHint = (contentType) => /text\/vtt|ttml|dfxp|(?:text|application)\/xml/i.test(String(contentType));
  const inspectableMime = (contentType) => /^(text\/|application\/(?:json|[^;]*\+json|xml|[^;]*\+xml))/i.test(String(contentType));
  function bodySignature(body) {
    const prefix = String(body || "").trimStart().slice(0, 4096);
    return /^WEBVTT\b/i.test(prefix)
      || /<(?:[\w.-]+:)?(?:tt|p)\b/i.test(prefix)
      || /"(?:timedText|timedtext|subtitle|textSegments|cues)"\s*:/i.test(prefix)
      || /"events"\s*:\s*\[[\s\S]{0,1000}"(?:tStartMs|dDurationMs|startMs|segs)"/i.test(prefix);
  }

  function sniffSubtitleFormat(body, contentType) {
    const prefix = String(body || "").trimStart().slice(0, 256);
    if (/^WEBVTT\b/i.test(prefix) || /text\/vtt/i.test(contentType || "")) return "WebVTT";
    if (/<(?:[\w.-]+:)?tt\b/i.test(prefix) || /ttml|dfxp/i.test(contentType || "")) return "TTML/DFXP";
    if (/^(?:\{|\[)/.test(prefix)) return "JSON timed text";
    if (/<(?:[\w.-]+:)?p\b/i.test(prefix)) return "XML timed text";
    return "unknown";
  }

  function trackIdForResource(url) {
    const target = String(url || "");
    const visit = (value, key = "", depth = 0, matches = new Set()) => {
      if (depth > 5 || value == null) return matches;
      if (typeof value === "string") {
        if (/(url|uri|resource|downloadable|segment|manifest)/i.test(key) && /^(?:https?:|\/\/)/i.test(value) && target.startsWith(value.split("?")[0])) matches.add("match");
        return matches;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, key, depth + 1, matches);
        return matches;
      }
      if (typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey, depth + 1, matches);
      }
      return matches;
    };
    const matchedIds = [];
    for (let index = 0; index < nativeTracks.length; index++) {
      if (visit(nativeTracks[index]).has("match")) matchedIds.push(trackIdOf(nativeTracks[index], index));
    }
    return matchedIds.length === 1 ? matchedIds[0] : null;
  }

  function inspectRequest(url, contentType, captured = {}) {
    let requestTrackId = captured.trackId || null;
    const metadataTrackId = trackIdForResource(url);
    if (metadataTrackId) requestTrackId = metadataTrackId;
    const metadataHint = !!metadataTrackId;
    const hinted = urlHint(url) || metadataHint;
    return { hinted, inspect: hinted || mimeHint(contentType) || (!!requestTrackId && inspectableMime(contentType)), requestTrackId, sessionKey: captured.sessionKey ?? lastSessionId };
  }

  function emitBody(url, body, contentType, request, transport) {
    const signature = bodySignature(body);
    // A URL/resource identified from track metadata or a URL hint is enough to
    // count an empty or malformed response as received. The adapter can then
    // report a parse failure instead of misreporting that no response arrived.
    if (!mimeHint(contentType) && !signature && !request.hinted) return;
    if (!request.countedAsSubtitle) {
      diagnostics.subtitleRequestsObserved++;
      diagnostics.earlySubtitleRequestsCaptured++;
      recordTrackRequest(request.requestTrackId);
    }
    request.countedAsSubtitle = true;
    diagnostics.subtitleResponsesObserved++;
    diagnostics.lastSubtitleUrl = redactUrl(url);
    diagnostics.lastSubtitleContentType = String(contentType || "") || null;
    diagnostics.lastSubtitleTransport = transport;
    diagnostics.lastSubtitleTrackId = request.requestTrackId || null;
    recordTrackResponse(request.requestTrackId, transport);
    if (request.requestTrackId) cacheSubtitleResponse(request.requestTrackId, String(body || ""), sniffSubtitleFormat(body, contentType), contentType, request.sessionKey, transport);
    send({
      type: "subtitle",
      trackId: request.requestTrackId,
      sessionId: request.sessionKey == null ? null : String(request.sessionKey),
      url: diagnostics.lastSubtitleUrl,
      contentType: diagnostics.lastSubtitleContentType,
      transport,
      body
    });
    sendDiagnostics();
  }

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const input = args[0];
    const url = typeof input === "string" ? input : input?.url;
    diagnostics.observedFetchRequests++;
    const request = inspectRequest(url, "", captureRequestTrack());
    if (request.hinted) {
      diagnostics.subtitleRequestsObserved++;
      diagnostics.earlySubtitleRequestsCaptured++;
      request.countedAsSubtitle = true;
    }
    if (request.requestTrackId && request.hinted) recordTrackRequest(request.requestTrackId);
    const promise = originalFetch.apply(this, args);
    return promise.then((response) => {
      const type = response.headers.get("content-type") || "";
      if (!request.inspect && !mimeHint(type) && !(request.requestTrackId && inspectableMime(type))) return response;
      const responseRequest = { ...request, hinted: request.hinted || mimeHint(type) };
      response.clone().text().then((body) => emitBody(url, body, type, responseRequest, "fetch")).catch((error) => reportCaptureError(error, request.requestTrackId));
      return response;
    }, (error) => {
      if (error?.name === "AbortError") {
        reportAbort(request.requestTrackId, error.message);
      }
      throw error;
    });
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__dualSubtitleUrl = url;
    return xhrOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    diagnostics.observedXHRRequests++;
    const request = inspectRequest(this.__dualSubtitleUrl, "", captureRequestTrack());
    if (request.hinted) {
      diagnostics.subtitleRequestsObserved++;
      diagnostics.earlySubtitleRequestsCaptured++;
      request.countedAsSubtitle = true;
    }
    if (request.requestTrackId && request.hinted) recordTrackRequest(request.requestTrackId);
    this.addEventListener("abort", () => {
      reportAbort(request.requestTrackId, "XMLHttpRequest aborted.");
    }, { once: true });
    this.addEventListener("load", () => {
      try {
        const type = this.getResponseHeader("content-type") || "";
        if (!request.inspect && !mimeHint(type) && !(request.requestTrackId && inspectableMime(type))) return;
        const responseRequest = { ...request, hinted: request.hinted || mimeHint(type) };
        if (this.responseType === "blob" && this.response?.text) {
          this.response.text().then((body) => emitBody(this.__dualSubtitleUrl, body, type, responseRequest, "xhr")).catch((error) => reportCaptureError(error, request.requestTrackId));
          return;
        }
        const body = this.responseType === "arraybuffer" && this.response
          ? new TextDecoder().decode(this.response)
          : this.responseType === "json"
            ? JSON.stringify(this.response)
            : this.responseText;
        emitBody(this.__dualSubtitleUrl, body, type, responseRequest, "xhr");
      } catch (error) {
        reportCaptureError(error, request.requestTrackId);
      }
    }, { once: true });
    return xhrSend.apply(this, args);
  };

  window.addEventListener("message", async (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "DUALSUB_NFLX_CONTENT") return;
    if (event.data.type === "adapterReady") return;
    if (event.data.type === "getTracks") discoverTracks(true);
    if (event.data.type === "getDiagnostics") sendDiagnostics(event.data.requestId || null);
    if (event.data.type === "getCachedSubtitleResponses") {
      const trackId = String(event.data.trackId || "");
      send({ type: "cachedSubtitleResponses", requestId: event.data.requestId || null, trackId, sessionId: lastSessionId == null ? null : String(lastSessionId), entries: cachedResponsesFor(trackId) });
    }
    if (event.data.type === "beginTrackAcquisition") {
      const context = getPlayerContext();
      let selectedObject = context ? actualSelectedTrackObjectOf(context.player) : null;
      let id = selectedObject ? trackIdOf(selectedObject) : context ? actualSelectedTrackOf(context.player) : null;
      if (!selectedObject && context && isNoneSelected(context.player, id)) selectedObject = allNativeTracks.find((track) => isOffTrack(track)) || null;
      if (!id && selectedObject) id = trackIdOf(selectedObject);
      originalNativeTrack = { id: id || null, object: selectedObject || getNativeTrackById(id), sessionId: context?.sessionId == null ? lastSessionId : String(context.sessionId) };
      restoredNativeTrackId = null;
      send({ type: "nativeTrackSnapshot", requestId: event.data.requestId || null, trackId: originalNativeTrack.id });
      sendDiagnostics();
    }
    if (event.data.type === "restoreNativeTrack") {
      const requestId = event.data.requestId || null;
      const context = getPlayerContext();
      const snapshot = originalNativeTrack;
      if (!context || !snapshot || (snapshot.sessionId != null && String(context.sessionId) !== String(snapshot.sessionId))) {
        send({ type: "nativeTrackRestored", requestId, ok: false, trackId: snapshot?.id || null, message: "Original Netflix track snapshot is unavailable for this player session." });
      } else {
        try {
          const track = snapshot.object || getNativeTrackById(snapshot.id);
          if (track) await applyTrackObject(context, track, snapshot.id);
          else if (snapshot.id == null && typeof context.player.setTimedTextTrack === "function") await context.player.setTimedTextTrack(null);
          else throw new Error("Original selected track is not present in the current session track list.");
          await new Promise((resolve) => setTimeout(resolve, 50));
          restoredNativeTrackId = actualSelectedTrackOf(context.player) || snapshot.id || null;
          activeTrackId = null;
          selectedTrackId = restoredNativeTrackId;
          send({ type: "nativeTrackRestored", requestId, ok: true, trackId: restoredNativeTrackId });
          console.info(`[SubTwin][Netflix] restored native track=${restoredNativeTrackId || "NONE"}`);
        } catch (error) {
          send({ type: "nativeTrackRestored", requestId, ok: false, trackId: snapshot.id, message: String(error?.message || error) });
        }
        sendDiagnostics();
      }
    }
    if (event.data.type === "selectTrack") {
      const trackId = String(event.data.trackId || "");
      const requestId = String(event.data.requestId || "");
      const candidate = nativeTracks.find((item, index) => String(item.trackId || item.id || item.languageCode || item.language || `track-${index}`) === trackId);
      if (!candidate) {
        send({ type: "error", code: "NETFLIX_TRACKS_NOT_FOUND", message: `Unknown track id: ${trackId}` });
        send({ type: "selectionResult", requestId, ok: false, requestedTrackId: trackId, message: "Unknown track id." });
        return;
      }
      const context = getPlayerContext();
      if (!context) {
        send({ type: "error", code: "NETFLIX_PLAYER_NOT_FOUND", message: "Player session is not available." });
        send({ type: "selectionResult", requestId, ok: false, requestedTrackId: trackId, message: "Player session is not available." });
        return;
      }
      activeTrackId = trackId;
      selectedTrackId = trackId;
      const state = trackState(trackId);
      state.trackSelectionCount++;
      state.selectedSuccessfully = false;
      state.selectionRequestedAt = new Date().toISOString();
      state.selectionObservedAt = null;
      state.requestedTrackId = trackId;
      state.observedSelectedTrackId = actualSelectedTrackOf(context.player);
      state.selectionSetterResolved = false;
      state.selectedTrackMatchedRequested = null;
      state.selectionChangedToNone = null;
      state.selectionOutcome = "requested";
      state.requestsAtLastSelection = { fetch: diagnostics.observedFetchRequests, xhr: diagnostics.observedXHRRequests };
      state.subtitleRequestsAtLastSelection = state.subtitleRequestCount;
      const { player, videoPlayer } = context;
      try {
        const selectionApi = typeof player.setTimedTextTrack === "function" ? "setTimedTextTrack"
          : typeof player.setTextTrack === "function" ? "setTextTrack"
            : typeof player.setTimedTextTrackId === "function" ? "setTimedTextTrackId"
              : "videoPlayer.setTimedTextTrack";
        await Promise.resolve(applyTrackObject(context, candidate, trackId));
        await new Promise((resolve) => setTimeout(resolve, 50));
        state.selectionSetterResolved = true;
        diagnostics.trackSelectionCalls++;
        state.selectionSucceededCount++;
        state.selectedSuccessfully = true;
        const actualSelected = actualSelectedTrackOf(player);
        observeSelection(trackId, player, state);
        monitorSelection(trackId, player, state);
        if (actualSelected && !diagnostics.distinctSelectedTracksObserved.includes(actualSelected)) diagnostics.distinctSelectedTracksObserved.push(actualSelected);
        send({ type: "selectionResult", requestId, ok: true, requestedTrackId: trackId, selectedTrackId: actualSelected, selectionApi, selectionRequestedAt: state.selectionRequestedAt, selectionObservedAt: state.selectionObservedAt, selectionSetterResolved: state.selectionSetterResolved, selectedTrackMatchedRequested: state.selectedTrackMatchedRequested, selectionOutcome: state.selectionOutcome });
        console.info(`[SubTwin][Netflix] selected track=${actualSelected || trackId}; api=${selectionApi}`);
        sendDiagnostics();
      } catch (error) {
        if (error?.name === "AbortError") {
          console.info("[SubTwin][Netflix] subtitle request aborted during track switch");
          send({ type: "selectionResult", requestId, ok: false, requestedTrackId: trackId, message: "Subtitle request aborted during track switch.", expectedAbort: true });
          return;
        }
        state.lastError = { code: "NETFLIX_TRACKS_NOT_FOUND", message: String(error?.message || error).slice(0, 200) };
        send({ type: "error", code: "NETFLIX_TRACKS_NOT_FOUND", message: String(error) });
        send({ type: "selectionResult", requestId, ok: false, requestedTrackId: trackId, message: String(error) });
      }
    }
  });

  const observer = new MutationObserver(() => {
    if (discoverTimer) return;
    discoverTimer = setTimeout(() => { discoverTimer = 0; discoverTracks(); }, 300);
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });
  const poll = setInterval(() => {
    if (discoverTracks()) clearInterval(poll);
  }, 1000);
  discoverTracks();
})();
