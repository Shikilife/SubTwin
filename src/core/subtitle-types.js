(function (root) {
  const errors = {
    NO_VIDEO: "NO_VIDEO",
    NO_SUBTITLE_TRACKS: "NO_SUBTITLE_TRACKS",
    ONLY_ONE_TRACK: "ONLY_ONE_TRACK",
    TRACK_FETCH_FAILED: "TRACK_FETCH_FAILED",
    PLATFORM_UNSUPPORTED: "PLATFORM_UNSUPPORTED",
    PLAYER_NOT_READY: "PLAYER_NOT_READY",
    ADAPTER_INIT_FAILED: "ADAPTER_INIT_FAILED"
  };

  function normalizeTrack(raw) {
    return {
      id: String(raw.id || raw.trackId || raw.languageCode || raw.language || "unknown"),
      language: String(raw.language || raw.languageCode || raw.bcp47 || "und"),
      label: String(raw.label || raw.displayName || raw.name || raw.language || "Unknown"),
      native: raw
    };
  }

  function decodeEntities(text) {
    const node = document.createElement("textarea");
    node.innerHTML = text;
    return node.value;
  }

  const localName = (node) => String(node?.localName || node?.nodeName || "").split(":").pop();
  const descendants = (node, name) => [...(node?.getElementsByTagName?.("*") || [])].filter((item) => localName(item) === name);

  function attributeByLocalName(node, name) {
    if (!node?.attributes) return "";
    for (const attribute of [...node.attributes]) {
      if (localName(attribute) === name) return attribute.value;
    }
    return node.getAttribute?.(name) || "";
  }

  function textWithLineBreaks(node) {
    let result = "";
    const visit = (current) => {
      for (const child of [...(current.childNodes || [])]) {
        if (child.nodeType === 3 || child.nodeType === 4) result += child.nodeValue || "";
        else if (child.nodeType === 1) {
          if (localName(child) === "br") result += "\n";
          else visit(child);
        }
      }
    };
    visit(node);
    return result
      .replace(/[\t\f\v ]+/g, " ")
      .replace(/ *\n+ */g, "\n")
      .trim();
  }

  function parseTtmlTime(value, rates) {
    const input = String(value || "").trim().toLowerCase();
    if (!input) return { milliseconds: NaN, format: "missing" };

    const offset = input.match(/^([+-]?(?:\d+\.?\d*|\.\d+))(h|m|s|ms|f|t)$/);
    if (offset) {
      const amount = Number(offset[1]);
      const unit = offset[2];
      const multiplier = { h: 3600000, m: 60000, s: 1000, ms: 1 }[unit];
      if (multiplier) return { milliseconds: amount * multiplier, format: `offset-${unit}` };
      if (unit === "f" && rates.frameRate > 0) return { milliseconds: amount / rates.frameRate * 1000, format: "frames" };
      if (unit === "t" && rates.tickRate > 0) return { milliseconds: amount / rates.tickRate * 1000, format: "ticks" };
      return { milliseconds: NaN, format: unit === "f" ? "frames-no-frameRate" : "ticks-no-tickRate" };
    }

    const clock = input.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
    if (clock) {
      const [, hours, minutes, seconds, fraction = ""] = clock;
      const fractionMs = fraction ? Number(`0.${fraction}`) * 1000 : 0;
      return { milliseconds: ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + fractionMs, format: "clock" };
    }

    const shortClock = input.match(/^(\d+):(\d{2})(?:\.(\d+))?$/);
    if (shortClock) {
      const [, minutes, seconds, fraction = ""] = shortClock;
      const fractionMs = fraction ? Number(`0.${fraction}`) * 1000 : 0;
      return { milliseconds: (Number(minutes) * 60 + Number(seconds)) * 1000 + fractionMs, format: "clock-short" };
    }

    const frameClock = input.match(/^(\d+):(\d{2}):(\d{2}):(\d+)(?:\.(\d+))?$/);
    if (frameClock && rates.frameRate > 0) {
      const [, hours, minutes, seconds, frames, subframes = ""] = frameClock;
      const baseMs = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
      const subframeValue = subframes ? Number(`0.${subframes}`) : 0;
      return { milliseconds: baseMs + (Number(frames) + subframeValue) / rates.frameRate * 1000, format: "frames-clock" };
    }

    return { milliseconds: NaN, format: "unknown" };
  }

  function getTtmlRates(rootElement) {
    const frameRateValue = Number(attributeByLocalName(rootElement, "frameRate"));
    const multiplier = attributeByLocalName(rootElement, "frameRateMultiplier").trim().split(/\s+/).map(Number);
    const multiplierValue = multiplier.length === 2 && multiplier.every(Number.isFinite) && multiplier[1] !== 0
      ? multiplier[0] / multiplier[1]
      : 1;
    const tickRateValue = Number(attributeByLocalName(rootElement, "tickRate"));
    const frameRate = Number.isFinite(frameRateValue) && frameRateValue > 0 ? frameRateValue * multiplierValue : 0;
    return {
      frameRate,
      tickRate: Number.isFinite(tickRateValue) && tickRateValue > 0 ? tickRateValue : 0,
      timeBase: attributeByLocalName(rootElement, "timeBase") || null
    };
  }

  function xmlParserError(doc) {
    const errorNode = descendants(doc, "parsererror")[0] || (localName(doc.documentElement) === "parsererror" ? doc.documentElement : null);
    return errorNode ? "XML parser reported malformed input." : null;
  }

  function safeXmlPrefix(body) {
    const input = String(body || "").trimStart();
    if (/^<\?xml\b/i.test(input)) return "<?xml declaration>";
    const root = input.match(/^<([\w.-]+:)?([\w.-]+)\b/);
    if (root) return `<${root[1] || ""}${root[2]}>`;
    return input.startsWith("<") ? "<malformed markup>" : "[non-markup]";
  }

  function parseTtml(payload) {
    const body = String(payload || "");
    const diagnostics = {
      format: "TTML/DFXP",
      bodyLength: body.length,
      startsWith: safeXmlPrefix(body),
      rootElement: null,
      namespace: null,
      ttmlRootDetected: false,
      pCount: 0,
      spanCount: 0,
      brCount: 0,
      timedPCount: 0,
      untimedPCount: 0,
      nestedSpanTimingCount: 0,
      parsedCueCount: 0,
      droppedCueCount: 0,
      timingFormatsSeen: [],
      firstTimingAttributes: null,
      timeBase: null,
      frameRate: null,
      tickRate: null,
      parseError: null
    };
    let doc;
    try {
      doc = new DOMParser().parseFromString(body, "application/xml");
    } catch (error) {
      diagnostics.parseError = `XML_PARSE_ERROR: ${String(error?.message || error).slice(0, 400)}`;
      return { cues: [], diagnostics };
    }

    diagnostics.parseError = xmlParserError(doc);
    if (diagnostics.parseError) {
      diagnostics.parseError = `XML_PARSE_ERROR: ${diagnostics.parseError}`;
      return { cues: [], diagnostics };
    }

    const rootElement = doc.documentElement;
    diagnostics.rootElement = localName(rootElement) || null;
    diagnostics.namespace = rootElement?.namespaceURI || null;
    diagnostics.ttmlRootDetected = diagnostics.rootElement === "tt";
    const paragraphs = descendants(doc, "p");
    const spans = descendants(doc, "span");
    const breaks = descendants(doc, "br");
    diagnostics.pCount = paragraphs.length;
    diagnostics.spanCount = spans.length;
    diagnostics.brCount = breaks.length;
    const rates = getTtmlRates(rootElement);
    diagnostics.frameRate = rates.frameRate || null;
    diagnostics.tickRate = rates.tickRate || null;
    diagnostics.timeBase = rates.timeBase;
    const cues = [];
    const seenFormats = new Set();

    for (const paragraph of paragraphs) {
      const begin = attributeByLocalName(paragraph, "begin");
      const end = attributeByLocalName(paragraph, "end");
      const duration = attributeByLocalName(paragraph, "dur");
      if (!diagnostics.firstTimingAttributes && (begin || end || duration)) {
        diagnostics.firstTimingAttributes = { begin: begin || null, end: end || null, dur: duration || null };
      }
      const nestedSpans = descendants(paragraph, "span");
      if (nestedSpans.some((span) => attributeByLocalName(span, "begin") || attributeByLocalName(span, "end") || attributeByLocalName(span, "dur"))) {
        diagnostics.nestedSpanTimingCount++;
      }
      if (!begin) {
        diagnostics.untimedPCount++;
        diagnostics.droppedCueCount++;
        continue;
      }
      diagnostics.timedPCount++;
      const start = parseTtmlTime(begin, rates);
      const endTime = end ? parseTtmlTime(end, rates) : null;
      const durationTime = !end && duration ? parseTtmlTime(duration, rates) : null;
      [start, endTime, durationTime].filter(Boolean).forEach((parsed) => seenFormats.add(parsed.format));
      const startMs = start.milliseconds;
      const endMs = endTime ? endTime.milliseconds : durationTime ? startMs + durationTime.milliseconds : NaN;
      const text = textWithLineBreaks(paragraph);
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !text) {
        diagnostics.droppedCueCount++;
        continue;
      }
      cues.push({ startMs: Math.round(startMs), endMs: Math.round(endMs), text });
    }

    diagnostics.parsedCueCount = cues.length;
    diagnostics.timingFormatsSeen = [...seenFormats];
    if (!cues.length && !diagnostics.parseError) diagnostics.parseError = "NO_TIMED_CUES: XML parsed, but no valid timed paragraph cues were generated.";
    return { cues: cues.sort((a, b) => a.startMs - b.startMs), diagnostics };
  }

  function parseWebVtt(payload) {
    const trimmed = String(payload || "").trim();
    const cues = [];
    const blocks = trimmed.replace(/\r/g, "").split(/\n\n+/);
    for (const block of blocks) {
      const lines = block.split("\n");
      const timing = lines.find((line) => line.includes("-->"));
      if (!timing) continue;
      const [start, end] = timing.split("-->").map((part) => part.trim().split(/\s+/)[0]);
      const toMs = (value) => {
        const parts = value.replace(",", ".").split(":").map(Number);
        const seconds = parts.length === 3
          ? parts[0] * 3600 + parts[1] * 60 + parts[2]
          : parts[0] * 60 + parts[1];
        return Math.round(seconds * 1000);
      };
      const text = lines.slice(lines.indexOf(timing) + 1).join("\n").trim();
      if (text) cues.push({ startMs: toMs(start), endMs: toMs(end), text: decodeEntities(text.replace(/<[^>]*>/g, "")) });
    }
    return cues;
  }

  function parseJsonCues(trimmed) {
    try {
      const json = JSON.parse(trimmed);
      const events = json.events || json;
      if (!Array.isArray(events)) return [];
      const cues = [];
      for (const event of events) {
        const segments = (event.segs || event.textSegments || []).map((segment) => segment.utf8 || segment.text || "").join("");
        const text = segments.trim();
        const startMs = Number(event.tStartMs ?? event.startMs ?? 0);
        const durationMs = Number(event.dDurationMs ?? event.durationMs ?? 0);
        if (text && durationMs > 0) cues.push({ startMs, endMs: startMs + durationMs, text });
      }
      return cues;
    } catch (_) {
      return [];
    }
  }

  function parseCuesDetailed(payload) {
    if (!payload) return { cues: [], diagnostics: { format: "unknown", bodyLength: 0, parseError: "EMPTY_BODY" } };
    const trimmed = typeof payload === "string" ? payload.trim() : JSON.stringify(payload);
    if (/^WEBVTT/m.test(trimmed)) {
      const cues = parseWebVtt(trimmed);
      return { cues, diagnostics: { format: "WebVTT", bodyLength: trimmed.length, parsedCueCount: cues.length, parseError: cues.length ? null : "NO_CUES" } };
    }
    if (/^\s*[\[{]/.test(trimmed)) {
      const cues = parseJsonCues(trimmed);
      return { cues, diagnostics: { format: "JSON timed text", bodyLength: trimmed.length, parsedCueCount: cues.length, parseError: cues.length ? null : "NO_CUES" } };
    }
    if (/<(?:[\w.-]+:)?(?:tt|text|p)\b/i.test(trimmed)) return parseTtml(trimmed);
    return { cues: [], diagnostics: { format: "unknown", bodyLength: trimmed.length, parseError: "UNRECOGNIZED_FORMAT" } };
  }

  function parseCues(payload) {
    return parseCuesDetailed(payload).cues;
  }

  root.DualSubtitle = root.DualSubtitle || {};
  root.DualSubtitle.types = { errors, normalizeTrack, parseCues, parseCuesDetailed };
})(globalThis);
