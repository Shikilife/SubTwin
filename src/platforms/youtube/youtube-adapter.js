(function (root) {
  class YouTubeAdapter {
    constructor() {
      this.tracks = [];
      this.responses = new Map();
      this.pending = new Map();
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
          const resolve = this.pending.get(track.id);
          if (resolve) { clearTimeout(resolve.timer); resolve.resolve(cues); this.pending.delete(track.id); }
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
    async getCues(trackId) {
      if (this.responses.has(trackId)) return this.responses.get(trackId);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.pending.delete(trackId); reject(new Error("TRACK_FETCH_FAILED: no player subtitle response captured for " + trackId)); }, 15000);
        this.pending.set(trackId, { resolve, timer });
      });
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      window.removeEventListener("message", this.messageHandler);
      for (const [trackId, pending] of this.pending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("PLAYER_NOT_READY: YouTube adapter was disposed."));
        this.pending.delete(trackId);
      }
      this.tracks = [];
      this.responses.clear();
    }
  }
  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.YouTubeAdapter = YouTubeAdapter;
})(globalThis);
