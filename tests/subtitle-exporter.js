const assert = require("node:assert/strict");
const { createMarkdown, formatTimestamp, sanitizeFilename } = require("../src/export/subtitle-exporter.js");

const single = createMarkdown({
  title: "A: Sample / Episode",
  tracks: [{ id: "zh-Hant", language: "zh-Hant", label: "中文（繁體）", cues: [
    { startMs: 59000, endMs: 60000, text: "第一行\n第二行" },
    { startMs: 61000, endMs: 62000, text: "   " }
  ] }]
});
assert.match(single, /# A: Sample \/ Episode/);
assert.match(single, /## 中文（繁體）/);
assert.match(single, /### 00:59\n第一行\n第二行/);
assert.doesNotMatch(single, /### 01:01/);

const multiple = createMarkdown({
  title: "Episode",
  tracks: [
    { id: "en", label: "English", cues: [{ startMs: 3661000, text: "Hello." }, { startMs: 1000, text: "[music playing]" }] },
    { id: "en-cc", label: "English [CC]", cues: [{ startMs: 2000, text: "[door closes]" }] }
  ],
  failedTracks: [{ id: "ja", label: "日本語" }]
});
assert.match(multiple, /> Exported tracks: English, English \[CC\]/);
assert.match(multiple, /> Failed tracks: 日本語/);
assert.match(multiple, /### 01:01:01\nHello\./);
assert.match(multiple, /### 00:01\n\[music playing\]/);
assert.match(multiple, /### 00:02\n\[door closes\]/);
assert.equal(formatTimestamp(59000), "00:59");
assert.equal(formatTimestamp(61000), "01:01");
assert.equal(formatTimestamp(3661000), "01:01:01");
assert.equal(sanitizeFilename('A\\B/C:*?"<>|. '), "SubTwin_A_B_C________subtitles.md");
assert.ok(sanitizeFilename("x".repeat(300)).length <= 120);
console.log("subtitle-exporter tests passed");
