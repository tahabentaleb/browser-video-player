# Browser Video Player (Chrome Extension, Manifest V3)

Detects `<video>` elements on the page you're visiting and opens the video in a
dedicated extension player tab with full modern controls: timeline with buffered
indicator, ±10 s, playlist prev/next, volume, 0.5×–2× speed, fullscreen,
Picture-in-Picture, theater mode, keyboard shortcuts, resume-where-you-left-off.

## Install (dev / unpacked)
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Visit a page with an HTML5 video → click **▶ Open in Player** on the video,
   or use the toolbar popup.

Optional icons: `node icons/generate.js`, then add to `manifest.json`:
```json
"icons": { "16": "icons/icon_16.png", "32": "icons/icon_32.png", "48": "icons/icon_48.png", "128": "icons/icon_128.png" }
```

## Architecture
```
web page ── content script (detector.js) ─┐
   detects <video>, ranks candidates,     │  payload: {url, time, playlist…}
   floating button, extracts source       ▼
                    service-worker.js: storage.session + tabs.create
                                          ▼
                    player.html (extension tab) plays the direct URL
```
A page's live `<video>` element **cannot** be moved into an extension page
(different process/origin; `blob:` MSE streams are scoped to the page). So the
extension extracts the video's *direct source URL* plus state (position,
playlist of all detected videos) and re-creates playback in the player tab.

- **Detection**: capture-phase media events (`play/pause/timeupdate/…`),
  `MutationObserver` for dynamically inserted videos, passive scroll/resize
  handlers, and a light 2.5 s heartbeat as a safety net. No fast polling.
- **Ranking**: playing > visible area > size > closeness to viewport center.
  Videos < 140×80 are ignored by auto-targeting (tiny previews/ads) but remain
  selectable via hover or the popup.
- **Popup ↔ iframes**: frames reply to the popup directly
  (`runtime.sendMessage`); each entry carries its `frameId` so "open" is routed
  to the right frame with `tabs.sendMessage(..., {frameId})`.
- **Resume**: positions saved to `chrome.storage.local` (throttled 3 s, on
  pause/close), keyed by a hash of the source URL; hand-off position from the
  page is also respected.

## Permissions (minimal)
| Permission | Why |
|---|---|
| `storage` | Remember resume positions, volume, theater mode; hand off payload via session storage |
| host access via `content_scripts` | Required to detect `<video>` elements at all |

No `tabs`, no `scripting`, no `webRequest`, no remote code, no `eval`,
no inline scripts, no analytics. All UI strings from pages are inserted via
`textContent` (never `innerHTML`) to avoid injection.

## Supported sources
| Source | Works? |
|---|---|
| Direct files (`.mp4`, `.webm`, `.ogg`) | ✅ Yes |
| Direct `.m3u8` | ⚠️ Only where Chrome natively supports it (usually not on desktop) |
| `blob:` / MediaSource (YouTube, Netflix, Twitch, most live players) | ❌ Detected, listed, but **cannot replay** — honest error shown |
| DRM (Widevine) | ❌ Not possible from an extension page |
| Servers with strict referrer/cookie checks | ⚠️ May 403 → error state explains it |
| `http://` media on `https://` pages | ⚠️ Mixed-content rules of the host apply |

## Keyboard (player tab)
`Space` play/pause · `←/→` ±5 s · `J/L` ±10 s · `↑/↓` volume · `M` mute ·
`F` fullscreen · `P` PiP · `T` theater · `0` start · `1–9` jump to 10–90% ·
`Home/End`. Disabled while typing in inputs.

## Testing
```bash
node tests/unit.test.js                          # unit tests for shared logic
python3 -m http.server 8000 --directory tests/pages   # manual fixtures
```
Manual matrix: basic / multi / dynamic(10 s) / unsupported pages, plus
youtube.com for the MSE case; then exercise seek, drag, volume, speed,
fullscreen, PiP, close + reopen (resume), navigate away (stale-state cleanup).

## Known limitations (honest)
- MSE/DRM streams cannot be replayed outside their page — a Chrome platform
  boundary, not fixable from an extension without screen-capture hacks.
- Some CDNs refuse requests whose referrer isn't the original site; the player
  shows a clear error instead of silently failing.
- The player gets the URL the page exposed; signed URLs with short TTLs can
  expire if reopened much later.
- `file://` pages require enabling "Allow access to file URLs" for the extension.

## Future improvements
- Range-request proxy via `declarativeNetRequest` to fix referrer-sensitive CDNs.
- HLS.js bundled locally for `.m3u8` sources.
- Side-panel mode, subtitle track picker, per-site volume memory.
