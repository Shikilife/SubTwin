(() => {
  if (window.__subTwinDebugBridgeInstalled) return;
  window.__subTwinDebugBridgeInstalled = true;

  if ("dualSubtitle" in window) {
    console.warn("[DualSubtitle] window.dualSubtitle already exists; SubTwin debug API was not installed to avoid replacing it.");
    return;
  }

  const pending = new Map();
  let sequence = 0;
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || event.origin !== location.origin || !message || message.namespace !== "SUBTWIN_DEBUG_RESPONSE") return;
    if (typeof message.requestId !== "string") return;
    const entry = pending.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.requestId);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "SubTwin debug request failed."));
  });

  function request(type, args) {
    const requestId = `${Date.now().toString(36)}-${(++sequence).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error("SubTwin content script did not respond. Reload the extension and this page, then try again."));
      }, type === "SELECT_TRACKS" ? 50000 : type === "TEST_NETFLIX_TRACK_BY_ID" ? 12000 : 5000);
      pending.set(requestId, { resolve, reject, timer });
      window.postMessage({
        namespace: "SUBTWIN_DEBUG_REQUEST",
        type,
        requestId,
        ...(args ? { args } : {})
      }, location.origin);
    });
  }

  const api = Object.freeze({
    status: () => request("GET_STATUS"),
    listTracks: () => request("LIST_TRACKS"),
    netflixDebug: () => request("GET_NETFLIX_DEBUG"),
    netflixTracksDebug: async () => {
      const diagnostics = await request("GET_NETFLIX_DEBUG");
      return diagnostics.trackMetadata || [];
    },
    testTrackById: function (trackId) {
      if (typeof trackId !== "string" || !trackId || trackId.length > 256) {
        return Promise.reject(new TypeError("Use dualSubtitle.testTrackById(currentTrackId)."));
      }
      return request("TEST_NETFLIX_TRACK_BY_ID", [trackId]);
    },
    select: function (primaryIdOrIndex, secondaryIdOrIndex) {
      if (arguments.length < 1 || arguments.length > 2) return Promise.reject(new TypeError("Use dualSubtitle.select(primary[, secondary])."));
      const args = arguments.length === 1 || secondaryIdOrIndex == null
        ? [primaryIdOrIndex]
        : [primaryIdOrIndex, secondaryIdOrIndex];
      return request("SELECT_TRACKS", args);
    },
    selectById: function (primaryId, secondaryId) {
      if (typeof primaryId !== "string" || !primaryId || (arguments.length > 1 && secondaryId != null && typeof secondaryId !== "string")) {
        return Promise.reject(new TypeError("Use dualSubtitle.selectById(primaryTrackId[, secondaryTrackId])."));
      }
      const args = arguments.length === 1 || secondaryId == null ? [primaryId] : [primaryId, secondaryId];
      return request("SELECT_TRACKS", args);
    }
  });

  Object.defineProperty(window, "dualSubtitle", {
    value: api,
    enumerable: true,
    configurable: true,
    writable: false
  });
  console.info("[DualSubtitle] Debug API ready. Use await dualSubtitle.status() or await dualSubtitle.listTracks().");
})();
