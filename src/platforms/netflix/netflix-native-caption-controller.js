(function (root) {
  // Netflix does not expose a public visual-caption API. These selectors are
  // isolated here and must be rechecked against the current player DOM.
  const SELECTORS = [".player-timedtext", ".player-timedtext-text-container"];
  const ROOT_CLASS = "subtwin-netflix-native-caption-suppressed";
  const BOOT_CLASS = "subtwin-netflix-native-caption-boot";

  function initializeEarlySuppression() {
    const doc = root.document;
    if (!doc) return;
    let savedEnabled = null;
    const apply = () => {
      const html = doc.documentElement;
      if (!html) return false;
      if (savedEnabled === null) html.classList.add(BOOT_CLASS);
      else {
        html.classList.toggle(ROOT_CLASS, savedEnabled);
        html.classList.remove(BOOT_CLASS);
      }
      return true;
    };
    if (!apply()) {
      const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
      observer.observe(doc, { childList: true, subtree: true });
    }
    // Keep first-render suppression until persisted settings have loaded.
    try {
      root.chrome?.storage?.local?.get("subTwinSettings", (result) => {
        savedEnabled = result?.subTwinSettings?.enabled === true;
        apply();
      });
    } catch (_) {
      savedEnabled = false;
      apply();
    }
  }

  initializeEarlySuppression();

  class NetflixNativeCaptionController {
    constructor(getContainer) {
      this.getContainer = getContainer;
      this.container = null;
      this.enabled = false;
      this.observer = null;
      this.originalVisibility = new Map();
      this.reapplyAfterDomChange = this.reapplyAfterDomChange.bind(this);
    }

    setEnabled(enabled, container = this.getContainer?.()) {
      this.enabled = enabled === true;
      document.documentElement?.classList.toggle(ROOT_CLASS, this.enabled);
      document.documentElement?.classList.remove(BOOT_CLASS);
      this.reapplyAfterDomChange(container);
    }

    get suppressionActive() {
      return document.documentElement?.classList.contains(ROOT_CLASS) === true;
    }

    hideNativeCaptions(container = this.getContainer?.()) {
      this.setEnabled(true, container);
    }

    showNativeCaptions() {
      this.setEnabled(false);
    }

    reapplyAfterDomChange(container = this.getContainer?.()) {
      if (container !== this.container) {
        this.observer?.disconnect();
        this.observer = null;
        this.restoreAll();
        this.container = container?.isConnected ? container : null;
      }
      if (!this.container?.isConnected) return;

      if (!this.enabled) {
        this.observer?.disconnect();
        this.observer = null;
        this.restoreAll();
        return;
      }
      if (!this.observer) {
        this.observer = new MutationObserver(this.reapplyAfterDomChange);
        this.observer.observe(this.container, { childList: true, subtree: true });
      }

      const current = new Set();
      for (const selector of SELECTORS) {
        if (this.container.matches?.(selector)) current.add(this.container);
        this.container.querySelectorAll(selector).forEach((node) => current.add(node));
      }

      for (const node of [...this.originalVisibility.keys()]) {
        if (!current.has(node) || !node.isConnected) this.restore(node);
      }
      for (const node of current) {
        if (!this.originalVisibility.has(node)) {
          this.originalVisibility.set(node, {
            value: node.style.getPropertyValue("visibility"),
            priority: node.style.getPropertyPriority("visibility")
          });
        }
        node.style.setProperty("visibility", "hidden", "important");
      }
    }

    restore(node) {
      const original = this.originalVisibility.get(node);
      if (!original) return;
      if (original.value) node.style.setProperty("visibility", original.value, original.priority);
      else node.style.removeProperty("visibility");
      this.originalVisibility.delete(node);
    }

    restoreAll() {
      for (const node of [...this.originalVisibility.keys()]) this.restore(node);
    }

    destroy() {
      this.enabled = false;
      document.documentElement?.classList.remove(ROOT_CLASS, BOOT_CLASS);
      this.observer?.disconnect();
      this.observer = null;
      this.restoreAll();
      this.container = null;
    }
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.NetflixNativeCaptionController = NetflixNativeCaptionController;
})(globalThis);
