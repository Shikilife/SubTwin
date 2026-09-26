(function (root) {
  function activeCue(cues, timeMs) {
    let low = 0;
    let high = cues.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];
      if (timeMs < cue.startMs) high = mid - 1;
      else if (timeMs >= cue.endMs) low = mid + 1;
      else return cue;
    }
    return null;
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.timeSync = { activeCue };
})(globalThis);
