(() => {
  if (window.__dualSubtitleYTBridge) return;
  window.__dualSubtitleYTBridge = true;
  const SOURCE = "DUALSUB_YT";
  let latest = null;
  const send = (data) => window.postMessage({ ...data, source: SOURCE }, location.origin);
  const text = (value) => typeof value === "string" ? value : JSON.stringify(value);
  const isTimedText = (url) => /timedtext/i.test(String(url));
  const inspect = () => {
    const player = document.getElementById("movie_player");
    let response;
    try { response = player?.getPlayerResponse?.() || window.ytInitialPlayerResponse || window.ytplayer?.config?.args?.raw_player_response; } catch (_) {}
    const raw = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!raw?.length) return false;
    latest = raw;
    send({ type: "tracks", tracks: raw.map((track) => ({
      ...track,
      id: track.vssId || track.languageCode,
      language: track.languageCode,
      label: track.name?.simpleText || track.name?.runs?.map((run) => run.text).join("") || track.languageCode,
      kind: track.kind || "manual",
      vssId: track.vssId,
      baseUrl: track.baseUrl
    })) });
    return true;
  };

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;
    const promise = originalFetch.apply(this, args);
    if (isTimedText(url)) promise.then((response) => response.clone().text().then((body) => {
      const parsed = new URL(url, location.href);
      send({ type: "caption", language: parsed.searchParams.get("lang"), vssId: parsed.searchParams.get("vssId"), kind: parsed.searchParams.get("kind"), body });
    }).catch(() => {})).catch(() => {});
    return promise;
  };
  const xhrOpen = XMLHttpRequest.prototype.open;
  const xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) { this.__dualSubtitleUrl = url; return xhrOpen.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function (...args) {
    if (isTimedText(this.__dualSubtitleUrl)) this.addEventListener("load", () => {
      try {
        const parsed = new URL(this.__dualSubtitleUrl, location.href);
        send({ type: "caption", language: parsed.searchParams.get("lang"), vssId: parsed.searchParams.get("vssId"), kind: parsed.searchParams.get("kind"), body: this.responseText });
      } catch (_) {}
    }, { once: true });
    return xhrSend.apply(this, args);
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "DUALSUB_YT_CONTENT") return;
    if (event.data.type === "getTracks") inspect();
    if (event.data.type === "selectTrack") {
      const track = event.data.track;
      try {
        const player = document.getElementById("movie_player");
        player?.setOption?.("captions", "track", track);
        player?.setOption?.("captions", "reload", true);
      } catch (error) { send({ type: "error", code: "TRACK_FETCH_FAILED", message: String(error) }); }
    }
    if (event.data.type === "snapshotNativeTrack") {
      try {
        const player = document.getElementById("movie_player");
        const track = player?.getOption?.("captions", "track") ?? null;
        send({ type: "nativeTrackSnapshot", requestId: event.data.requestId, ok: true, track });
      } catch (error) {
        send({ type: "nativeTrackSnapshot", requestId: event.data.requestId, ok: false, message: String(error?.message || error) });
      }
    }
    if (event.data.type === "restoreNativeTrack") {
      try {
        const player = document.getElementById("movie_player");
        if (!player?.setOption) throw new Error("YouTube player caption options are unavailable.");
        player.setOption("captions", "track", event.data.track ?? null);
        player.setOption("captions", "reload", true);
        send({ type: "nativeTrackRestored", requestId: event.data.requestId, ok: true, track: event.data.track ?? null });
      } catch (error) {
        send({ type: "nativeTrackRestored", requestId: event.data.requestId, ok: false, message: String(error?.message || error) });
      }
    }
  });
  const observer = new MutationObserver(() => { if (!latest) inspect(); });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  const poll = setInterval(() => { inspect(); if (latest) clearInterval(poll); }, 500);
  window.addEventListener("yt-navigate-finish", () => { latest = null; setTimeout(inspect, 500); });
})();
