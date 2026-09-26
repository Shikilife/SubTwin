(() => {
  const results = document.getElementById("results");
  const tests = [
    {
      name: "namespace-prefixed TTML clock time",
      input: '<tt xmlns="http://www.w3.org/ns/ttml" xmlns:tt="http://www.w3.org/ns/ttml"><tt:body><tt:div><tt:p begin="00:00:01.200" end="00:00:02.400">Hello <tt:span>world</tt:span></tt:p></tt:div></tt:body></tt>',
      expected: [{ startMs: 1200, endMs: 2400, text: "Hello world" }]
    },
    {
      name: "sanitized Netflix-like namespaced TTML structure",
      input: '<tt:tt xmlns:tt="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:timeBase="media" ttp:frameRate="25" ttp:tickRate="10"><tt:body><tt:div><tt:p begin="00:00:01:12" dur="12f">A <tt:span style="s1">[TEXT]</tt:span><tt:br/>second line</tt:p></tt:div></tt:body></tt:tt>',
      expected: [{ startMs: 1480, endMs: 1960, text: "A [TEXT]\nsecond line" }],
      diagnostic: { rootElement: "tt", pCount: 1, spanCount: 1, brCount: 1, timedPCount: 1 }
    },
    {
      name: "DFXP seconds and millisecond offsets",
      input: '<tt><body><div><p begin="1s" dur="1500ms">Timed text</p></div></body></tt>',
      expected: [{ startMs: 1000, endMs: 2500, text: "Timed text" }]
    },
    {
      name: "TTML tick offsets",
      input: '<tt xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10"><body><p begin="123t" dur="5t">Tick cue</p></body></tt>',
      expected: [{ startMs: 12300, endMs: 12800, text: "Tick cue" }],
      diagnostic: { timingFormatsSeen: ["ticks"] }
    },
    {
      name: "TTML clock offsets",
      input: '<tt><body><p begin="01:23.456" dur="12.345s">Clock cue</p></body></tt>',
      expected: [{ startMs: 83456, endMs: 95801, text: "Clock cue" }]
    },
    {
      name: "TTML without end or duration drops cue",
      input: '<tt><body><p begin="1s">No finite end</p><p begin="2s" end="3s">Finite cue</p></body></tt>',
      expected: [{ startMs: 2000, endMs: 3000, text: "Finite cue" }],
      diagnostic: { pCount: 2, timedPCount: 2, parsedCueCount: 1, droppedCueCount: 1 }
    },
    {
      name: "malformed XML has an XML parse diagnostic",
      input: '<tt><body><p begin="1s">[TEXT]</body></tt>',
      expected: [],
      errorPrefix: "XML_PARSE_ERROR:"
    },
    {
      name: "WebVTT",
      input: "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nVTT cue",
      expected: [{ startMs: 1000, endMs: 2000, text: "VTT cue" }]
    },
    {
      name: "YouTube JSON3 remains supported",
      input: JSON.stringify({ events: [{ tStartMs: 500, dDurationMs: 750, segs: [{ utf8: "JSON cue" }] }] }),
      expected: [{ startMs: 500, endMs: 1250, text: "JSON cue" }]
    }
  ];

  const output = [];
  let failed = false;
  for (const test of tests) {
    try {
      const result = DualSubtitle.types.parseCuesDetailed(test.input);
      if (JSON.stringify(result.cues) !== JSON.stringify(test.expected)) throw new Error(JSON.stringify(result.cues));
      for (const [key, value] of Object.entries(test.diagnostic || {})) {
        if (JSON.stringify(result.diagnostics[key]) !== JSON.stringify(value)) {
          throw new Error(`Expected diagnostic ${key}=${JSON.stringify(value)}, received ${JSON.stringify(result.diagnostics[key])}`);
        }
      }
      if (test.errorPrefix && !String(result.diagnostics.parseError).startsWith(test.errorPrefix)) {
        throw new Error(`Expected parseError ${test.errorPrefix}, received ${result.diagnostics.parseError}`);
      }
      output.push(`PASS ${test.name}`);
    } catch (error) {
      failed = true;
      output.push(`FAIL ${test.name}: ${error.message}`);
    }
  }
  results.textContent = output.join("\n");
  results.dataset.status = failed ? "fail" : "pass";
})();
