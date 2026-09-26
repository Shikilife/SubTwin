"use strict";

const assert = require("node:assert/strict");
require("../src/core/settings.js");

const { serializeForStorage, restoreFromStorage } = globalThis.DualSubtitle.settings;

const youtubeInput = {
  primaryTrackId: ".en",
  secondaryTrackId: ".zh-Hant",
  primaryLanguage: "en",
  secondaryLanguage: "zh-Hant"
};
const youtubeStored = serializeForStorage("youtube", youtubeInput);
assert.equal(youtubeStored.tracks.primaryTrackId, ".en");
assert.equal(youtubeStored.tracks.secondaryTrackId, ".zh-Hant");
assert.equal(Object.hasOwn(youtubeStored.settings, "primaryTrackId"), false);
const youtubeRestored = restoreFromStorage("youtube", youtubeStored.settings, youtubeStored.tracks);
assert.equal(youtubeRestored.primaryTrackId, ".en");
assert.equal(youtubeRestored.secondaryTrackId, ".zh-Hant");

const ccVariant = JSON.stringify({ trackType: "ASSISTIVE", rawTrackType: "CLOSEDCAPTIONS", isForcedNarrative: false });
const netflixInput = {
  primaryTrackId: "T:example:zh-Hant",
  secondaryTrackId: "T:example:en-cc",
  primaryLanguage: "zh-Hant",
  secondaryLanguage: "en",
  primaryVariantPreference: null,
  secondaryVariantPreference: ccVariant
};
const netflixStored = serializeForStorage("netflix", netflixInput);
assert.equal(Object.hasOwn(netflixStored.tracks, "primaryTrackId"), false);
assert.equal(Object.hasOwn(netflixStored.tracks, "secondaryTrackId"), false);
assert.equal(Object.hasOwn(netflixStored.settings, "primaryTrackId"), false);
assert.equal(Object.hasOwn(netflixStored.settings, "secondaryTrackId"), false);
assert.equal(netflixStored.tracks.primaryLanguage, "zh-Hant");
assert.equal(netflixStored.tracks.secondaryLanguage, "en");
assert.equal(netflixStored.tracks.secondaryVariantPreference, ccVariant);

// Old Netflix data may contain exact IDs in either the shared settings or platform track object.
const netflixMigrated = restoreFromStorage("netflix", {
  enabled: true,
  primaryTrackId: "T:old-title:primary",
  secondaryTrackId: "T:old-title:secondary",
  primaryY: 70
}, {
  primaryTrackId: "T:old-title:primary",
  secondaryTrackId: "T:old-title:secondary",
  primaryLanguage: "zh-Hant",
  secondaryLanguage: "en",
  secondaryVariantPreference: ccVariant
});
assert.equal(netflixMigrated.primaryTrackId, null);
assert.equal(netflixMigrated.secondaryTrackId, null);
assert.equal(netflixMigrated.primaryLanguage, "zh-Hant");
assert.equal(netflixMigrated.secondaryLanguage, "en");
assert.equal(netflixMigrated.secondaryVariantPreference, ccVariant);
assert.equal(netflixMigrated.enabled, true);
assert.equal(netflixMigrated.primaryY, 70);

console.log("Settings persistence contract: PASS");
