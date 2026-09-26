(() => {
  const defaults = { enabled: false, primaryTrackId: null, secondaryTrackId: null, primaryLanguage: null, secondaryLanguage: null, primaryVariantPreference: null, secondaryVariantPreference: null, primaryFontScale: 100, secondaryFontScale: 90, primaryY: 72, secondaryY: 84, maxWidth: 90, backgroundOpacity: 65 };
  const enabled = document.getElementById("enabled");
  const primary = document.getElementById("primary");
  const secondary = document.getElementById("secondary");
  const primarySize = document.getElementById("primary-size");
  const secondarySize = document.getElementById("secondary-size");
  const primaryY = document.getElementById("primary-y");
  const secondaryY = document.getElementById("secondary-y");
  const maxWidth = document.getElementById("max-width");
  const backgroundOpacity = document.getElementById("background-opacity");
  const apply = document.getElementById("apply");
  const message = document.getElementById("message");
  const connection = document.getElementById("connection");
  let tabId = null;
  let tracks = [];
  let saved = defaults;
  let active = defaults;
  let connected = false;
  let isNetflix = false;
  let previewFrame = 0;
  const ranges = [primarySize, secondarySize, primaryY, secondaryY, maxWidth, backgroundOpacity];
  for (const range of ranges) range.disabled = true;

  function say(text, error = false) {
    message.textContent = text;
    message.classList.toggle("error", error);
  }

  function setRange(input, rawValue) {
    const min = Number(input.min);
    const max = Number(input.max);
    const step = Number(input.step) || 1;
    const value = Number(rawValue);
    const safe = Number.isFinite(value) ? value : Number(input.value);
    input.value = String(Math.max(min, Math.min(max, min + Math.round((safe - min) / step) * step)));
    document.getElementById(`${input.id}-value`).textContent = `${input.value}%`;
  }

  async function send(type, data = {}) {
    if (tabId == null) throw new Error("No active browser tab.");
    const response = await chrome.tabs.sendMessage(tabId, { namespace: "SUBTWIN_POPUP", type, ...data });
    if (!response?.ok) throw new Error(response?.error || "The player did not respond.");
    return response.result;
  }

  function optionLabel(track) {
    const label = track.label || track.language || track.id;
    const translated = track.language && track.language !== label ? `${label} (${track.language})` : label;
    const duplicates = tracks.filter((other) => other.label === track.label && other.language === track.language);
    if (duplicates.length < 2) return translated;
    const variant = duplicates.findIndex((other) => other.id === track.id) + 1;
    return variant === 1 ? translated : `${translated} · Variant ${variant}`;
  }

  function fillSelect(select, items, selectedId, emptyLabel = null, unavailableLabel = null) {
    select.replaceChildren();
    if (emptyLabel != null) {
      const empty = document.createElement("option");
      empty.value = "";
      empty.textContent = emptyLabel;
      select.append(empty);
    }
    if (unavailableLabel) {
      const unavailable = document.createElement("option");
      unavailable.value = "";
      unavailable.textContent = unavailableLabel;
      select.append(unavailable);
    }
    for (const track of items) {
      const option = document.createElement("option");
      option.value = track.id;
      option.textContent = optionLabel(track);
      select.append(option);
    }
    if (selectedId && items.some((track) => track.id === selectedId)) select.value = selectedId;
    else if (emptyLabel == null && !unavailableLabel && items.length) select.value = items[0].id;
    else select.value = "";
    select.disabled = items.length === 0;
  }

  function findByPreference(id, language, excludedId, variantPreference = null) {
    const candidates = tracks.filter((track) => track.id !== excludedId);
    const exact = candidates.find((track) => track.id === id);
    if (exact) return exact;
    const languageCandidates = candidates.filter((track) => track.language === language);
    if (isNetflix && variantPreference) {
      const matches = languageCandidates.filter((track) => track.variantPreference === variantPreference);
      return matches.length === 1 ? matches[0] : null;
    }
    if (isNetflix && languageCandidates.length) {
      const selectable = languageCandidates.filter((track) => track.variantInfo?.selectable !== false
        && track.variantInfo?.isNone !== true && track.variantInfo?.isOff !== true
        && track.variantInfo?.isForced !== true && track.variantInfo?.isForcedNarrative !== true);
      const rank = (track) => {
        const type = String(track.variantInfo?.trackType || "").toUpperCase();
        const raw = String(track.variantInfo?.rawTrackType || "").toUpperCase();
        return type === "PRIMARY" && raw === "SUBTITLES" ? 0
          : type === "ASSISTIVE" && raw === "CLOSEDCAPTIONS" ? 1 : 2;
      };
      const bestRank = selectable.length ? Math.min(...selectable.map(rank)) : Infinity;
      const best = selectable.filter((track) => rank(track) === bestRank);
      if (best.length === 1) return best[0];
      const resourceMatches = best.filter((track) => Number(track.variantInfo?.resourceCount) > 0);
      if (resourceMatches.length === 1) return resourceMatches[0];
      return null;
    }
    const match = languageCandidates[0];
    if (match) return match;
    if (isNetflix && (id || language)) return null;
    return candidates[0] || null;
  }

  function updateTrackMenus() {
    const previousPrimary = primary.value;
    const previousSecondary = secondary.value;
    const chosenPrimary = findByPreference(previousPrimary || active.primaryTrackId, active.primaryLanguage, null, active.primaryVariantPreference);
    const primaryMissing = isNetflix && !chosenPrimary && (active.primaryTrackId || active.primaryLanguage);
    fillSelect(primary, tracks, chosenPrimary?.id || null, null, primaryMissing ? `Unavailable · ${active.primaryLanguage || "saved track"}` : null);
    const chosenSecondary = findByPreference(previousSecondary || active.secondaryTrackId, active.secondaryLanguage, primary.value, active.secondaryVariantPreference);
    const secondaryMissing = isNetflix && !chosenSecondary && (active.secondaryTrackId || active.secondaryLanguage);
    fillSelect(secondary, tracks, chosenSecondary?.id || null, secondaryMissing ? `Unavailable · ${active.secondaryLanguage || "saved track"}` : "No secondary subtitle");
    if (secondary.value === primary.value) secondary.value = "";
    secondary.disabled = tracks.length < 2;
    apply.disabled = !connected;
  }

  async function initialize() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error("No active tab found.");
      tabId = tab.id;
      let status;
      let lastError;
      connection.textContent = "Connecting…";
      for (let attempt = 0; attempt < 24; attempt++) {
        try {
          status = await send("GET_STATUS");
          isNetflix = status.platform === "netflix";
          if (isNetflix) connection.textContent = "Netflix • Connecting";
          if (status.initialized) {
            try {
              tracks = await send("LIST_TRACKS");
              break;
            } catch (error) { lastError = error; }
          }
        } catch (error) { lastError = error; }
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      if (!status?.initialized) throw lastError || new Error("Player is still initializing. Reopen this popup in a moment.");
      if (!tracks.length) {
        try { tracks = await send("LIST_TRACKS"); }
        catch (error) { throw lastError || error; }
      }
      saved = { ...defaults, ...(status.savedSettings || {}) };
      active = { ...saved, ...(status.activeSettings || {}) };
      isNetflix = status.platform === "netflix";
      enabled.checked = active.enabled === true;
      setRange(primarySize, active.primaryFontScale ?? defaults.primaryFontScale);
      setRange(secondarySize, active.secondaryFontScale ?? defaults.secondaryFontScale);
      setRange(primaryY, active.primaryY ?? defaults.primaryY);
      setRange(secondaryY, active.secondaryY ?? defaults.secondaryY);
      setRange(maxWidth, active.maxWidth ?? defaults.maxWidth);
      setRange(backgroundOpacity, active.backgroundOpacity ?? defaults.backgroundOpacity);
      connected = true;
      for (const range of ranges) range.disabled = false;
      updateTrackMenus();
      connection.textContent = `${status.platform[0].toUpperCase()}${status.platform.slice(1)} • Connected`;
      say(tracks.length ? `${tracks.length} subtitle track${tracks.length === 1 ? "" : "s"} available.` : "No subtitle tracks on this video. SubTwin is available to disable.");
    } catch (error) {
      primary.disabled = secondary.disabled = apply.disabled = true;
      connection.textContent = isNetflix ? "Netflix • Waiting for player" : "Player not connected";
      say(error.message || "Player is still initializing. Try reopening the popup shortly.", true);
    }
  }

  function visualSettings() {
    return {
      primaryFontScale: Number(primarySize.value),
      secondaryFontScale: Number(secondarySize.value),
      primaryY: Number(primaryY.value),
      secondaryY: Number(secondaryY.value),
      maxWidth: Number(maxWidth.value),
      backgroundOpacity: Number(backgroundOpacity.value)
    };
  }

  function schedulePreview() {
    if (previewFrame) return;
    previewFrame = requestAnimationFrame(async () => {
      previewFrame = 0;
      try {
        const status = await send("PREVIEW_SETTINGS", { settings: visualSettings() });
        active = { ...active, ...(status.activeSettings || {}) };
      } catch (error) {
        say(error.message || String(error), true);
      }
    });
  }

  for (const range of ranges) {
    range.addEventListener("input", () => {
      setRange(range, range.value);
      schedulePreview();
    });
  }

  primary.addEventListener("change", () => {
    const selected = secondary.value;
    const candidates = tracks.filter((track) => track.id !== primary.value);
    const preserved = candidates.some((track) => track.id === selected) ? selected : null;
    fillSelect(secondary, candidates, preserved, "No secondary subtitle");
    secondary.disabled = tracks.length < 2;
  });

  apply.addEventListener("click", async () => {
    apply.disabled = true;
    say("Applying…");
    const primaryTrack = tracks.find((track) => track.id === primary.value);
    const secondaryTrack = tracks.find((track) => track.id === secondary.value) || null;
    const next = {
      enabled: enabled.checked,
      primaryTrackId: primaryTrack?.id || null,
      primaryLanguage: primaryTrack?.language || null,
      secondaryTrackId: secondaryTrack?.id || null,
      secondaryLanguage: secondaryTrack?.language || null,
      ...visualSettings()
    };
    try {
      if (previewFrame) {
        cancelAnimationFrame(previewFrame);
        previewFrame = 0;
      }
      const status = await send("SAVE_SETTINGS", { settings: next });
      saved = { ...defaults, ...(status.savedSettings || next) };
      active = { ...defaults, ...(status.activeSettings || next) };
      say(status.enabled ? "SubTwin is enabled." : "Settings applied. SubTwin is disabled.");
      connection.textContent = `${status.platform[0].toUpperCase()}${status.platform.slice(1)} • Connected`;
    } catch (error) {
      say(error.message || String(error), true);
    } finally { apply.disabled = !connected; }
  });

  initialize();
})();
