(function (root) {
  class SubtitleEngine {
    constructor(adapter, logger) {
      this.adapter = adapter;
      this.logger = logger;
      this.tracks = [];
      this.cues = new Map();
      this.primaryId = null;
      this.secondaryId = null;
      this.lastPair = "";
      this.timer = null;
    }

    async initialize() {
      this.tracks = await this.adapter.getAvailableTracks();
      this.logger.tracks(this.tracks);
      if (!this.tracks.length) throw new Error("NO_SUBTITLE_TRACKS");
      if (this.tracks.length === 1) this.logger.warn("ONLY_ONE_TRACK: only one existing subtitle track is available.");
      this.primaryId = null;
      this.secondaryId = null;
      this.startSync();
      return this.tracks;
    }

    async select(primaryId, secondaryId) {
      const primary = this.tracks.find((track) => track.id === String(primaryId));
      const secondary = secondaryId == null ? null : this.tracks.find((track) => track.id === String(secondaryId));
      if (!primary) throw new Error("Primary track id not found. Run dualSubtitle.listTracks().");
      if (secondaryId != null && !secondary) throw new Error("Secondary track id not found. Run dualSubtitle.listTracks().");
      this.primaryId = primary.id;
      this.secondaryId = secondary ? secondary.id : null;
      this.lastPair = "";
      if (typeof this.adapter.selectTracks === "function") {
        this.logger.selection(primary, secondary);
        const loaded = await this.adapter.selectTracks(primary.id, secondary?.id || null);
        if (loaded?.primary) this.cues.set(primary.id, loaded.primary);
        if (secondary && loaded?.secondary) this.cues.set(secondary.id, loaded.secondary);
        this.printCurrent(true);
        return;
      }
      await this.adapter.selectTrack(primary.id);
      this.logger.selection(primary, secondary);
      await this.load(primary.id);
      if (secondary) {
        await this.adapter.selectTrack(secondary.id);
        await this.load(secondary.id);
      }
      this.printCurrent(true);
    }

    async load(trackId) {
      if (!trackId || this.cues.has(trackId)) return this.cues.get(trackId) || [];
      try {
        const cues = await this.adapter.getCues(trackId);
        this.cues.set(trackId, cues);
        return cues;
      } catch (error) {
        this.logger.error("TRACK_FETCH_FAILED", error);
        throw error;
      }
    }

    startSync() {
      if (this.timer) clearInterval(this.timer);
      this.timer = setInterval(() => this.printCurrent(false), 250);
    }

    destroy() {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.adapter.destroy?.();
    }

    getSnapshot() {
      const video = document.querySelector("video");
      if (!video) return { videoTime: null, primaryCue: null, secondaryCue: null };
      const primary = this.tracks.find((track) => track.id === this.primaryId);
      const secondary = this.tracks.find((track) => track.id === this.secondaryId);
      const primaryCues = primary ? (this.adapter.getCachedCues?.(primary.id) || this.cues.get(primary.id) || []) : [];
      const secondaryCues = secondary ? (this.adapter.getCachedCues?.(secondary.id) || this.cues.get(secondary.id) || []) : [];
      const timeMs = video.currentTime * 1000;
      return {
        videoTime: video.currentTime,
        primaryCue: primary ? root.DualSubtitle.timeSync.activeCue(primaryCues, timeMs) : null,
        secondaryCue: secondary ? root.DualSubtitle.timeSync.activeCue(secondaryCues, timeMs) : null
      };
    }

    printCurrent(force) {
      const video = document.querySelector("video");
      if (!video) return;
      const primary = this.tracks.find((track) => track.id === this.primaryId);
      const secondary = this.tracks.find((track) => track.id === this.secondaryId);
      if (!primary) return;
      const timeMs = video.currentTime * 1000;
      const primaryCues = this.adapter.getCachedCues?.(primary.id) || this.cues.get(primary.id) || [];
      const secondaryCues = secondary ? (this.adapter.getCachedCues?.(secondary.id) || this.cues.get(secondary.id) || []) : [];
      const first = root.DualSubtitle.timeSync.activeCue(primaryCues, timeMs);
      const second = secondary ? root.DualSubtitle.timeSync.activeCue(secondaryCues, timeMs) : null;
      const key = [primary.id, first && first.startMs, first && first.text, secondary && secondary.id, second && second.startMs, second && second.text].join("|");
      if (!force && key === this.lastPair) return;
      this.lastPair = key;
      if (!first && !second) return;
      this.logger.current(primary, first, secondary, second);
    }
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.SubtitleEngine = SubtitleEngine;
})(globalThis);
