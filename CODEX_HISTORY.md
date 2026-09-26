# SubTwin Codex History

Last audited: 2026-09-26. Earlier implementation dates were not recorded in the project history, so historical decisions below are not assigned invented dates.

## Project Rules

- Local-first: subtitle data is processed in the browser; no SubTwin backend.
- Subtitle export is allowed only as an explicit user-triggered local action. Export only subtitle tracks/cues already supplied by the active platform. Do not translate, generate, infer, OCR, or upload subtitle content.
- Do not add telemetry, analytics, login, or external subtitle services.
- Read only subtitle tracks and cues offered by the platform. Never invent a second track when a title has only one.
- Keep permissions minimal. Current manifest permission is `storage`; supported page matches are YouTube and Netflix.
- Keep the shared core platform-neutral. YouTube and Netflix player APIs, caption suppression, and lifecycle handling belong in their platform folders.
- Prefer player metadata and platform subtitle responses over subtitle DOM scraping.
- Do not modify a subsystem with user-reported LIVE PASS without a concrete regression reason.
- Distinguish `LIVE PASS`, `STATIC PASS`, `PARTIAL`, `FAIL`, and `NOT TESTED`. Syntax or source inspection alone never means a feature passed live playback.
- Subtitle overlay output uses `textContent`; it must not render subtitle text as HTML. Overlay must not intercept pointer input.

## Current Architecture

### Shared Core

- `src/core/subtitle-types.js`: normalizes tracks and parses YouTube JSON timed text, WebVTT, and TTML/DFXP, including namespaced elements and TTML timing units.
- `src/core/time-sync.js`: time-to-cue lookup shared by platforms.
- `src/core/subtitle-engine.js`: common track selection, cue loading, logging, sync timer, and snapshot interface.
- `src/core/settings.js`: clamps and normalizes shared visual preferences.
- `src/core/settings.js` also owns a platform-aware storage contract: YouTube track IDs may persist; Netflix persists only language and variant fingerprints. Netflix exact IDs remain in the current content-script runtime.
- `src/renderer/`: one platform-neutral renderer. The adapter supplies its player container. Each cue line is independently positioned; text and background are wrapped separately.
- `src/popup/`: dynamic track choices are requested from the active tab's content script. Visual range input sends `PREVIEW_SETTINGS`; `SAVE_SETTINGS` / Apply persists the complete settings object.
- `src/export/subtitle-exporter.js`: formats already-acquired normalized cues into a local Markdown file; Popup export acquisition runs in the content script and keeps its job/result in page memory only.
- `src/content.js`: exact-host routing, popup/debug command allowlist, platform settings storage, and the selected adapter's lifecycle.

### YouTube

- Manifest runs `src/platforms/youtube/page-bridge.js` in MAIN world at `document_start`; the isolated YouTube adapter and shared content bundle run at `document_idle`.
- The page bridge reads the player response/caption track metadata, asks the player to select its native tracks, and observes timed-text fetch/XHR responses. Subtitle request construction is left to the player.
- `YouTubeAdapter` supplies `#movie_player` as renderer host and owns its message listener and pending cue requests.
- `YouTubeNativeCaptionController` is YouTube-only and hides the native visual caption container through a player-scoped class. It does not turn off the data track.
- `ensureYouTubeReady()` is re-entrant and guarded by an in-flight promise. It waits for the playback route, video, player, and caption tracks; retries with 250/500/1000/1500/2000 ms capped backoff; responds to YouTube navigation/page-data events, DOM late mount, URL/video/source changes, and early popup status/track queries.
- YouTube debug status includes startup state, attempt count, triggering reason/time, current video key, player/video/track readiness, and in-flight state. The current video key excludes media URL query parameters.

### Netflix

