# portrait-webCLI: privacy audit (zero egress)

Audit of this repository's page (`docs/`), the bind code (`docs/lib/`), the autorigger (`docs/autorig/`) and the preview. Adapted from the audit of Strata's `/facebind/` (2026-10-11), re-checked for this cut by the tests in `tests/`.

**The claim.** A photo of a face, the face GLB made from it, and everything derived from them stay on the device. The page makes no request that carries them, and the whole photo to bound-VRM path works with the network off once the page has loaded (with a local VRM file; the bundled bases are fetched when you press Bind).

**What the claim is not.** It is not a promise about a compromised host, a hostile browser or extension, or what you do with the files you download. See [Threat model](#4-threat-model).

## 1. Data inventory

| Data | Where it exists | Leaves the page? |
|---|---|---|
| **Photo** (File) | Read with `createImageBitmap`, drawn on canvases (a 1024 px face crop, a downscaled copy for the hair model and color sampling), shown in the `<img>` preview through an in-page object URL | No |
| **Webcam selfie** (optional) | A video-only `getUserMedia` stream (no microphone). One frame is drawn to a canvas and kept as an in-memory PNG `File`, which then follows the **Photo** row. The stream is stopped as soon as the frame is taken, on Cancel and when the page is left. Nothing is recorded, stored or sent (`selfie.js`, checked by `tests/static.test.mjs`) | No |
| **Landmarks, hair mask, expression scores** | MediaPipe (wasm, CPU) memory, then plain JS arrays. The expression scores also drive the preview and are in `window.__webcli_result.meta.expression` | No |
| **Measurements and colors** (face proportions, hair shape, hair texture estimate, facial hair amounts, skin, hair, iris and brow color) | JS objects, then the face GLB's node `extras` | No |
| **Face GLB** | In memory, optional local download. **Contains the photo crop as its texture**, a 478-point face mesh, the photo's expression as morph weights, and the measurements above | Only if you download it and share it |
| **Bound VRM** | In memory, local download. Contains the base VRM, the bind block (generic morph names and counts only) and, if you left them on, reshaped face and hair geometry, tinted colors and, if the photo had facial hair, a painted face texture derived from the photo | Only if you download it and share it |
| **Preview** | Decoded copies of the base and bound VRM in GPU/CPU memory, posed with the photo's expression | No |
| **`window.__webcli_result`** | Holds the result bytes (as a lazy data URL), the face GLB, the expression scores and the report, so an agent can read them | No, but any script in the page can read it |

Worth knowing:

- The **face GLB** is the most sensitive artifact: it embeds a crop of the photo.
- The **bound VRM** has no photo pixels or landmarks, but its geometry and colors are derived from the face. Treat it as personal data if the face is a real person's, and do not commit it to a public repository unless you mean to.
- The bind block (`STRATA_face_bind`) carries only morph names, the morph count and how the names were resolved. It deliberately carries no hash, measurement or color from the photo.

## 2. Every request the page makes

All `GET`, none with a body.

| Request | Destination | Carries identity data? |
|---|---|---|
| `vision_bundle.mjs`, `vision_wasm_internal.js/.wasm` | this origin, `vendor/mediapipe/` | No |
| `face_landmarker.task`, `hair_segmenter.tflite` | this origin | No |
| three.js, `GLTFLoader`, `OrbitControls`, `GLTFExporter`, the page's own modules | this origin | No |
| Base VRM (`base/VRoid_V110_*.vrm`) | this origin, or the one URL you typed | No (a URL you chose) |
| Textures of the preview models | `blob:` URLs of in-memory data (never a network request) | n/a |

**Which thread.** Every request originates on the **main thread**. The face landmarker and the hair segmenter run as CPU/SIMD wasm on the main thread; no `Worker`, `SharedWorker` or service worker is created anywhere. That is why "every request is logged" is true: `egressGuard.js` wraps the page's `fetch` and XHR, the only place a request can start. Workers are refused three ways in case a future change adds one: the guard replaces `Worker`, `SharedWorker` and `serviceWorker.register` with functions that throw and log, the CSP has `worker-src 'none'`, and the static scan fails on any `Worker`, `SharedWorker`, `Worklet`, `serviceWorker` or `importScripts` in the code.

What the host that serves the page can see: your IP address and user agent, the time, and which static files you fetched. The models load when the page opens whether or not you use a photo, so the host cannot tell that you did. It learns which bundled base (male or female) you bound, and the URL if you typed one.

## 3. Controls

| Layer | What it does |
|---|---|
| **No network code** | The bind, face, hair, reshape, preview and autorigger modules have no `fetch`, XHR, WebSocket, beacon, storage, `postMessage`, `BroadcastChannel` or computed dynamic import. `tests/static.test.mjs` scans every file |
| **Local-only inputs** | A URL for the photo or face GLB is rejected (`IMAGE_MUST_BE_LOCAL`, `FACE_MUST_BE_LOCAL`); `?image=` and `?face=` are ignored |
| **Content-Security-Policy** (`<meta>`) | `default-src 'none'`; `script-src 'self' 'wasm-unsafe-eval'` plus the hash of the one inline import map; `style-src 'self'`; `connect-src 'self' blob: https://raw.githubusercontent.com`; `img-src 'self' blob: data:`; `worker-src 'none'`; `form-action 'none'`; `base-uri 'none'` |
| **`no-referrer`** | `<meta name="referrer" content="no-referrer">` |
| **Egress guard** (`egressGuard.js`, loaded first) | `fetch` and XHR allowed only for `GET` without a body, a URL up to 2048 characters, and a destination that is this origin, `blob:`, `data:`, or the exact base-VRM URL you typed (registered just before it is fetched). Blocks everything else, plus `sendBeacon`, `WebSocket`, `EventSource`, WebRTC, `WebTransport` and `window.open`. Logs every request, shown in the **Network audit** card and in `window.__portrait_net` |
| **Vendored, hashed models** | MediaPipe JS, wasm and both models are served from this origin; their SHA-256s are in `docs/vendor/mediapipe/README.md` and checked by a test |
| **CPU inference** | No GPU delegate for the models, so results are reproducible |
| **No persistence** | No `localStorage`, IndexedDB, Cache API or service worker. Object URLs of the previous run are revoked when you run again |
| **Escaped output** | Everything from a file that reaches the page (morph names, material names) goes through `esc()`, so a hostile GLB cannot inject markup. The CSP also blocks inline script and remote loads |

## 4. Threat model

| Threat | Covered? |
|---|---|
| **A bug or dependency in this code sending identity data out** | Yes. No network code in the modules, the CSP, the guard's destination allow-list and the request log |
| **A third-party library calling home** (MediaPipe, three.js) | Yes. All are vendored and same-origin; the CSP and guard block other destinations |
| **A crafted base VRM or face GLB (injection)** | Yes. File-derived text is escaped; there is no inline script; `eval` is not allowed (only `wasm-unsafe-eval`) |
| **A compromised or malicious host serving different code** | **No.** The same host delivers the page, the CSP and the guard, so it can change all three. Real response headers do not change this. Mitigate by running a local copy (`npm start`), pinning a reviewed commit, or self-hosting |
| **Browser extensions, devtools, OS-level capture, screenshots** | No (out of scope) |
| **You sharing a downloaded file** | No. The face GLB (photo crop) and the bound VRM (derived geometry and colors) are yours to protect |
| **A tool you open the bound VRM in afterwards** | No. The claim covers this page only. [look-webCLI](https://github.com/tejaswigowda/look-webCLI) is a separate origin with its own claim; Strata can commit to Git with a token and call optional external AI |

## 5. Hosting notes

GitHub Pages cannot set response headers, so only the `<meta>` CSP applies. A `<meta>` CSP cannot set `frame-ancestors`, so the page can be framed by another site (it embeds no secret, but a framing page could try to drive it); real headers fix that. If you serve `docs/` yourself, set `Content-Security-Policy` to the `<meta>` value plus `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff` and `Permissions-Policy: camera=(self), microphone=()`.

## 6. How to verify

1. **Static checks.** `node tests/static.test.mjs`: CSP, import-map hash, no remote URLs, no inline script or style, no network or storage API in any module, the guard's rules, vendored model hashes.
2. **Browser run.** `node tests/e2e.test.mjs`: every request same-origin and `GET` without a body; a POST, a beacon, a WebSocket and a Worker are blocked and logged; a face-GLB bind and (with `PORTRAIT_TEST_IMAGE`) a photo bind complete with the network switched off; two runs are byte-identical.
3. **By hand.** DevTools, Network, **Preserve log**, bind a photo: only static files from this origin. Then go offline, choose a local VRM and bind again. Open the **Network audit** card: it lists the same requests.
4. **Block everything.** With every request aborted (Playwright `route('**/*', abort)`) after the page loaded and a local VRM file chosen, a full photo run completes with zero attempted requests.
