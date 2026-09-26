(function (root) {
  const HOST_ID = "subtwin-overlay-host";
  const CSS_URL = "src/renderer/subtitle-renderer.css";

  class SubtitleRenderer {
    constructor() {
      this.host = null;
      this.root = null;
      this.primary = null;
      this.secondary = null;
      this.primaryText = null;
      this.secondaryText = null;
      this.container = null;
      this.patchedPosition = null;
      this.lastLoggedOpacity = null;
    }

    mount(container) {
      if (!container || !container.isConnected) return false;
      if (!this.host) {
        this.host = document.getElementById(HOST_ID);
        if (!this.host) {
          this.host = document.createElement("div");
          this.host.id = HOST_ID;
          this.host.setAttribute("aria-live", "off");
          this.root = this.host.attachShadow({ mode: "closed" });
          const link = document.createElement("link");
          link.rel = "stylesheet";
          link.href = chrome.runtime.getURL(CSS_URL);
          this.primary = document.createElement("div");
          this.primary.className = "line primary";
          this.primaryText = document.createElement("span");
          this.primaryText.className = "text";
          this.primary.append(this.primaryText);
          this.secondary = document.createElement("div");
          this.secondary.className = "line secondary";
          this.secondaryText = document.createElement("span");
          this.secondaryText.className = "text";
          this.secondary.append(this.secondaryText);
          this.root.append(link, this.primary, this.secondary);
        } else {
          this.root = this.host.shadowRoot;
          this.primary = this.root?.querySelector(".primary");
          this.secondary = this.root?.querySelector(".secondary");
          this.primaryText = this.primary?.querySelector(".text");
          this.secondaryText = this.secondary?.querySelector(".text");
        }
      }
      if (this.container !== container) {
        this.restoreContainerPosition();
        this.container = container;
        if (getComputedStyle(container).position === "static") {
          this.patchedPosition = { element: container, value: container.style.position };
          container.style.position = "relative";
        }
      }
      this.host.style.cssText = "position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:2147483000;";
      if (this.host.parentElement !== container) container.append(this.host);
      return true;
    }

    update(primaryCue, secondaryCue, settings) {
      if (!this.host || !this.primary || !this.secondary) return;
      const normalized = root.DualSubtitle.settings.normalize(settings);
      this.applySettings(normalized);
      this.setLine(this.primary, this.primaryText, primaryCue?.text || "");
      this.setLine(this.secondary, this.secondaryText, secondaryCue?.text || "");
      const visible = normalized.enabled && (!!primaryCue || !!secondaryCue);
      this.host.hidden = !visible;
      if (!visible) return;

      this.primary.style.maxWidth = this.secondary.style.maxWidth = `min(${normalized.maxWidth}%, calc(100% - 24px))`;
      const playerWidth = this.host.clientWidth || this.container?.clientWidth || 640;
      this.primary.style.fontSize = `clamp(6px, ${playerWidth * 0.024 * normalized.primaryFontScale / 100}px, 64px)`;
      this.secondary.style.fontSize = `clamp(6px, ${playerWidth * 0.021 * normalized.secondaryFontScale / 100}px, 64px)`;
      this.host.style.setProperty("--primary-y", `${this.safeCenterY(this.primary, normalized.primaryY)}px`);
      this.host.style.setProperty("--secondary-y", `${this.safeCenterY(this.secondary, normalized.secondaryY)}px`);
    }

    applySettings(settings) {
      const alpha = settings.backgroundOpacity / 100;
      const value = String(alpha);
      this.host.style.setProperty("--subtwin-bg-opacity", value);
      this.primaryText?.style.setProperty("--subtwin-bg-opacity", value);
      this.secondaryText?.style.setProperty("--subtwin-bg-opacity", value);
      if (this.lastLoggedOpacity !== settings.backgroundOpacity) {
        this.lastLoggedOpacity = settings.backgroundOpacity;
        const primaryBackground = this.primaryText ? getComputedStyle(this.primaryText).backgroundColor : "unavailable";
        console.debug("[SubTwin][Renderer] backgroundOpacity", settings.backgroundOpacity, "alpha", alpha, "computed background", primaryBackground);
      }
    }

    safeCenterY(element, percentage) {
      const height = this.host.clientHeight || this.container?.clientHeight || 0;
      if (!height) return 0;
      const halfBlock = element.hidden ? 0 : element.getBoundingClientRect().height / 2;
      const safeInset = Math.min(halfBlock + 8, height / 2);
      const requested = height * percentage / 100;
      return Math.round(Math.max(safeInset, Math.min(height - safeInset, requested)));
    }

    setLine(element, textElement, text) {
      if (!element || !textElement) return;
      if (textElement.textContent !== text) textElement.textContent = text;
      element.hidden = !text;
    }

    clear() {
      this.update(null, null, { enabled: false });
    }

    restoreContainerPosition() {
      if (this.patchedPosition && this.patchedPosition.element.isConnected) {
        this.patchedPosition.element.style.position = this.patchedPosition.value;
      }
      this.patchedPosition = null;
    }

    destroy() {
      this.host?.remove();
      this.restoreContainerPosition();
      this.host = this.root = this.primary = this.secondary = this.primaryText = this.secondaryText = this.container = null;
    }
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.SubtitleRenderer = SubtitleRenderer;
})(globalThis);
