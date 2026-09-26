# SubTwin

A local-first dual subtitle browser extension for YouTube and Netflix. It reads only subtitle tracks and cues already supplied by the active player. It has no backend, translation, OCR, speech recognition, analytics, or telemetry.

## Load the unpacked extension

1. Open `chrome://extensions` and enable Developer mode.
2. Choose **Load unpacked** and select this project directory.
3. Open a YouTube or Netflix title with text subtitle tracks.
4. Open SubTwin from the Chrome toolbar, choose Primary and Secondary tracks, adjust each size and Y position plus max width, enable SubTwin, and press **Apply**.

Track menus are populated from the active page's adapter at runtime. YouTube track IDs and language preferences are saved locally. Netflix keeps exact track IDs only for the active playback session and persists language plus a metadata-derived variant preference when available. YouTube may use its existing first-track fallback when a preference is unavailable; Netflix leaves an ambiguous or unavailable language unset instead of picking an unrelated track.

On Netflix, a current-session track ID is matched exactly first, then persisted language and variant preference are used to locate the corresponding track in a new episode. If the preferred language is missing or its variants cannot be safely disambiguated, SubTwin leaves that line unavailable instead of selecting an unrelated track. The Popup displays an unavailable placeholder until the user chooses a track.

The development API remains available in the page DevTools Console:

```js
await dualSubtitle.status()
await dualSubtitle.listTracks()
await dualSubtitle.selectById("T:2:0;1;zh-Hant;0;0;0;0;", "T:2:0;1;en;0;0;0;0;")
await dualSubtitle.netflixTracksDebug() // Netflix only: safe metadata/classification for every raw timed-text track
await dualSubtitle.testTrackById("T:2:0;1;en;0;0;3;0;") // English [CC], user-reported candidate A
await dualSubtitle.testTrackById("T:2:1;1;en;0;0;0;0;") // English PRIMARY, user-reported candidate B
await dualSubtitle.select(0, 2) // temporary indexes from the current listTracks() result only
await dualSubtitle.select(3)
await dualSubtitle.netflixDebug() // Netflix only: sanitized player, track, transport, and parser diagnostics
```

`dualSubtitle.selectById(primaryTrackId, secondaryTrackId)` is the stable debug selection API. Numeric indexes passed to `select()` refer only to the current `listTracks()` ordering and may change when Netflix rebuilds its track list. `netflixTracksDebug()` returns summaries for all raw tracks, including filtered Off/None tracks; tokenized URLs are redacted and account-like fields are omitted. `testTrackById()` temporarily changes Netflix's selected text track to acquire cues, then attempts to restore the original track.

## Project structure

```text
manifest.json
README.md
src/
├─ content.js
├─ core/
│  ├─ subtitle-types.js
│  ├─ subtitle-engine.js
│  ├─ settings.js
│  └─ time-sync.js
├─ debug/
│  ├─ console-output.js
│  └─ page-debug-bridge.js
├─ popup/
│  ├─ popup.html
│  ├─ popup.css
│  └─ popup.js
├─ renderer/
│  ├─ subtitle-renderer.js
│  └─ subtitle-renderer.css
└─ platforms/
   ├─ youtube/
   │  ├─ page-bridge.js
   │  ├─ youtube-adapter.js
   │  ├─ youtube-native-caption-controller.js
   │  └─ youtube-native-caption.css
   └─ netflix/
      ├─ page-bridge.js
      ├─ netflix-native-caption.css
      ├─ netflix-native-caption-controller.js
      └─ netflix-adapter.js
tests/
├─ subtitle-parser.html
├─ subtitle-parser.js
└─ settings-persistence.js
```

## Popup and messaging

