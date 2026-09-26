(function (root) {
  function createLogger(platform) {
    const prefix = `[DualSubtitle][${platform}]`;
    return {
      info: (...args) => console.info(prefix, ...args),
      warn: (...args) => console.warn(prefix, ...args),
      error: (code, error) => console.error(prefix, code, error),
      tracks: (tracks) => {
        console.info(`${prefix} ${tracks.length} subtitle tracks found`);
        tracks.forEach((track, i) => console.info(`${prefix} [${i}] id=${JSON.stringify(track.id)} language=${track.language} label=${track.label}`));
      },
      selection: (primary, secondary) => {
        console.info(`${prefix} Primary: ${primary.language}`);
        if (secondary) console.info(`${prefix} Secondary: ${secondary.language}`);
        else console.info(`${prefix} Secondary: none`);
      },
      current: (primary, first, secondary, second) => {
        console.info(`${prefix}\n[Primary][${primary.language}]\n${first ? first.text : ""}${secondary ? `\n\n[Secondary][${secondary.language}]\n${second ? second.text : ""}` : ""}`);
      }
    };
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.createLogger = createLogger;
})(globalThis);
