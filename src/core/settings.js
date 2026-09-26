(function (root) {
  const KEY = "subTwinSettings";
  const defaults = Object.freeze({
    enabled: false,
    primaryTrackId: null,
    secondaryTrackId: null,
    primaryLanguage: null,
    secondaryLanguage: null,
    primaryVariantPreference: null,
    secondaryVariantPreference: null,
    primaryFontScale: 100,
    secondaryFontScale: 90,
    primaryY: 72,
    secondaryY: 84,
    maxWidth: 90,
    backgroundOpacity: 65
  });
  const ALL_TRACK_PREFERENCE_KEYS = Object.freeze([
    "primaryTrackId",
    "secondaryTrackId",
    "primaryLanguage",
    "secondaryLanguage",
    "primaryVariantPreference",
    "secondaryVariantPreference"
  ]);
  const PERSISTED_TRACK_KEYS = Object.freeze({
    youtube: ALL_TRACK_PREFERENCE_KEYS,
    netflix: Object.freeze([
      "primaryLanguage",
      "secondaryLanguage",
      "primaryVariantPreference",
      "secondaryVariantPreference"
    ])
  });

  function scale(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(30, Math.min(200, Math.round(number / 5) * 5)) : fallback;
  }

  function percentage(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
  }

  function normalize(value = {}) {
    return {
      enabled: value.enabled === true,
      primaryTrackId: typeof value.primaryTrackId === "string" ? value.primaryTrackId : null,
      secondaryTrackId: typeof value.secondaryTrackId === "string" ? value.secondaryTrackId : null,
      primaryLanguage: typeof value.primaryLanguage === "string" ? value.primaryLanguage : null,
      secondaryLanguage: typeof value.secondaryLanguage === "string" ? value.secondaryLanguage : null,
      primaryVariantPreference: typeof value.primaryVariantPreference === "string" && value.primaryVariantPreference.length <= 500 ? value.primaryVariantPreference : null,
      secondaryVariantPreference: typeof value.secondaryVariantPreference === "string" && value.secondaryVariantPreference.length <= 500 ? value.secondaryVariantPreference : null,
      primaryFontScale: scale(value.primaryFontScale, defaults.primaryFontScale),
      secondaryFontScale: scale(value.secondaryFontScale, defaults.secondaryFontScale),
      primaryY: percentage(value.primaryY, 0, 100, defaults.primaryY),
      secondaryY: percentage(value.secondaryY, 0, 100, defaults.secondaryY),
      maxWidth: percentage(value.maxWidth, 40, 100, defaults.maxWidth),
      backgroundOpacity: percentage(value.backgroundOpacity, 0, 100, defaults.backgroundOpacity)
    };
  }

  function serializeForStorage(platform, value) {
    const normalized = normalize(value);
    const platformKey = String(platform || "").toLowerCase();
    const allowedTrackKeys = PERSISTED_TRACK_KEYS[platformKey];
    if (!allowedTrackKeys) throw new Error(`Unsupported settings platform: ${platform}`);

    const tracks = {};
    for (const key of allowedTrackKeys) {
      if (normalized[key] != null) tracks[key] = normalized[key];
    }
    for (const key of ALL_TRACK_PREFERENCE_KEYS) delete normalized[key];
    return { settings: normalized, tracks };
  }

  function restoreFromStorage(platform, sharedSettings, trackPreferences) {
    const platformKey = String(platform || "").toLowerCase();
    const allowedTrackKeys = PERSISTED_TRACK_KEYS[platformKey];
    if (!allowedTrackKeys) throw new Error(`Unsupported settings platform: ${platform}`);
    const shared = normalize(sharedSettings || defaults);
    for (const key of ALL_TRACK_PREFERENCE_KEYS) delete shared[key];
    const savedTracks = trackPreferences && typeof trackPreferences === "object" && !Array.isArray(trackPreferences)
      ? trackPreferences
      : {};
    const tracks = {};
    for (const key of allowedTrackKeys) {
      if (savedTracks[key] != null) tracks[key] = savedTracks[key];
    }
    return normalize({ ...shared, ...tracks });
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.settings = { KEY, defaults, normalize, serializeForStorage, restoreFromStorage };
})(globalThis);
