const assert = require("node:assert/strict");

global.location = { origin: "https://www.youtube.com" };
global.document = { querySelector: () => ({}) };
global.window = {
  addEventListener() {},
  removeEventListener() {},
  postMessage() {}
};
global.DualSubtitle = {
  types: {
    normalizeTrack: (track) => track,
    parseCues: () => []
  }
};
require("../src/platforms/youtube/youtube-adapter.js");

(async () => {
  const adapter = new DualSubtitle.YouTubeAdapter();
  const cueResult = adapter.getCues(".en").catch((error) => error);
  const bridgeResult = adapter.snapshotNativeTrack().catch((error) => error);
  const cueEntry = adapter.pending.get(".en");
  const bridgeEntry = [...adapter.bridgeRequests.values()][0];

  assert.equal(typeof cueEntry.resolve, "function");
  assert.equal(typeof cueEntry.reject, "function");
  assert.equal(cueEntry.purpose, "runtime");
  assert.equal(typeof bridgeEntry.resolve, "function");
  assert.equal(typeof bridgeEntry.reject, "function");
  assert.equal(bridgeEntry.purpose, "snapshotNativeTrack");

  adapter.pending.set("legacy-shape", { timer: setTimeout(() => {}, 10000) });
  assert.doesNotThrow(() => adapter.destroy());
  assert.doesNotThrow(() => adapter.destroy());
  assert.equal(adapter.pending.size, 0);
  assert.equal(adapter.bridgeRequests.size, 0);
  const [cueError, bridgeError] = await Promise.all([cueResult, bridgeResult]);
  assert.match(cueError.message, /PLAYER_NOT_READY/);
  assert.match(bridgeError.message, /PLAYER_NOT_READY/);
  console.log("YouTube adapter pending cleanup tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