- Manifest runs `src/platforms/netflix/page-bridge.js` in MAIN world at `document_start`; Netflix-only content and native-caption scripts match Netflix pages only.
- The bridge probes Netflix player session and timed-text track metadata and wraps page `fetch` / XHR to observe subtitle responses. It snapshots request-time track attribution rather than reading the selected track only when the response returns.
- Netflix timed text is parsed as TTML/DFXP using real-response-tested tick timing and namespace-aware parsing. The shared parser is used only for the common cue shape; Netflix acquisition and track policy stay in `netflix-adapter.js` / the page bridge.
- Same-language variants remain separate tracks. The current policy uses metadata (for example PRIMARY/SUBTITLES and ASSISTIVE/CLOSEDCAPTIONS) and stable current-session track IDs; it does not infer variant meaning from digits in Netflix IDs. Cross-title matching uses language plus metadata fingerprint. The 2026-09-26 serializer fix below enforces session-only exact IDs.
- Cue acquisition is cache-first: parsed cue cache, early raw response cache, then temporary player track selection on cache miss. The bridge raw response cache is memory-only and bounded to 8 MiB, 64 entries, and 12 entries per track; session changes clear it. Early responses without an identified session are associated with the first detected session.
- When temporary track selection is required, the adapter snapshots and attempts to restore Netflix's original native track. This and cache-first operation are implemented but still need current live regression testing.
- `NetflixNativeCaptionController` and its CSS are isolated from YouTube. Document-start CSS suppresses native visual captions while enabled; the controller retains a MutationObserver/inline visibility fallback. It does not select the Off track. Current selector and no-flash behavior require live verification.

## Live Verified Status

Evidence in this section is based on results the user reported in the development conversation. The current audit environment has no YouTube or Netflix playback tab, so no new live result was produced on 2026-09-26.

### YouTube

| Feature | Status | Evidence |
| --- | --- | --- |
| Track discovery | LIVE PASS | User reports dynamic track list works on real YouTube playback. |
| Dual cue acquisition / playback sync | LIVE PASS | User reports both existing subtitle cues update together during playback. |
| Overlay | LIVE PASS | User reports dual subtitle overlay is visible in playback. |
| Font size, independent Y, max width | LIVE PASS | User reported the overlay controls had good real-playback effect. |
| Background opacity | LIVE PASS | User's latest stated YouTube live status explicitly marks opacity PASS. |
| Native caption visual suppression | PARTIAL | Controller and CSS exist; current live behavior is not established by this audit. |
| Fresh entry / no-F5 initialization | LIVE PASS (user-reported) | User reports the initial-startup issue was fixed. |
| Home → watch, A → B, repeated navigation | PARTIAL | Lifecycle handling exists; these individual paths were not separately evidenced as live tests. |
| Popup live preview / Apply persistence | PARTIAL | Implemented and documented; no specific live evidence for every reopen/reload scenario. |

### Netflix

| Feature | Status | Evidence |
| --- | --- | --- |
| Player and track discovery | LIVE PASS | User reported real playback player detection and timed-text track listing. |
| XHR subtitle interception / track attribution | LIVE PASS | User reported XHR response observation and correct request-time track attribution. |
| TTML/DFXP parser | LIVE PASS | Real Netflix diagnostics reported namespace `http://www.w3.org/ns/ttml`, tickRate 10,000,000, 1,250 cues parsed with 0 dropped; another title parsed 444 cues. |
| zh-Hant / zh-Hans cues | LIVE PASS | User reported 1,410 zh-Hant and 1,250 zh-Hans cues in one title; 444 zh-Hant in another. |
| English variants | LIVE PASS | User reported English PRIMARY/SUBTITLES at 437 cues and ASSISTIVE/CLOSEDCAPTIONS at 510 cues; both passed selection, response, parsing, and cue generation. Another title produced 1,214 English cues. |
| Dual cue acquisition | LIVE PASS | User reported simultaneous zh-Hant and English cues. |
| Variant classification and Popup choice | PARTIAL | Metadata-based classification/policy and dynamic variant display exist; current live Popup interaction was not evidenced in this audit. |
| Early capture, cache-first acquisition | PARTIAL | Bounded document-start cache and cache-first flow exist; README says these changes have only static checks here. |
| Native track restore | PARTIAL | Snapshot/restore path exists; no live restore result in current evidence. |
| Native caption suppression / no flash | PARTIAL | Document-start CSS and fallback exist; no current live no-flash/cue-continuity result. |
| Overlay, opacity, seek, fullscreen, episode lifecycle | PARTIAL | Shared renderer and lifecycle paths exist; these Netflix UI/lifecycle paths are not live-verified in current workspace evidence. |

## Important Decisions

### Prior sessions — use only player-provided subtitles

