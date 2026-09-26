(function (root) {
  class YouTubeAdapter {
    constructor() {
      this.tracks = [];
      this.responses = new Map();
      this.pending = new Map();
      this.bridgeRequests = new Map();
      this.destroyed = false;
      this.messageHandler = (event) => {
        if (event.source !== window || !event.data || event.data.source !== "DUALSUB_YT") return;
        const message = event.data;
        if (message.type === "tracks") {
          this.tracks = (message.tracks || []).map(root.DualSubtitle.types.normalizeTrack);
        } else if (message.type === "caption") {
          const track = this.matchTrack(message.language, message.vssId, message.kind);
          if (!track) return;
          const cues = root.DualSubtitle.types.parseCues(message.body);
          if (!cues.length) return;
          this.responses.set(track.id, cues);
          const pending = this.pending.get(track.id);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(track.id);
            if (typeof pending.resolve === "function") pending.resolve(cues);
          }
        } else if (message.type === "nativeTrackSnapshot" || message.type === "nativeTrackRestored") {
          const pending = this.bridgeRequests.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.bridgeRequests.delete(message.requestId);
          if (message.ok === false) pending.reject(new Error(message.message || "YouTube native caption track operation failed."));
          else pending.resolve(message.track ?? null);
        }
      };
      window.addEventListener("message", this.messageHandler);
      this.post({ type: "getTracks" });
    }
    post(data) { window.postMessage({ ...data, source: "DUALSUB_YT_CONTENT" }, location.origin); }
    getOverlayContainer() { return document.getElementById("movie_player"); }
    matchTrack(language, vssId, kind) {
      const lang = String(language || "").toLowerCase();
      const sameLanguage = this.tracks.filter((track) => track.language.toLowerCase() === lang || track.language.toLowerCase().startsWith(`${lang}-`) || lang.startsWith(`${track.language.toLowerCase()}-`));
      return this.tracks.find((track) => vssId && track.id === vssId)
        || (kind ? sameLanguage.find((track) => (track.native.kind || "") === kind) : null)
        || sameLanguage[0];
    }
    async getAvailableTracks() {
      for (let i = 0; i < 12 && !this.tracks.length && !this.destroyed; i++) {
        this.post({ type: "getTracks" });
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (this.destroyed) throw new Error("PLAYER_NOT_READY: YouTube adapter was disposed while waiting for caption tracks.");
      if (!document.querySelector("video")) throw new Error("NO_VIDEO");
      if (!this.tracks.length) throw new Error("PLAYER_NOT_READY: YouTube caption tracks are not available yet.");
      return this.tracks;
    }
    async selectTrack(trackId) {
      const track = this.tracks.find((item) => item.id === trackId);
      if (!track) throw new Error("TRACK_FETCH_FAILED: unknown track");
      this.post({ type: "selectTrack", track: track.native });
    }
    async requestBridge(type, track = undefined) {
      const requestId = `yt-${type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const response = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.bridgeRequests.delete(requestId);
          reject(new Error(`PLAYER_NOT_READY: YouTube bridge did not respond to ${type}.`));
        }, 1200);
        this.bridgeRequests.set(requestId, { resolve, reject, timer, requestId, purpose: type });
      });
      this.post({ type, requestId, ...(track !== undefined ? { track } : {}) });
      return response;
    }
    async snapshotNativeTrack() { return this.requestBridge("snapshotNativeTrack"); }
    async restoreNativeTrack(track) { return this.requestBridge("restoreNativeTrack", track); }
    getCachedCues(trackId) { return this.responses.get(trackId) || []; }
    async acquireCuesForExport(trackId) {
      const cached = this.getCachedCues(trackId);
      if (cached.length) return cached;
      await this.selectTrack(trackId);
      return this.getCues(trackId, 15000, "export");
    }
    async getCues(trackId, timeoutMs = 15000, purpose = "runtime") {
      if (this.responses.has(trackId)) return this.responses.get(trackId);
      const existing = this.pending.get(trackId);
      if (existing?.promise) return existing.promise;
      let resolveCue;
      let rejectCue;
      const promise = new Promise((resolve, reject) => { resolveCue = resolve; rejectCue = reject; });
      const entry = {
        resolve: resolveCue,
        reject: rejectCue,
        timer: null,
        trackId,
        purpose,
        promise
      };
      entry.timer = setTimeout(() => {
        if (this.pending.get(trackId) === entry) this.pending.delete(trackId);
        const code = purpose === "export" ? "EXPORT_TIMEOUT" : "TRACK_FETCH_FAILED";
        entry.reject(new Error(`${code}: no player subtitle response captured for ${trackId}.`));
      }, timeoutMs);
      this.pending.set(trackId, entry);
      return promise;
    }

    settlePendingMap(map, error) {
      if (!(map instanceof Map)) return;
      for (const entry of map.values()) {
        try { if (entry?.timer != null) clearTimeout(entry.timer); } catch (_) {}
        try { if (typeof entry?.reject === "function") entry.reject(error); } catch (_) {}
      }
      try { map.clear(); } catch (_) {}
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      try { window.removeEventListener("message", this.messageHandler); } catch (_) {}
      const error = new Error("PLAYER_NOT_READY: YouTube adapter was disposed.");
      this.settlePendingMap(this.pending, error);
      this.settlePendingMap(this.bridgeRequests, error);
      try { this.tracks = []; } catch (_) {}
      try { this.responses.clear(); } catch (_) {}
    }
  }
  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.YouTubeAdapter = YouTubeAdapter;
})(globalThis);
