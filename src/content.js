(function () {
  const host = location.hostname;
  const platform = host === "www.youtube.com" ? "YouTube" : host === "www.netflix.com" ? "Netflix" : null;
  if (!platform) return;

  const logger = DualSubtitle.createLogger(platform);
  const Adapter = platform === "YouTube" ? DualSubtitle.YouTubeAdapter : DualSubtitle.NetflixAdapter;
  const { KEY, defaults, normalize, serializeForStorage, restoreFromStorage } = DualSubtitle.settings;
  const PLATFORM_TRACKS_KEY = `${KEY}.${platform.toLowerCase()}.tracks`;
  const TRACK_SETTING_KEYS = ["primaryTrackId", "secondaryTrackId", "primaryLanguage", "secondaryLanguage", "primaryVariantPreference", "secondaryVariantPreference"];
  const renderer = new DualSubtitle.SubtitleRenderer();
  const nativeCaptionController = platform === "YouTube"
    ? new DualSubtitle.YouTubeNativeCaptionController()
    : platform === "Netflix"
      ? new DualSubtitle.NetflixNativeCaptionController(() => engine?.adapter.getOverlayContainer?.())
      : null;
  let engine = null;
  let savedSettings = normalize(defaults);
  let activeSettings = normalize(defaults);
  let lastInitError = null;
  let lastNetflixDiagnostics = null;
  let initializing = false;
  let generation = 0;
  let nextInitAttemptAt = 0;
  let routeResetTimer = null;
  const youtubeStartup = {
    state: "IDLE",
    attempts: 0,
    lastReason: null,
    lastAt: null,
    currentVideoKey: null,
    playerFound: false,
    videoFound: false,
    tracksFound: false
  };
  let youtubeInitPromise = null;
  let youtubeRetryTimer = null;
  let youtubeRetryIndex = 0;
  let youtubeObserver = null;
  let youtubeObserverTimer = null;
  let youtubeEngineVideoKey = null;
  const youtubeRetryDelays = [250, 500, 1000, 1500, 2000];

  const settingsReady = chrome.storage.local.get([KEY, PLATFORM_TRACKS_KEY]).then((result) => {
    const stored = normalize(result[KEY] || defaults);
    const hasPlatformTracks = result[PLATFORM_TRACKS_KEY] && typeof result[PLATFORM_TRACKS_KEY] === "object";
    const legacyTracks = Object.fromEntries(TRACK_SETTING_KEYS.map((key) => [key, stored[key]]));
    const rawPlatformTracks = hasPlatformTracks ? result[PLATFORM_TRACKS_KEY] : legacyTracks;
    activeSettings = restoreFromStorage(platform.toLowerCase(), stored, rawPlatformTracks);
    savedSettings = normalize(activeSettings);
    const legacyContainsTrackPrefs = TRACK_SETTING_KEYS.some((key) => stored[key] != null);
    const hasLegacyNetflixIds = platform === "Netflix" && [result[KEY], hasPlatformTracks ? result[PLATFORM_TRACKS_KEY] : null].some((source) =>
      ["primaryTrackId", "secondaryTrackId"].some((key) => source && Object.hasOwn(source, key))
    );
    return (!hasPlatformTracks || legacyContainsTrackPrefs || hasLegacyNetflixIds)
      ? persistSettings(activeSettings).then((persisted) => {
        savedSettings = normalize(persisted);
        return activeSettings;
      })
      : activeSettings;
  }).catch((error) => {
    logger.error("ADAPTER_INIT_FAILED", error);
    return activeSettings;
  });

  function publicTrack(track) {
    if (!track) return null;
    const result = { id: track.id, language: track.language, label: track.label };
    if (platform === "Netflix") {
      const classification = track.native?.debug?.classification || {};
      result.variantPreference = trackVariantPreference(track);
      result.variantInfo = {
        trackType: classification.trackType ?? null,
        rawTrackType: classification.rawTrackType ?? null,
        isForced: classification.isForced ?? null,
        isForcedNarrative: classification.isForcedNarrative ?? null,
        isNone: classification.isNone ?? null,
        isOff: classification.isOff ?? null,
        selectable: classification.selectable ?? null,
        resourceCount: classification.resourceCount ?? null
      };
    }
    return result;
  }

  function splitSettingsForStorage(settings) {
    const serialized = serializeForStorage(platform.toLowerCase(), settings);
    return { shared: serialized.settings, platformTracks: serialized.tracks };
  }

  async function persistSettings(settings) {
    const separated = splitSettingsForStorage(settings);
    await chrome.storage.local.set({ [KEY]: separated.shared, [PLATFORM_TRACKS_KEY]: separated.platformTracks });
    return restoreFromStorage(platform.toLowerCase(), separated.shared, separated.platformTracks);
  }

  function publicStatus() {
    const tracks = engine?.tracks || [];
    const snapshot = engine?.getSnapshot() || { videoTime: null, primaryCue: null, secondaryCue: null };
    const primary = tracks.find((track) => track.id === engine?.primaryId) || null;
    const secondary = tracks.find((track) => track.id === engine?.secondaryId) || null;
    const primaryCues = primary ? (engine.adapter.getCachedCues?.(primary.id) || engine.cues.get(primary.id) || []) : [];
    const secondaryCues = secondary ? (engine.adapter.getCachedCues?.(secondary.id) || engine.cues.get(secondary.id) || []) : [];
    return {
      platform: platform.toLowerCase(),
      initialized: !!engine,
      trackCount: tracks.length,
      enabled: activeSettings.enabled,
      activeSettings: { ...activeSettings },
      savedSettings: { ...savedSettings },
      ...(platform === "Netflix" ? { lastInitError } : {}),
      ...(platform === "Netflix" ? { netflixDebug: engine?.adapter.getDiagnostics?.() || lastNetflixDiagnostics } : {}),
      adapterClass: engine?.adapter?.constructor?.name || Adapter.name,
      nativeCaptionController: nativeCaptionController?.constructor?.name || null,
      rendererAttached: renderer.host?.isConnected === true,
      ...(platform === "YouTube" ? {
        startupState: youtubeStartup.state,
        startupAttempts: youtubeStartup.attempts,
        lastStartupReason: youtubeStartup.lastReason,
        lastStartupAt: youtubeStartup.lastAt,
        currentVideoKey: youtubeStartup.currentVideoKey,
        playerFound: youtubeStartup.playerFound,
        videoFound: youtubeStartup.videoFound,
        tracksFound: youtubeStartup.tracksFound,
        initInFlight: !!youtubeInitPromise
      } : {}),
      primary: publicTrack(primary),
      secondary: publicTrack(secondary),
      cuesLoaded: { primary: primaryCues.length, secondary: secondaryCues.length },
      currentCues: { primary: snapshot.primaryCue, secondary: snapshot.secondaryCue },
      videoTime: snapshot.videoTime
    };
  }

  function resolveTrack(value) {
    if (!engine) return null;
    if (typeof value === "number") return Number.isInteger(value) && value >= 0 ? engine.tracks[value] || null : null;
    if (typeof value === "string" && value.length <= 256) return engine.tracks.find((track) => track.id === value) || null;
    return null;
  }

  function trackVariantPreference(track) {
    if (platform !== "Netflix" || !track) return null;
    const debug = track.native?.debug || {};
    const classification = debug.classification || {};
    const summary = debug.summary || {};
    const keys = ["trackType", "rawTrackType", "isForcedNarrative", "isForced", "isSDH", "isCC", "isDubbed", "isOriginal"];
    const fingerprint = Object.fromEntries(keys.filter((key) => classification[key] != null).map((key) => [key, classification[key]]));
    if (summary.profile != null) fingerprint.profile = summary.profile;
    return Object.keys(fingerprint).length ? JSON.stringify(fingerprint).slice(0, 500) : null;
  }

  function preferredTrack(id, language, excludedId, strict = false, variantPreference = null) {
    const tracks = engine?.tracks || [];
    const exact = tracks.find((track) => track.id === id && track.id !== excludedId);
    if (exact) return exact;
    const byLanguage = tracks.filter((track) => track.language === language && track.id !== excludedId);
    if (!strict) return byLanguage[0] || tracks.find((track) => track.id !== excludedId) || null;
    if (!byLanguage.length) return null;

    const info = (track) => track.native?.debug?.classification || {};
    if (variantPreference) {
      let preferredVariant;
      try { preferredVariant = JSON.parse(variantPreference); } catch (_) { preferredVariant = null; }
      if (!preferredVariant || typeof preferredVariant !== "object" || Array.isArray(preferredVariant)) return null;
      const variantMatches = byLanguage.filter((track) => Object.entries(preferredVariant).every(([key, value]) => info(track)[key] === value));
      if (variantMatches.length === 1) return variantMatches[0];
      return null;
    }

    let candidates = byLanguage.filter((track) => {
      const meta = info(track);
      return meta.selectable !== false && meta.isNone !== true && meta.isOff !== true;
    });
    candidates = candidates.filter((track) => info(track).isForced !== true && info(track).isForcedNarrative !== true);
    if (!candidates.length) return null;
    const variantRank = (track) => {
      const meta = info(track);
      const trackType = String(meta.trackType || "").toUpperCase();
      const rawType = String(meta.rawTrackType || meta.rawType || "").toUpperCase();
      if (trackType === "PRIMARY" && rawType === "SUBTITLES") return 0;
      if (trackType === "ASSISTIVE" && rawType === "CLOSEDCAPTIONS") return 1;
      return 2;
    };
    const bestRank = Math.min(...candidates.map(variantRank));
    let best = candidates.filter((track) => variantRank(track) === bestRank);
    if (best.length === 1) return best[0];
    const withResources = best.filter((track) => Number(info(track).resourceCount) > 0);
    if (withResources.length === 1) return withResources[0];
    if (withResources.length > 1) best = withResources;
    return best.length === 1 ? best[0] : null;
  }

  async function applyPreferredTracks() {
    if (!engine || !activeSettings.enabled || !engine.tracks.length) return;
    const strict = platform === "Netflix";
    const primary = preferredTrack(activeSettings.primaryTrackId, activeSettings.primaryLanguage, null, strict, activeSettings.primaryVariantPreference);
    const secondary = preferredTrack(activeSettings.secondaryTrackId, activeSettings.secondaryLanguage, primary?.id, strict, activeSettings.secondaryVariantPreference);
    activeSettings = normalize({ ...activeSettings,
      ...(primary ? { primaryTrackId: primary.id, primaryLanguage: primary.language, primaryVariantPreference: activeSettings.primaryVariantPreference || trackVariantPreference(primary) } : strict ? { primaryTrackId: null } : { primaryTrackId: null, primaryLanguage: null }),
      ...(secondary ? { secondaryTrackId: secondary.id, secondaryLanguage: secondary.language, secondaryVariantPreference: activeSettings.secondaryVariantPreference || trackVariantPreference(secondary) } : strict ? { secondaryTrackId: null } : { secondaryTrackId: null, secondaryLanguage: null })
    });
    nativeCaptionController?.setEnabled(!!primary);
    if (primary) {
      const selection = engine.select(primary.id, secondary?.id || null);
      syncVisuals();
      await selection;
    }
  }

  async function saveSettings(input) {
    const next = normalize({ ...activeSettings, ...input });
    if (!engine && next.enabled) throw new Error("PLAYER_NOT_READY: wait for subtitle tracks to initialize.");
    if (engine) {
      const primary = next.primaryTrackId == null ? null : resolveTrack(next.primaryTrackId);
      const secondary = next.secondaryTrackId == null ? null : resolveTrack(next.secondaryTrackId);
      if (next.enabled && !primary) throw new Error("NO_SUBTITLE_TRACKS: choose a Primary subtitle track first.");
      if (next.enabled && next.secondaryTrackId != null && !secondary) throw new Error("NO_SUBTITLE_TRACKS: the selected Secondary track is unavailable.");
      if (primary && secondary && secondary.id === primary.id) throw new Error("Choose two different subtitle tracks, or leave Secondary empty.");
      if (primary) {
        next.primaryTrackId = primary.id;
        next.primaryLanguage = primary.language;
        if (platform === "Netflix") next.primaryVariantPreference = trackVariantPreference(primary) || next.primaryVariantPreference;
      } else if (next.primaryTrackId != null) {
        next.primaryTrackId = null;
      }
      if (secondary) {
        next.secondaryTrackId = secondary.id;
        next.secondaryLanguage = secondary.language;
        if (platform === "Netflix") next.secondaryVariantPreference = trackVariantPreference(secondary) || next.secondaryVariantPreference;
      } else if (next.secondaryTrackId != null) {
        next.secondaryTrackId = null;
      }
    }
    const runtimeSettings = normalize(next);
    const persisted = await persistSettings(runtimeSettings);
    activeSettings = runtimeSettings;
    savedSettings = normalize(persisted);
    nativeCaptionController?.setEnabled(activeSettings.enabled && !!engine?.primaryId);
    if (activeSettings.enabled && engine) {
      const changed = engine.primaryId !== activeSettings.primaryTrackId || engine.secondaryId !== activeSettings.secondaryTrackId;
      if (changed) {
        const selection = engine.select(activeSettings.primaryTrackId, activeSettings.secondaryTrackId);
        nativeCaptionController?.setEnabled(!!engine.primaryId);
        syncVisuals();
        await selection;
      }
    }
    syncVisuals();
    return publicStatus();
  }

  function previewSettings(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid preview settings.");
    const visualKeys = ["primaryFontScale", "secondaryFontScale", "primaryY", "secondaryY", "maxWidth", "backgroundOpacity"];
    const visualSettings = Object.fromEntries(visualKeys.filter((key) => Object.hasOwn(input, key)).map((key) => [key, input[key]]));
    activeSettings = normalize({ ...activeSettings, ...visualSettings });
    syncVisuals();
    return publicStatus();
  }

  async function handlePopupCommand(message) {
    if (platform === "YouTube" && ["GET_STATUS", "LIST_TRACKS"].includes(message.type)) {
      void ensureYouTubeReady(`popup:${message.type.toLowerCase()}`);
      const deadline = Date.now() + 900;
      while (!engine && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 75));
    }
    switch (message.type) {
      case "GET_STATUS":
        return publicStatus();
      case "LIST_TRACKS":
        if (!engine) throw new Error("PLAYER_NOT_READY: subtitle tracks are still initializing.");
        return engine.tracks.map((track, index) => ({ index, ...publicTrack(track) }));
      case "SELECT_TRACKS": {
        if (!engine) throw new Error("PLAYER_NOT_READY: subtitle tracks are still initializing.");
        const args = message.args;
        if (!Array.isArray(args) || args.length < 1 || args.length > 2) throw new Error("Invalid track selection.");
        const primary = resolveTrack(args[0]);
        const secondary = args.length === 1 || args[1] == null ? null : resolveTrack(args[1]);
        if (!primary || (args.length > 1 && args[1] != null && !secondary)) throw new Error("Selected subtitle track is unavailable.");
        if (secondary?.id === primary.id) throw new Error("Primary and Secondary must be different tracks.");
        const selectedSettings = normalize({
          ...activeSettings,
          primaryTrackId: primary.id,
          primaryLanguage: primary.language,
          primaryVariantPreference: trackVariantPreference(primary) || activeSettings.primaryVariantPreference,
          secondaryTrackId: secondary?.id || null,
          secondaryLanguage: secondary?.language || null,
          secondaryVariantPreference: secondary ? (trackVariantPreference(secondary) || activeSettings.secondaryVariantPreference) : activeSettings.secondaryVariantPreference
        });
        if (platform === "Netflix") activeSettings = selectedSettings;
        const selection = engine.select(primary.id, secondary?.id || null);
        nativeCaptionController?.setEnabled(activeSettings.enabled);
        syncVisuals();
        await selection;
        if (platform !== "Netflix") activeSettings = selectedSettings;
        else lastInitError = null;
        savedSettings = await persistSettings(activeSettings);
        syncVisuals();
        return publicStatus();
      }
      case "ENABLE":
        return saveSettings({ enabled: true });
      case "DISABLE":
        return saveSettings({ enabled: false });
      case "PREVIEW_SETTINGS":
        return previewSettings(message.settings || {});
      case "SAVE_SETTINGS":
      case "UPDATE_SETTINGS":
        return saveSettings(message.settings || {});
      default:
        throw new Error("Unsupported SubTwin command.");
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.namespace !== "SUBTWIN_POPUP" || typeof message.type !== "string") return false;
    const allowed = new Set(["GET_STATUS", "LIST_TRACKS", "SELECT_TRACKS", "ENABLE", "DISABLE", "PREVIEW_SETTINGS", "SAVE_SETTINGS", "UPDATE_SETTINGS"]);
    if (!allowed.has(message.type)) return false;
    Promise.resolve(handlePopupCommand(message)).then(
      (result) => sendResponse({ ok: true, result }),
      (error) => sendResponse({ ok: false, error: String(error?.message || error) })
    );
    return true;
  });

  window.addEventListener("message", (event) => {
    const request = event.data;
    if (event.source !== window || event.origin !== location.origin || !request || request.namespace !== "SUBTWIN_DEBUG_REQUEST") return;
    if (typeof request.requestId !== "string" || request.requestId.length > 128) return;
    const respond = (ok, result) => window.postMessage({
      namespace: "SUBTWIN_DEBUG_RESPONSE",
      requestId: request.requestId,
      ok,
      ...(ok ? { result } : { error: String(result?.message || result || "Unknown error") })
    }, location.origin);
    try {
      if (request.type === "GET_STATUS") {
        if (platform === "YouTube") void ensureYouTubeReady("debug-status");
        return respond(true, publicStatus());
      }
      if (request.type === "GET_NETFLIX_DEBUG") {
        if (platform !== "Netflix") throw new Error("PLATFORM_UNSUPPORTED: Netflix diagnostics are only available on Netflix.");
        const fallback = engine?.adapter.getDiagnostics?.() || lastNetflixDiagnostics || {
          playerFound: false,
          activeTrackLimit: "UNKNOWN",
          subtitleRequestsObserved: 0,
          subtitleResponsesObserved: 0,
          lastSubtitleUrl: null,
          lastSubtitleContentType: null,
          lastSubtitleFormat: null,
          parseSuccessCount: 0,
          parseFailureCount: 0,
          perTrackCueCounts: {}
        };
        if (engine?.adapter.getDiagnosticsAsync) {
          engine.adapter.getDiagnosticsAsync().then(
            (diagnostics) => respond(true, { ...diagnostics, lastInitError }),
            (error) => respond(true, { ...fallback, lastInitError, diagnosticsError: String(error?.message || error) })
          );
          return;
        }
        return respond(true, { ...fallback, lastInitError });
      }
      if (request.type === "GET_NETFLIX_TRACKS_DEBUG") {
        if (platform !== "Netflix") throw new Error("PLATFORM_UNSUPPORTED: Netflix track diagnostics are only available on Netflix.");
        if (!engine?.adapter.getDiagnosticsAsync) throw new Error("PLAYER_NOT_READY: Netflix track diagnostics are not ready.");
        engine.adapter.getDiagnosticsAsync().then(
          (diagnostics) => respond(true, diagnostics.trackMetadata || []),
          (error) => respond(false, error)
        );
        return;
      }
      if (request.type === "TEST_NETFLIX_TRACK_BY_ID") {
        if (platform !== "Netflix") throw new Error("PLATFORM_UNSUPPORTED: track testing is only available on Netflix.");
        const trackId = Array.isArray(request.args) ? request.args[0] : null;
        if (typeof trackId !== "string" || !trackId || trackId.length > 256) throw new Error("Pass a current Netflix track ID.");
        if (!engine?.adapter.testTrackById) throw new Error("PLAYER_NOT_READY: Netflix track tester is not ready.");
        engine.adapter.testTrackById(trackId).then((result) => respond(true, result)).catch((error) => respond(false, error));
        return;
      }
      if (request.type === "LIST_TRACKS") {
        if (platform === "YouTube" && !engine) void ensureYouTubeReady("debug-list-tracks");
        if (!engine) throw new Error("PLAYER_NOT_READY: subtitle tracks are not initialized yet.");
        return respond(true, engine.tracks.map((track, index) => ({ index, ...publicTrack(track) })));
      }
      if (request.type === "SELECT_TRACKS") {
        if (!engine || !Array.isArray(request.args) || request.args.length < 1 || request.args.length > 2) throw new Error("Invalid track selection or player not ready.");
        const primary = resolveTrack(request.args[0]);
        const secondary = request.args.length === 1 || request.args[1] == null ? null : resolveTrack(request.args[1]);
        if (!primary || (request.args.length > 1 && request.args[1] != null && !secondary)) throw new Error("Invalid track index or id.");
        handlePopupCommand({ type: "SELECT_TRACKS", args: [primary.id, secondary?.id || null] }).then((result) => respond(true, result)).catch((error) => respond(false, error));
        return;
      }
      respond(false, "Unsupported command.");
    } catch (error) { respond(false, error); }
  });

  function syncVisuals() {
    if (!activeSettings.enabled || !engine) {
      nativeCaptionController?.setEnabled(false);
      renderer.clear();
      return;
    }
    const container = engine.adapter.getOverlayContainer?.();
    renderer.mount(container);
    nativeCaptionController?.setEnabled(activeSettings.enabled && !!engine.primaryId, container);
    const snapshot = engine.getSnapshot();
    renderer.update(snapshot.primaryCue, snapshot.secondaryCue, activeSettings);
  }

  async function initializeExistingPlatform() {
    if (initializing || Date.now() < nextInitAttemptAt) return;
    await settingsReady;
    if (!document.querySelector("video")) return;
    initializing = true;
    const ownGeneration = generation;
    let candidate = null;
    try {
      candidate = new DualSubtitle.SubtitleEngine(new Adapter(), logger);
      candidate.adapter.onSessionChange?.((change) => {
        if (candidate === engine) {
          logger.info(`Netflix playback changed (${change.reason}); reinitializing tracks.`);
          routeChanged();
        }
      });
      lastInitError = null;
      try {
        await candidate.initialize();
      } catch (error) {
        if (String(error?.message).startsWith("NO_SUBTITLE_TRACKS") && ownGeneration === generation) {
          engine = candidate;
          logger.warn("NO_SUBTITLE_TRACKS: player is connected, but this title exposes no text subtitle tracks.");
          syncVisuals();
          return;
        }
        throw error;
      }
      if (ownGeneration !== generation) {
        if (platform === "Netflix") candidate.destroy?.();
        return;
      }
      engine = candidate;
      nextInitAttemptAt = 0;
      logger.info("Ready. Select tracks in the SubTwin popup.");
      if (activeSettings.enabled) await applyPreferredTracks();
      syncVisuals();
    } catch (error) {
      if (platform === "Netflix" && candidate?.adapter.getDiagnostics) lastNetflixDiagnostics = candidate.adapter.getDiagnostics();
      if (platform === "Netflix" && candidate && candidate !== engine) candidate.destroy?.();
      const message = String(error?.message || error);
      const netflixCode = platform === "Netflix" ? /^(NETFLIX_PLAYER_NOT_FOUND|NETFLIX_TRACKS_NOT_FOUND|NETFLIX_SUBTITLE_REQUEST_NOT_FOUND|NETFLIX_PARSE_FAILED|NETFLIX_SESSION_CHANGED)/.exec(message)?.[1] : null;
      const code = netflixCode || /^(NO_VIDEO|NO_SUBTITLE_TRACKS|ONLY_ONE_TRACK|TRACK_FETCH_FAILED|PLATFORM_UNSUPPORTED|PLAYER_NOT_READY|ADAPTER_INIT_FAILED)/.exec(message)?.[1] || "ADAPTER_INIT_FAILED";
      lastInitError = { code, message };
      logger.error(code, error);
      if (platform === "Netflix" && (code === "NETFLIX_PLAYER_NOT_FOUND" || code === "NETFLIX_TRACKS_NOT_FOUND")) {
        nextInitAttemptAt = Date.now() + 2000;
      }
    } finally {
      if (ownGeneration === generation) initializing = false;
    }
  }

  const youtubeElementIds = new WeakMap();
  let nextYoutubeElementId = 1;
  function youtubeVideoKey() {
    const video = document.querySelector("video");
    let elementId = "none";
    if (video) {
      if (!youtubeElementIds.has(video)) youtubeElementIds.set(video, nextYoutubeElementId++);
      elementId = youtubeElementIds.get(video);
    }
    const url = new URL(location.href);
    const routeId = url.searchParams.get("v") || location.pathname.match(/^\/(?:shorts|live)\/([^/?]+)/)?.[1] || "";
    const source = video?.currentSrc || video?.src || "";
    let sourceKey = "unresolved";
    if (source) {
      try {
        const parsedSource = new URL(source, location.href);
        sourceKey = `${parsedSource.protocol}//${parsedSource.host}${parsedSource.pathname}`;
      } catch (_) { sourceKey = "loaded"; }
    }
    return `${location.pathname}:${routeId}:video-${elementId}:${sourceKey}`;
  }

  function isYouTubePlaybackPage() {
    return (location.pathname === "/watch" && !!new URL(location.href).searchParams.get("v"))
      || /^\/(?:shorts|live)\/[^/]+/.test(location.pathname);
  }

  function setYouTubeStartupState(state, reason) {
    youtubeStartup.state = state;
    youtubeStartup.lastAt = Date.now();
    youtubeStartup.currentVideoKey = youtubeVideoKey();
    youtubeStartup.videoFound = !!document.querySelector("video");
    youtubeStartup.playerFound = !!document.getElementById("movie_player");
    youtubeStartup.tracksFound = !!engine?.tracks?.length;
  }

  function scheduleYouTubeRetry() {
    if (youtubeRetryTimer || platform !== "YouTube") return;
    const delay = youtubeRetryDelays[Math.min(youtubeRetryIndex, youtubeRetryDelays.length - 1)];
    youtubeRetryIndex = Math.min(youtubeRetryIndex + 1, youtubeRetryDelays.length - 1);
    youtubeRetryTimer = setTimeout(() => {
      youtubeRetryTimer = null;
      void ensureYouTubeReady("retry");
    }, delay);
  }

  async function ensureYouTubeReady(reason = "startup") {
    if (platform !== "YouTube") return initializeExistingPlatform();
    if (youtubeInitPromise) return youtubeInitPromise;
    const canInterruptBackoff = reason === "navigation" || reason.startsWith("popup:") || reason.startsWith("debug-");
    if (youtubeRetryTimer && !canInterruptBackoff) return;
    if (youtubeRetryTimer && canInterruptBackoff) {
      clearTimeout(youtubeRetryTimer);
      youtubeRetryTimer = null;
    }
    const attempt = (async () => {
      await settingsReady;
      youtubeStartup.attempts++;
      youtubeStartup.lastReason = reason;
      youtubeStartup.lastAt = Date.now();
      youtubeStartup.currentVideoKey = youtubeVideoKey();
      youtubeStartup.videoFound = !!document.querySelector("video");
      youtubeStartup.playerFound = !!document.getElementById("movie_player");
      youtubeStartup.tracksFound = !!engine?.tracks?.length;

      if (!isYouTubePlaybackPage()) {
        setYouTubeStartupState("WAITING_PAGE", "waiting for YouTube playback page");
        return;
      }
      if (!youtubeStartup.videoFound || !youtubeStartup.playerFound) {
        const wasWaiting = youtubeStartup.state === "WAITING_PLAYER";
        setYouTubeStartupState("WAITING_PLAYER", "waiting for YouTube player");
        if (!wasWaiting) logger.info("waiting for player");
        return;
      }

      const videoKey = youtubeVideoKey();
      if (engine && youtubeEngineVideoKey === videoKey) {
        setYouTubeStartupState("READY", "YouTube ready");
        if (activeSettings.enabled) syncVisuals();
        youtubeRetryIndex = 0;
        return;
      }

      if (engine && youtubeEngineVideoKey !== videoKey) {
        setYouTubeStartupState("REINITIALIZING", "YouTube video changed");
        engine.destroy?.();
        engine = null;
        youtubeEngineVideoKey = null;
        nativeCaptionController?.setEnabled(false);
        renderer.clear();
      }

      if (Date.now() < nextInitAttemptAt) return;
      initializing = true;
      const ownGeneration = generation;
      let candidate = null;
      try {
        if (youtubeStartup.state !== "WAITING_TRACKS") logger.info("player found; waiting for caption tracks");
        setYouTubeStartupState("WAITING_TRACKS", "waiting for YouTube caption tracks");
        candidate = new DualSubtitle.SubtitleEngine(new Adapter(), logger);
        await candidate.initialize();
        if (ownGeneration !== generation || videoKey !== youtubeVideoKey()) {
          candidate.destroy?.();
          return;
        }
        engine = candidate;
        youtubeEngineVideoKey = videoKey;
        youtubeStartup.tracksFound = engine.tracks.length > 0;
        lastYouTubeVideo = document.querySelector("video");
        lastYouTubeSource = lastYouTubeVideo?.currentSrc || lastYouTubeVideo?.src || "";
        youtubeRetryIndex = 0;
        nextInitAttemptAt = 0;
        lastInitError = null;
        setYouTubeStartupState("READY", "YouTube ready");
        logger.info("ready");
        if (activeSettings.enabled) {
          try { await applyPreferredTracks(); }
          catch (error) { logger.warn("Saved YouTube track preference could not be applied yet.", error); }
        }
        syncVisuals();
      } catch (error) {
        candidate?.destroy?.();
        const message = String(error?.message || error);
        const retryable = /^(PLAYER_NOT_READY|NO_VIDEO|NO_SUBTITLE_TRACKS)/.test(message);
        if (retryable) {
          const wasWaitingTracks = youtubeStartup.state === "WAITING_TRACKS";
          setYouTubeStartupState("WAITING_TRACKS", "waiting for YouTube caption tracks");
          if (!wasWaitingTracks) logger.info(message.startsWith("NO_SUBTITLE_TRACKS") ? "waiting for caption tracks" : "waiting for player");
        } else {
          lastInitError = { code: "ADAPTER_INIT_FAILED", message };
          logger.error("ADAPTER_INIT_FAILED", error);
          setYouTubeStartupState("REINITIALIZING", "YouTube adapter initialization will retry");
        }
      } finally {
        initializing = false;
      }
    })();
    youtubeInitPromise = attempt;
    try { await attempt; }
    finally {
      if (youtubeInitPromise === attempt) youtubeInitPromise = null;
      if (!engine || youtubeStartup.state !== "READY") scheduleYouTubeRetry();
    }
  }

  function initialize(reason = "startup") {
    return platform === "YouTube" ? ensureYouTubeReady(reason) : initializeExistingPlatform();
  }

  let lastUrl = location.href;
  let lastNetflixVideo = platform === "Netflix" ? document.querySelector("video") : null;
  let lastNetflixSource = lastNetflixVideo?.currentSrc || lastNetflixVideo?.src || "";
  let lastYouTubeVideo = platform === "YouTube" ? document.querySelector("video") : null;
  let lastYouTubeSource = lastYouTubeVideo?.currentSrc || lastYouTubeVideo?.src || "";
  const routeChanged = (reason = "navigation") => {
    if (routeResetTimer) {
      clearTimeout(routeResetTimer);
    } else {
      generation++;
      initializing = false;
      if (platform === "Netflix") {
        activeSettings = normalize({ ...activeSettings, primaryTrackId: null, secondaryTrackId: null });
      }
      engine?.destroy?.();
      engine = null;
      if (platform === "YouTube") {
        youtubeEngineVideoKey = null;
        youtubeStartup.tracksFound = false;
        youtubeStartup.lastReason = reason;
        setYouTubeStartupState("REINITIALIZING", "YouTube navigation detected");
        if (youtubeRetryTimer) clearTimeout(youtubeRetryTimer);
        youtubeRetryTimer = null;
      }
      nativeCaptionController?.setEnabled(false);
      renderer.clear();
    }
    routeResetTimer = setTimeout(() => {
      routeResetTimer = null;
      nextInitAttemptAt = 0;
      initialize("navigation");
    }, 600);
  };
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      routeChanged();
    } else if (platform === "Netflix") {
      const video = document.querySelector("video");
      const source = video?.currentSrc || video?.src || "";
      if (video !== lastNetflixVideo || (source && lastNetflixSource && source !== lastNetflixSource)) {
        lastNetflixVideo = video;
        lastNetflixSource = source;
        routeChanged();
      } else if (!engine && video) initialize();
      else if (activeSettings.enabled) syncVisuals();
    } else {
      const video = document.querySelector("video");
      const source = video?.currentSrc || video?.src || "";
      if (platform === "YouTube" && (video !== lastYouTubeVideo || (source !== lastYouTubeSource && (source || lastYouTubeSource)))) {
        lastYouTubeVideo = video;
        lastYouTubeSource = source;
        if (engine) routeChanged("video-element-or-source-change");
        else void ensureYouTubeReady("video-element-or-source-change");
      } else if (!engine) void ensureYouTubeReady("startup-poll");
      else {
        const key = youtubeVideoKey();
        if (youtubeEngineVideoKey !== key) routeChanged("video-key-change");
        else if (activeSettings.enabled) syncVisuals();
      }
    }
  }, 200);
  if (platform === "Netflix") {
    document.addEventListener("fullscreenchange", syncVisuals);
    document.addEventListener("webkitfullscreenchange", syncVisuals);
  }
  if (platform === "YouTube") {
    document.addEventListener("yt-navigate-finish", () => {
      lastUrl = location.href;
      routeChanged();
    });
    document.addEventListener("yt-page-data-updated", () => {
      if (!engine) void ensureYouTubeReady("yt-page-data-updated");
    });
    youtubeObserver = new MutationObserver(() => {
      if (youtubeObserverTimer) return;
      youtubeObserverTimer = setTimeout(() => {
        youtubeObserverTimer = null;
        if (!isYouTubePlaybackPage()) return;
        const key = youtubeVideoKey();
        if (engine && youtubeEngineVideoKey !== key) routeChanged("player-dom-video-change");
        else if (!engine) void ensureYouTubeReady("player-dom-mounted");
        else if (activeSettings.enabled && (!renderer.host?.isConnected || renderer.host.parentElement !== engine.adapter.getOverlayContainer?.())) syncVisuals();
      }, 100);
    });
    youtubeObserver.observe(document.documentElement, { childList: true, subtree: true });
  }
  initialize("content-script-start");
})();