Problem: A product request could otherwise be interpreted as permission to create a missing second language.

Decision: SubTwin only reads subtitle tracks already offered by YouTube or Netflix. A missing secondary track remains empty.

Reason: This is the project's core scope and local-first privacy boundary.

Files: Platform adapters, core engine, and README.

Validation: User-reported live cue acquisition on both platforms; exact feature evidence is in the tables above.

Remaining risk: Platform APIs and cue availability vary by title and session.

### Prior sessions — split platform-specific state and lifecycles

Problem: Netflix-specific lifecycle work caused a YouTube regression when shared injection and listeners crossed platform boundaries.

Decision: The manifest gives each site its own adapter/controller bundle and host match. Content initialization selects an adapter by exact hostname; YouTube-only navigation/DOM handlers and Netflix-only session/fullscreen handlers are guarded separately. Track preferences are stored under platform-specific keys; visual settings remain shared.

Reason: Shared cue types, settings, engine, and renderer are useful, but player APIs and lifecycle must not leak across platforms.

Files: `manifest.json`, `src/content.js`, `src/platforms/youtube/`, `src/platforms/netflix/`.

Validation: STATIC PASS for manifest matches/bundles and routing guards. The then-current audit found Netflix IDs were written into the platform key; the 2026-09-26 serializer fix below resolves that separate persistence issue. No live cross-platform regression run was available.

Remaining risk: `content.js` remains a shared coordinator, so future event handlers must retain explicit platform guards.

### Prior sessions — Netflix one-active-track behavior and cache-first acquisition

Problem: Netflix player selection is not assumed to support two simultaneously active native tracks. Also, selecting a track can succeed without producing a new request when Netflix has already loaded/cached its subtitle.

Decision: Treat the Netflix player as a source to acquire one track at a time; obtain the other cue data through observed/cached resources. Start response observation at `document_start`, cache eligible response bodies in bounded page memory, try parsed/raw cache before changing tracks, snapshot the original native selection, and attempt restoration after cache-miss acquisition.

Reason: A missing new XHR is not necessarily a parser or track-selection failure; the resource may predate adapter initialization.

Files: `src/platforms/netflix/page-bridge.js`, `src/platforms/netflix/netflix-adapter.js`.

Validation: Request interception and TTML cue parsing are LIVE PASS by user report. Early-cache hit and native-track restoration remain PARTIAL / not live reverified here.

Remaining risk: Netflix internal APIs, attribution metadata, and cache/session timing can change.

### Prior sessions — classify Netflix variants only from metadata

Problem: More than one usable track can share `language=en`; choosing the first by language can select the wrong variant or leave the secondary empty.

Decision: Preserve each track ID as an independent choice, show disambiguated labels, use observed metadata such as PRIMARY/SUBTITLES or ASSISTIVE/CLOSEDCAPTIONS where present, and never infer meaning from opaque ID digits.

Reason: Both English variants in a live title produced different, usable cue sets (437 and 510 cues).

Files: `src/platforms/netflix/page-bridge.js`, `src/platforms/netflix/netflix-adapter.js`, `src/content.js`, `src/popup/popup.js`.

Validation: Both candidate cue sets are LIVE PASS by user report. Popup choice itself remains PARTIAL pending live UI evidence.

Remaining risk: Metadata may be missing or change across Netflix titles; ambiguous variants should remain user-selectable.

### Prior sessions — native caption suppression is visual only

Problem: MutationObserver-only hiding allowed native Netflix text to paint briefly; switching to Off could disrupt data acquisition.

Decision: Use Netflix-only document-start CSS and reversible visibility fallback; do not call `setTimedTextTrack(off)` to hide native captions. YouTube has a separate player-scoped controller.

Reason: Suppress duplicate visual text without intentionally disabling the platform's subtitle data source.

Files: `src/platforms/netflix/netflix-native-caption.css`, `src/platforms/netflix/netflix-native-caption-controller.js`, `src/platforms/youtube/youtube-native-caption.css`, `src/platforms/youtube/youtube-native-caption-controller.js`.

Validation: STATIC PASS for platform scoping; live no-flash and continued-cue behavior are PARTIAL.

Remaining risk: `.player-timedtext` and `.ytp-caption-window-container` are private selectors.

