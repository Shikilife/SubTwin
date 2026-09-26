(function (root) {
  const PLAYER_SELECTOR = "#movie_player";
  const HIDE_CLASS = "subtwin-hide-native-caption-text";

  class YouTubeNativeCaptionController {
    constructor() {
      this.enabled = false;
      this.player = null;
      this.timer = null;
      this.observer = new MutationObserver(() => {
        if (this.timer != null) return;
        this.timer = setTimeout(() => { this.timer = null; this.apply(); }, 200);
      });
      this.observer.observe(document.documentElement, { childList: true, subtree: true });
    }

    setEnabled(enabled) {
      this.enabled = enabled === true;
      this.apply();
    }

    apply() {
      const player = document.querySelector(PLAYER_SELECTOR);
      if (player === this.player && player?.classList.contains(HIDE_CLASS) === this.enabled) return;
      this.player = player;
      player?.classList.toggle(HIDE_CLASS, this.enabled);
    }

    destroy() {
      this.enabled = false;
      this.apply();
      this.observer.disconnect();
      if (this.timer != null) clearTimeout(this.timer);
    }
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.YouTubeNativeCaptionController = YouTubeNativeCaptionController;
})(globalThis);