The popup gets the active tab ID and sends allowlisted `GET_STATUS`, `LIST_TRACKS`, `PREVIEW_SETTINGS`, and `SAVE_SETTINGS` messages to that tab's content script. Range input events are coalesced with `requestAnimationFrame`; previews update only the in-memory `activeSettings` and renderer. They never write `chrome.storage.local`. **Apply** sends the complete settings as `SAVE_SETTINGS`, which updates both `activeSettings` and `savedSettings` and writes once to local storage. Closing the popup leaves the page's active preview in place. Reopening the popup reads `activeSettings` from the content script; a page or extension reload initializes from the last saved settings. Chrome permits basic `tabs.query()` and `tabs.sendMessage()` without the broad `tabs` permission; this PoC does not read tab URL/title. [Chrome Tabs API permissions](https://developer.chrome.com/docs/extensions/reference/api/tabs), [Chrome permission troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting).

Content script commands are allowlisted and validate selected track IDs. Settings use `chrome.storage.local` and contain only enabled state, language and metadata-derived Netflix variant preferences, font scales, independent Y positions, and maximum subtitle width. Netflix track IDs remain in active page memory and are cleared from persisted settings; across titles the extension rematches language plus a variant fingerprint when metadata supports one. Subtitle cues and intercepted response text are held only in bounded page memory for the current Netflix playback session; they are never written to persistent storage. Video URLs/titles and viewing history are not stored.

The MAIN-world `window.dualSubtitle` object is a thin Promise-based debug bridge. It forwards only `GET_STATUS`, `LIST_TRACKS`, and `SELECT_TRACKS`; subtitle logic remains in the isolated content script.

## Renderer and native captions

`SubtitleRenderer` is platform-neutral. The platform adapter supplies an overlay container; YouTube uses `#movie_player`, so the overlay remains a child of the player in normal, theater, and fullscreen layouts. Netflix chooses the fullscreen element when it contains the active video, otherwise the nearest video ancestor whose bounds cover the video. One overlay host is reused and reparented when the selected player container changes; content-script lifecycle polling and fullscreen events call the same mount path. Each subtitle line is independently absolutely positioned with `left: 50%`, `transform: translate(-50%, -50%)`, and its own center Y coordinate. Equal Y values can overlap by design. Requested Y positions are clamped inward by half the rendered cue height plus an 8px safety inset, so multiline cues stay within the player where their height permits.

The Popup exposes font scales from 30% to 200% in 5% steps, separate Y positions from 0% to 100% in 1% steps, and max width from 40% to 100%. Defaults are Primary/Secondary size 100%/90%, Y 72%/84%, and max width 90%. Range readouts and the overlay update while dragging; **Apply** explicitly saves the complete settings. Renderer font size scales from the player width (`2.4%` of width for Primary and `2.1%` for Secondary, multiplied by the requested scale) with a 6px minimum and 64px maximum. Max width is capped at the selected percentage and the player width minus 24px. Long cues wrap within that width.

When SubTwin is enabled with a selected YouTube Primary track, `YouTubeNativeCaptionController` adds a player-scoped class that sets the native `.ytp-caption-window-container` to `display:none`. It does not disable native captions, change tracks, or intercept/block subtitle requests; the player continues to provide cues to the adapter. If YouTube changes that caption container selector, the native line may remain visible. The visual hiding behavior still needs verification against the current YouTube player.

Netflix native caption suppression is isolated in `NetflixNativeCaptionController`. A Netflix-only stylesheet is injected at `document_start`; it hides `.player-timedtext` and `.player-timedtext-text-container` while SubTwin is enabled. A boot class suppresses captions until `chrome.storage.local` reports the saved enabled state, reducing the insertion/MutationObserver paint race. The controller also keeps its observer and inline-style fallback for replacement nodes. It never calls `setTextTrack(off)`. These private Netflix selectors must be rechecked against the current player. The early stylesheet and no-flash behavior have not been live-verified in this workspace.

## Permissions and local behavior

- `storage`: saves the user's small set of display preferences in `chrome.storage.local`.
- Site match patterns: content scripts run only on `https://www.youtube.com/*` and `https://www.netflix.com/*`.
- No `tabs`, `cookies`, `history`, `debugger`, clipboard, or broad host permission is requested.
- The renderer CSS is the only web-accessible extension resource, and is exposed only to the two supported site patterns.
- The extension makes no backend or third-party requests. The platforms continue their normal playback/subtitle requests.

## Implementation and verification status

The previous YouTube PoC's dual-cue acquisition was reported as PASS in the user's playback environment. This GUI/overlay stage has not yet been exercised in that playback environment. The current workspace browser inventory has no YouTube or Netflix test tab, so no live UI or playback result is claimed here.

| Area | Status | Evidence / remaining check |
| --- | --- | --- |
| Live slider preview | PARTIAL | Range `input` events are coalesced per animation frame and send only visual fields through `PREVIEW_SETTINGS`; verify movement/resize in a live YouTube player. |
| No storage spam | PARTIAL | `PREVIEW_SETTINGS` contains no storage write; explicit saves use `SAVE_SETTINGS`. Verify live while scrubbing and inspect storage if needed. |
| Popup reopen sync | PARTIAL | `GET_STATUS` returns active and saved settings; Popup initializes controls from active settings. Verify after an unsaved preview in Chrome. |
| Reload restore saved | PARTIAL | Content script initializes active settings from `chrome.storage.local`; preview does not persist. Verify preview/reload and save/reload in Chrome. |
| Popup GUI | PARTIAL | Native HTML/CSS/JS and range controls implemented; reload extension and open the popup to verify. |
| Dynamic track dropdown | PARTIAL | Menus are built from adapter track metadata; verify the reported six-track video and a different video. |
| Smaller font size | PARTIAL | 30–200% settings clamp and responsive player-width calculation verified locally; verify appearance in playback. |
| Independent Y position | PARTIAL | Per-line center positions and safe edge clamping implemented; verify with one-, two-, and three-line cues. |
| No layout collision | PARTIAL | Lines use independent absolute positioning and do not affect each other's layout; same-Y overlap remains intentionally allowed. |
| Max width | PARTIAL | 40–100% width limit and line wrapping implemented; verify with a long English cue. |
| Dual overlay | PARTIAL | Renderer consumes current engine cues; verify actual on-video text in playback. |
| Playback sync | PARTIAL | Renderer samples engine time-synced cues during playback; live 30-second check remains. |
| Seek | PARTIAL | Current-time lookup is seek-based; verify a large seek in the player. |
| Theater mode | PARTIAL | Overlay is mounted inside `#movie_player`; verify live layout. |
| Fullscreen | PARTIAL | Overlay is inside the fullscreen player element; verify live layout. |
| SPA navigation | PARTIAL | Route changes reset/reinitialize the engine and reuse the overlay; verify without reloading. |
| Native caption handling | PARTIAL | YouTube visual suppression remains unchanged. Netflix uses reversible, player-scoped `visibility` changes without switching tracks; verify the private selector and cue continuity live. |
| Netflix cue acquisition | PASS (user-reported live results) | In the latest title, zh-Hant produced 444 cues; English ASSISTIVE/CLOSEDCAPTIONS produced 510 and English PRIMARY/SUBTITLES produced 437. Both candidates passed selection, request, response and parse. |
| Netflix variant labels and preference | PARTIAL | Metadata-based `[CC]` labeling, PRIMARY-first language fallback, variant fingerprint persistence and Popup disambiguation are implemented and statically checked; verify in a live Netflix Popup. |
| Netflix overlay, Popup and lifecycle | PARTIAL | Netflix session reinitialization, container reattach, and native-caption controller remain unverified in live playback. |

`tests/subtitle-parser.html` is a dependency-free browser harness for namespace-prefixed TTML/DFXP, WebVTT, and YouTube JSON3 parsing. Open it locally in a browser to run those format checks. It does not establish which format Netflix currently serves.

Run `node tests/settings-persistence.js` to check the platform-specific storage contract: YouTube exact track IDs are retained, Netflix exact IDs are omitted, Netflix language/variant preferences are retained, and legacy Netflix IDs are ignored during restoration. This does not exercise Chrome `storage.local` or live Netflix rematching.

Netflix uses a MAIN-world bridge injected at `document_start` to probe the current player session and its timed-text track metadata. It observes page `fetch`/XHR subtitle responses and keeps matching response bodies in a bounded, in-memory, session-scoped cache (8 MiB, 64 entries, up to 12 per track). No subtitle text is written to storage or sent off-device. The isolated adapter can query this cache after it initializes, so a response captured before adapter startup is not lost. Request attribution snapshots the native selected track at request time, or the SubTwin-requested track for an internal acquisition. On a session change the raw-response cache and parsed cue cache are cleared.

Netflix cue acquisition is cache-first: parsed cues, then captured raw responses, then player track selection only when neither cache has usable data. Internal acquisition snapshots the current native track and attempts to restore it after both requested tracks have been processed. Cache hits avoid changing Netflix's active track. Each newly requested track gets a 4.5 second response timeout; a Primary timeout does not prevent attempting Secondary. Diagnostics include bridge/player timestamps, early capture and cache-hit counters, native track snapshot/restore IDs, and suppression state. Caption flash detection is explicitly manual-only. These changes have only received static checks here; there is no authenticated Netflix page in this workspace to verify real cache hits, cue output, or track restoration.

Local checks performed here: JavaScript syntax, Manifest JSON, normalization bounds, and a static check that slider previews do not write storage. These checks do not replace loading the extension in Chrome and running the playback scenarios above.

## Known limitations

- YouTube player APIs and caption DOM selectors are private implementation details and can change.
- The current YouTube native-caption hide rule depends on `.ytp-caption-window-container`.
- Netflix APIs and caption DOM selectors remain private and may change. The latest user-reported live playback confirms both zh-Hant and English cue acquisition (1410 / 1214 cues); this workspace has no authenticated Netflix tab for retesting.
- Netflix native-caption suppression uses visual `visibility` changes on private timed-text containers. It is isolated and reversible, but needs live verification to confirm the current selector and that cue acquisition continues while captions are hidden.
- Cue availability can depend on which timed-text segments the platform has loaded in the current playback session.
- If the title offers only one text track, the secondary line remains empty; SubTwin never generates another subtitle.