### 2026-09-26 — make YouTube startup retryable and SPA-aware

Problem: First entry into a YouTube watch page could leave SubTwin uninitialized until F5.

Decision: Make startup re-entrant with an in-flight guard, retry/backoff, watch/video/player/track readiness checks, YouTube navigation/page-data events, DOM late-mount observation, source/video identity detection, and startup diagnostics. Popup status/track queries also kick readiness. Failed temporary adapters are destroyed.

Reason: YouTube is an SPA; a one-shot page-load initializer is not sufficient.

Files: `src/content.js`, `src/platforms/youtube/youtube-adapter.js`.

Validation: JavaScript syntax passed in the workspace. User reports the initial/F5 issue is resolved (LIVE PASS, user-reported); detailed navigation scenarios were not rerun in this audit.

Remaining risk: YouTube player response timing and internal caption metadata remain private implementation details.

### Prior sessions — separate visual preview from persistence

Problem: Range drags can emit many changes and should not write storage for every input event.

Decision: `PREVIEW_SETTINGS` updates only in-memory active settings/renderer; `SAVE_SETTINGS` / Apply persists. Shared settings include independent sizes/Y positions, max width, and background opacity (0–100%, default 65%).

Reason: Preview should remain visible after Popup close while reload returns to the last saved settings.

Files: `src/popup/popup.js`, `src/content.js`, `src/core/settings.js`, `src/renderer/subtitle-renderer.js`, `src/renderer/subtitle-renderer.css`.

Validation: Code path is documented and locally statically checked in README; complete live save/reload scenarios remain PARTIAL unless separately reported.

Remaining risk: Keep visual preview fields within the normalizer and avoid persisting subtitle content.

### 2026-09-26 — Local Markdown subtitle export added

Problem / Request: Allow users to explicitly export one or more platform-provided subtitle tracks from the current YouTube video or Netflix episode as Markdown.

Decision: Add a shared formatter and dynamic track checkboxes keyed by exact track IDs. Run cue acquisition as a content-script job so Popup closure does not cancel it; reuse adapter cue caches first, acquire only missing tracks, preserve partial successes, and let the Popup download the completed Markdown using a local Blob and anchor. YouTube attempts to snapshot and restore its native caption selection around uncached acquisition; Netflix uses its existing cache-first `selectTracks()` path and native-track restoration.

Architecture: Adapter methods supply complete normalized cues; `src/export/subtitle-exporter.js` owns per-track Markdown sections, timestamps, and filename sanitization. Job state, title, cues, and generated Markdown remain in current page memory and are cleared on playback route/session reset. Only the user's explicit Popup action starts export. No additional permissions or network calls were added.

Privacy boundary: Exports include only cues already exposed by the active platform. No translation, generation, inference, OCR, upload, persistent title/history, or cue storage is used.

Files: `src/export/subtitle-exporter.js`, `src/platforms/youtube/youtube-adapter.js`, `src/platforms/youtube/page-bridge.js`, `src/platforms/netflix/netflix-adapter.js`, `src/content.js`, `src/popup/`, `manifest.json`, `tests/subtitle-exporter.js`, README, and this history.

Validation: `node tests/subtitle-exporter.js`, `node tests/settings-persistence.js`, JavaScript syntax checks, and Manifest JSON/permission/script-inclusion checks passed (STATIC PASS). The manifest still requests only `storage`. No live YouTube or Netflix extension runtime was available for export verification; platform cue acquisition, native selection restoration, Popup interaction, and browser Blob download remain NOT TESTED live.

Remaining risks: YouTube's private `getOption("captions", "track")` snapshot and restoring a null native track may vary by player version. Netflix export depends on current-session parsed/raw cache and its existing private selection/restore APIs. A very long transcript is temporarily held in page memory and returned to the Popup for download.

### 2026-09-26 — Netflix exact Track IDs made session-only

Problem: The generic storage splitter copied Netflix `primaryTrackId` and `secondaryTrackId` into `subTwinSettings.netflix.tracks`, despite the session-only ID policy and README contract.

Root cause: A shared blind-copy list applied YouTube and Netflix persistence rules identically.

Decision: Add platform-aware serialization and restoration in the settings module. YouTube keeps its exact ID/language preferences. Netflix stores only language and metadata-derived variant preferences; its runtime `activeSettings` retains exact current-session IDs. Loading old Netflix settings ignores IDs and, when legacy ID keys are present, rewrites the sanitized settings without resetting visual/language/variant preferences. Manual Netflix selection refreshes the language and variant fingerprint before persistence.

Files: `src/core/settings.js`, `src/content.js`, `tests/settings-persistence.js`, and README test documentation. README's existing persistence policy was already correct and remains unchanged.

Validation: `node tests/settings-persistence.js` passed, covering YouTube ID retention, Netflix ID omission, preference retention, and stale Netflix ID migration. JavaScript syntax checks passed. Chrome `storage.local` and live Netflix reload/rematch were not available, so those remain unverified live.

Remaining risk: Confirm real Chrome storage contents and a new Netflix playback session rematching by language plus variant before packaging.

### 2026-09-26 — Markdown export request-lifecycle regression

Symptom: YouTube `routeChanged()` cleanup threw `pending.reject is not a function`; Popup export failures collapsed to the generic “The player did not respond” message on both platforms.

Root cause: YouTube cue waits were stored in `pending` as `{ resolve, timer }`, while `destroy()` unconditionally called `reject()`. These cue waiters were separate from `bridgeRequests` (which already had resolve/reject callbacks), so this was an inconsistent cue-waiter contract, not export requests mixed into one map. The Popup also replaced an empty/missing content-script response with a generic message, hiding whether the failure was a missing receiver or a closed message channel. Source audit confirmed the 900 ms retry is restricted to YouTube `GET_STATUS`/`LIST_TRACKS`; export start returns a job ID immediately and is not awaited inside that short wait.

Fix: Give each YouTube cue waiter a consistent `{ resolve, reject, timer, trackId, purpose, promise }` shape, reuse an existing waiter for the same track, and settle/clear both cue and bridge maps defensively so `destroy()` is idempotent and non-throwing. Keep the maps separate by purpose. The content message listener schedules command dispatch through a Promise before handling errors and returns `true` to keep the async response channel alive. Export remains a content-side job with per-track adapter timeouts (YouTube 15 s, Netflix's existing 4.5 s acquisition timeout), status polling, and no Popup-side hard timeout. Missing message responses now report `PLAYER_NOT_READY` or `MESSAGE_CHANNEL_CLOSED` instead of the generic fallback; track failures retain `EXPORT_TIMEOUT` / `TRACK_ACQUISITION_FAILED` codes. Export acquisition does not call `SubtitleEngine.select()` or change its Primary/Secondary IDs.

Files: `src/platforms/youtube/youtube-adapter.js`, `src/content.js`, `src/popup/popup.js`, `src/platforms/netflix/netflix-adapter.js`, `tests/youtube-adapter-lifecycle.js`, README, and this history.

Validation: Static adapter lifecycle tests cover cue/bridge pending entry shapes, malformed pending cleanup, idempotent `destroy()`, and rejection settlement. Export message start/poll routing and absence of the 900 ms wrapper were source-audited. Live YouTube SPA/export, Netflix export/native restore, and browser download remain NOT TESTED in this environment.

Do not repeat: Long-running export jobs must not reuse short popup/status timeouts. Adapter pending request maps must have a consistent entry contract and remain separated by purpose.

## Known Regressions / Lessons

### YouTube first-entry initialization

Symptom: Initial watch-page entry could fail while F5 worked.

Root cause direction: Content code could run before player/caption tracks were ready, with no reliable SPA-aware retry path.

Fix: `ensureYouTubeReady()`, state diagnostics, bounded-backoff retry, DOM/player observation, YouTube navigation events, and in-flight deduplication.

Do not repeat: Do not rely only on `window.load`, `DOMContentLoaded`, or one initialization call.

### Netflix same-language tracks

Symptom: English cue count appeared zero or no English secondary was selected despite usable English tracks.

Root cause: Netflix can expose multiple variants for one language, and track ordering/selection timing varies. A language-only first-match policy is insufficient.

Fix: Preserve track IDs, classify from available metadata, allow explicit variant selection, cache each candidate's cues.

Do not repeat: Do not treat one English variant as invalid because another has a different cue count; do not infer ID-number semantics.

### Netflix selected track with no new XHR

Symptom: Setter reported success but SubTwin timed out waiting for a response.

Root cause direction: Netflix may have fetched the subtitle before SubTwin began observing or may reuse internal cache.

Fix: document-start observation and cache-first acquisition; classify missing observation separately from parse failure.

Do not repeat: A successful setter does not prove a new request will occur; zero new requests does not prove the resource is unavailable.

### Netflix native caption flash

Symptom: Native caption briefly painted before MutationObserver hid it.

Root cause: Observer callback runs after node insertion/possible paint.

Fix: document-start CSS suppression first; observer is fallback. Never use Off-track selection solely for visual hiding.

Do not repeat: Do not rely only on post-insertion DOM mutation to suppress the first paint.

### Cross-platform regression

Symptom: Netflix changes affected YouTube.

Root cause: Platform bundles/listeners were not sufficiently isolated.

Fix: host-specific manifest bundles and explicit platform guards; keep only shared core and renderer common.

Do not repeat: Do not initialize both adapters/controllers or attach the other platform's lifecycle listener on a page.

## Current Open Issues

- **Final v0.1 live regression remains unrun:** On 2026-09-26 the available browser inventory contained only an empty Codex In-app Browser, with no accessible Chrome extension runtime, YouTube/Netflix playback tabs, authenticated Netflix session, or Chrome storage inspection surface. Do not proceed to packaging based on this audit. Run the live checklist in Chrome and update each item with observed evidence.
- Markdown subtitle export has static formatter/contract checks, but Popup operation, YouTube cue acquisition/native selection restoration, Netflix cache-first export/native track restoration, and Blob download have not been live tested in Chrome.
- Netflix cache-first behavior, native track restoration, native-caption no-flash, and episode/fullscreen overlay reattachment need current live regression evidence.
- YouTube native-caption suppression selector and current SPA routes need live verification beyond the user-reported initial/F5 fix.
- Popup preview/persistence reopen and reload behavior should be covered in a repeatable release checklist.
- Parser entity-decoding implementation uses a `textarea.innerHTML` assignment; review whether it can be replaced with a safer decoder while preserving entity handling. Renderer output itself uses `textContent`.
- Opaque YouTube/Netflix player APIs and caption selectors can change without notice.

## v0.1 Regression Audit

| Area | Status | Audit evidence |
| --- | --- | --- |
| Shared Core isolation | STATIC PASS | Shared cue types, time sync, settings, engine, renderer; adapters provide platform player containers. |
| YouTube isolation | STATIC PASS | YouTube-only manifest match/bundle and guarded navigation/observer lifecycle. |
| Netflix isolation | STATIC PASS | Netflix-only bridge, adapter, native-caption CSS/controller, and session/fullscreen lifecycle. |
| Manifest scope | STATIC PASS | Only `storage` permission; page matches limited to YouTube and Netflix; no cookies/history/debugger/`<all_urls>`. |
| Settings separation | STATIC PASS | Platform-aware serializer keeps YouTube IDs and omits Netflix IDs; `tests/settings-persistence.js` verifies serialization and legacy-ID restoration filtering. Chrome storage and live Netflix rematching remain unverified. |
| Renderer security/interaction | STATIC PASS | Overlay uses text nodes/`textContent`, a closed Shadow DOM, and `pointer-events: none`; see entity-decoding cleanup candidate above. |

### Final Live Regression Attempt — 2026-09-26

No live test was run: the only available browser was an empty Codex In-app Browser. There was no accessible Chrome instance with the unpacked extension loaded, no YouTube/Netflix player tab, and no way to inspect `chrome.storage.local`. These are `NOT TESTED`, not `FAIL`. Earlier user-reported live PASS results remain recorded above and are not represented as retested in this attempt.

| Checklist area | Status this attempt | Evidence |
| --- | --- | --- |
| YouTube fresh load, tracks, dual cue, overlay | NOT TESTED | No YouTube playback tab or extension runtime available. |
| YouTube native captions, opacity, preview, persistence | NOT TESTED | No live Popup/player surface available. |
| YouTube SPA A→B and fullscreen/theater | NOT TESTED | No live YouTube surface available. |
| Netflix player/tracks/variants/dual cue | NOT TESTED | No Netflix playback tab available. |
| Netflix cache-first / native flash / track restore / disable restore | NOT TESTED | No authenticated Netflix player or live diagnostics available. |
| Netflix overlay / opacity / seek / fullscreen / episode change | NOT TESTED | No Netflix playback tab available. |
| Chrome storage contents and Netflix reload rematch | NOT TESTED | No Chrome DevTools or extension storage inspection surface available. |
| Cross-platform return to YouTube after Netflix | NOT TESTED | Neither platform was open in a testable browser. |

Static check repeated during this attempt: `node tests/settings-persistence.js` passed. This confirms the pure serializer/restore contract only; it does not validate Chrome storage writes or live rematching.

### YouTube v0.1 checklist

| Feature | Status | Evidence |
| --- | --- | --- |
| Track discovery | LIVE PASS | User reported. |
| Dual cue | LIVE PASS | User reported. |
| Overlay | LIVE PASS | User reported. |
| Native caption | PARTIAL | Implementation exists; current visual behavior not reverified. |
| Initial startup without F5 | LIVE PASS (user-reported) | User reports issue fixed. |
| Home → watch / A → B SPA cases | PARTIAL | Lifecycle support is statically present; individual cases not reverified. |
| Background opacity | LIVE PASS | User explicitly reported YouTube live PASS. |
| Size / Y / max width | LIVE PASS | User reported real playback effect as good. |
| Live preview | PARTIAL | Implemented; full live interaction not evidenced in this audit. |
| Apply persistence | PARTIAL | Storage path exists; reload persistence not reverified here. |

### Netflix v0.1 checklist

| Feature | Status | Evidence |
| --- | --- | --- |
| Track list | LIVE PASS | User reported real-player track discovery. |
| Variant metadata classification | LIVE PASS | Raw metadata identified PRIMARY/SUBTITLES and ASSISTIVE/CLOSEDCAPTIONS in real playback. |
| Variant Popup choice | PARTIAL | Dynamic variant UI exists; current Popup interaction was not live-verified here. |
| Dual cue | LIVE PASS | User-reported live cue counts above. |
| Early capture | PARTIAL | `document_start` hooks exist; current live capture timing not reverified. |
| Cache-first acquisition | PARTIAL | Parsed/raw cache-first code exists; live cache-hit test not evidenced. |
| Native track restore | PARTIAL | Implemented, not live-verified. |
| Native caption suppression | PARTIAL | CSS/controller exist; no-flash and cue continuity not live-verified. |
| Overlay | PARTIAL | Shared renderer path exists; Netflix live rendering not evidenced in current report. |
| Background opacity | PARTIAL | Shared renderer path exists; Netflix live opacity test not evidenced. |
| Episode lifecycle | PARTIAL | Session-change handling exists; episode-change live test not evidenced. |

## Cleanup Candidates

Listed for a later deliberate cleanup; no cleanup was performed in this audit.

- `src/core/subtitle-types.js`: `decodeEntities()` assigns subtitle-derived text to a temporary textarea via `innerHTML`. Review/replace with a safe entity decoder, preserving WebVTT entity support.
- `src/content.js`: `setYouTubeStartupState(state, reason)` currently does not use its `reason` parameter.
- `src/content.js`: `youtubeObserver` is stored but not later disconnected or otherwise read; decide whether a page-lifetime observer is intentional or simplify ownership.
- `src/content.js`: the shared `initializing` flag is still used by Netflix's legacy initializer, while YouTube now uses `youtubeInitPromise`; consider making the state explicitly platform-scoped during a future focused refactor.
- `src/content.js`: YouTube initialization writes `lastInitError`, but `publicStatus()` exposes that field only for Netflix; decide whether to expose a YouTube-specific retryable/fatal diagnostic or remove the stale write.
- Repeated page-debug bridge methods and debug-only Netflix helpers should be retained unless their callers are audited; do not remove them as part of routine cleanup.

## Next Recommended Work

- v0.1 stabilization / packaging / release readiness: run the listed YouTube and Netflix live regression checklist in Chrome, record exact browser/version and outcomes, then package only after unresolved PARTIAL items are reviewed.
- Keep the next change focused; do not start a new feature phase during stabilization.
