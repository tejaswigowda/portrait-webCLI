# portrait-webCLI

A browser-based **photo-to-VRM** tool: give it a photo of a face (or a webcam selfie) and a base VRM, and it reads the face **on your device**, makes a face-blendshape GLB from it, and binds that to the VRM so the avatar's expressions can be driven by a face. Optionally it nudges the VRM's face shape, hair shape, hairstyle and colors toward the photo.
<b><ins>No uploads, no servers: everything happens in your browser.</ins></b> Pure ES modules, no build step. three.js, the MediaPipe runtime and both face models are vendored in `docs/`, so the whole app is same-origin and works with the network off once loaded.

▶ **Intended origin:** https://portrait.webcli.app/ (not verified live yet; run it locally with `npm start`).

## Paper

This tool is a reference implementation of the **Web-CLI** architecture, applied to identity data (a photo of a face):

> **The Web-CLI: Verifiable Privacy for Tools, Models, and Inference Engines in the Browser**
> Tejaswi Gowda, Arizona State University.
> arXiv: https://arxiv.org/abs/2608.28950

Part of the Web-CLI family, alongside [ffmpeg-webCLI](https://github.com/tejaswigowda/ffmpeg-webCLI), [whisper-webCLI](https://github.com/tejaswigowda/whisper-webCLI), [3mf-webCLI](https://github.com/tejaswigowda/3mf-webCLI), [bodyrig-webCLI](https://github.com/tejaswigowda/bodyrig-webCLI), [look-webCLI](https://github.com/tejaswigowda/look-webCLI) and [Strata](https://github.com/tejaswigowda/strata-editor). It was cut from Strata's `docs/facebind/`; [look-webCLI](https://github.com/tejaswigowda/look-webCLI) is the cut of the VRM editor that used to open inside it. **portrait-webCLI makes the bound VRM, look-webCLI edits its textures, materials and outfit, bodyrig-webCLI bakes motion onto it.**

## Run it

```bash
npm install     # dev tooling only (Playwright for the tests); the app itself needs nothing
npm start       # http://127.0.0.1:8011 (any static host works; no COOP/COEP needed)
```

Choose a photo (or **Use the webcam**), pick a base VRM (the bundled male or female VRoid base, or your own file or URL), press **Bind**, then **Download**.

## What it does

```
photo (local File) -> MediaPipe Face Landmarker (on device, CPU) -> face-blendshape GLB (in memory) -> bind -> VRM
```

- **Expression binding first.** The bind gives the VRM a weight map that says "face morph *i* drives this VRM expression morph" (names from the face GLB's `extras.targetNames`, the ARKit-52 convention, or the 42-name convention). A face performance (facerig, mocap-webCLI's `.blendshapes.json`) then animates the VRM.
- **A photo-informed look second** (all optional, all approximate): face shape (eye size and spacing, mouth width, jaw, nose / lips / chin depth), hair shape (volume, height, length, fringe) and hairstyle (re-laid as waves, curls or coils, or a cut preset), facial hair painted into the face texture, and skin, hair, eye and brow color. An anime base still looks like an anime character; this gets closer, it does not get identical.
- **Rig-safe.** The skeleton, skin weights, morph deltas, textures, hair and body are carried through byte for byte. The only changes are the bind block, the face's and hair's own vertex positions and normals, material colors, optionally one appended face texture, and (optionally) the hair left out. The outfit is never touched. `bindVRM` audits this before it writes and refuses (`RIG_UNSAFE`) if anything else would change. The face GLB's mesh is never grafted on.
- **Preview** (three.js, on device): bound or base, flat or toon-lit, expression from the photo, neutral or sliders, and a bald toggle that re-binds without reading the face again.
- **Face GLB download**: the face-blendshape GLB made from the photo (it embeds a crop of the photo: see [Privacy](#privacy-and-the-threat-model)).

The output is a standard VRM (glTF 2.0) with an `extensions.STRATA_face_bind` block that carries only generic morph names and counts.

## The four Web-CLI properties

| Property | Here |
|---|---|
| **Fidelity** | The same bind code as Strata (`docs/lib/facebind/`), with its unit tests, run unchanged. |
| **Progressive disclosure** | A photo and **Bind** is enough. The shape, hair and color options, the face-GLB import and your own VRM are behind the second card and the `details` rows. |
| **Offline-first** | Everything, including the face models (~5 MB) and the MediaPipe wasm, is a same-origin static file. With the network off, a bind works once the page has loaded and the VRM is a local file (the bundled bases are fetched when you press Bind, 22 MB each). There is no service worker (see [Honest limitations](#honest-limitations)). |
| **Zero egress** | The page makes `GET` requests only, never with a body, and none carries the photo. Enforced three ways: no network code in the bind libraries (a test scans every file), a CSP (`default-src 'none'`, `worker-src 'none'`), and a runtime egress guard (`docs/egressGuard.js`) that refuses everything but same-origin / `blob:` / `data:` / the one base-VRM URL you typed, and logs every request in the **Network audit** card. |

## Pure transform, agent-drivable

portrait-webCLI is a **pure transform**: a photo and a base VRM in, a bound VRM out (a download plus a grabbable handle). It has no git, no token, no repo write and no versioning; those belong to the orchestrator driving it and to [Strata](https://github.com/tejaswigowda/strata-editor).

**One deliberate exception to "URL in".** The photo and the face GLB are identity data, so they are **local files only**: `?image=` and `?face=` are refused, and `window.__portrait.run({ image: 'https://…' })` is rejected (`IMAGE_MUST_BE_LOCAL`). A script supplies the photo the way a person does, from disk (Playwright `setInputFiles`, or a `File`/`Blob`/bytes passed to `run`). The base VRM may be `male`, `female`, a URL (GET) or a local file.

```
index.html?vrm=male|female|<url>[&run=bind][&download=1]
```

`run=bind` starts the bind as soon as a photo (or face GLB) arrives. Parameters are read from the query string or the `#fragment`. An unknown `run=` value is an error. `download=1` also triggers the download.

**Output.** A **Download** button for people. For agents the page exposes:

```js
document.body.dataset.webcliStatus   // 'idle' | 'running' | 'done' | 'error'
window.__webcli_result = {
  ok, op: 'bind',
  artifact: { mime: 'model/gltf-binary', name, size, dataUrl },   // the bound VRM; dataUrl is built on first read
  error,                                                          // a message when ok is false
  meta: { nameResolution, warnings, mapped, sourceMorphs, scope, source: 'photo' | 'face-glb',
          faceGlb: { mime, name, size, dataUrl } | null, expression, report },
}
```

This is not a network write, only a way to retrieve the output. Stable `data-testid` hooks: `photo-input`, `face-input`, `vrm-input`, `vrm-url`, `bind`, `download`, `result`, `status`. The full options are on `window.__portrait.run({ vrm, image, face, look, shape, hairShape, hairStyle, facialHair, bald })`.

```js
// Playwright
await page.goto(`${origin}/index.html?vrm=male&run=bind`);
await page.setInputFiles('[data-testid=photo-input]', 'face.jpg');
await page.waitForSelector('body[data-webcli-status=done], body[data-webcli-status=error]');
const { ok, artifact, error } = await page.evaluate(() => window.__webcli_result);
```

The same photo, base and options give a **byte-identical** bound VRM (CPU inference, no clock or randomness in the bind code); the test suite asserts it on a real photo, with the second run offline.

## Verify zero egress

Open DevTools, Network tab, check **Preserve log**, and bind a photo. Only static files from this site appear (the wasm, the two models, the base VRM), all `GET`, none carrying a body, and the **Network audit** card in the page lists the same. Switch the network off after the page has loaded and bind again with a local VRM file: it still works. The test suite asserts exactly this (every request same-origin, no non-GET, no body; the guard blocks a POST, a beacon, a WebSocket and a Worker and logs them; a full photo run with the network off). There is no write path to audit: no `POST` or `PUT`, no token.

## Privacy and the threat model

Read [PRIVACY.md](PRIVACY.md): the data inventory (what exists where, and what you can leak by sharing a download), the controls, the threat model (a compromised host is **not** covered) and how to verify each claim. The short version: the **face GLB** embeds a crop of your photo, and the **bound VRM** has no photo pixels but its geometry and colors are derived from the face. Treat both as personal data and do not commit them to a public repository.

## Testing

```bash
npm test                                # unit + static + browser
PORTRAIT_TEST_IMAGE=face.jpg npm test   # also runs the photo path
```

- `tests/facebind.test.mjs`, `faceRefine.test.mjs`, `morphDeltas.test.mjs`: the bind libraries (synthetic VRMs and faces, rig-safety audit, hair and face reshape, determinism). Pure Node.
- `tests/static.test.mjs`: CSP and import-map hash, no inline script or style, no remote URL, no network or storage API in any module, the egress guard's rules, the contract (`data-webcli-status`, result shape, `run=` validation, testids), vendored model hashes.
- `tests/e2e.test.mjs`: Playwright/Chromium. Zero egress, the contract, `run=bind` with a face GLB, determinism, the network switched off, a bad `run=`, URL identity inputs refused, the guard. The photo test runs only when you supply a photo: the repository ships none (a face is identity data, and a test must not need one). `tests/fixtures-local/` is git-ignored for that.

## Honest limitations

- **Approximate, not a likeness.** The shape and color matching is a rough, measured nudge on the VRM's own geometry. Braids, buns and ponytails are not possible; the hair texture guessed from the photo is an estimate you can override.
- **Morph deltas and the warp (a known open item).** Morph targets are deltas and are carried through the face warp untouched. That is exact on an unwarped base, but where the warp stretches the face (eyes, mouth, brows) a delta is off by the local strain: measured over all 52 ARKit shapes on the bundled bases, the worst shape is about 6.5% of the face height at bind strength 0.5 and about 13% at strength 1 (brows and blinks). `node tests/morphDeltas.test.mjs` prints the table; it reports `GATE FAIL` and exits 0 (`--strict` fails). Prefer a lower shape strength if you will drive the face hard. The fix is to carry each delta through the warp inside `reshapeVRM`.
- **Bundled bases are fetched on Bind**, not at load (22 MB each), so a fully offline bind needs a local VRM file or a base the browser has already cached.
- **No service worker and no PWA install.** The egress guard refuses service workers and `worker-src 'none'` forbids workers: a worker's requests would not pass through the guard, so the request log could not be complete. The price is that offline use relies on the page staying loaded (or the browser cache), not on an installed cache.
- **Headers.** GitHub Pages cannot set response headers, so the policy is a `<meta>` CSP (it cannot set `frame-ancestors`) plus the guard. For real headers (`Content-Security-Policy`, `Referrer-Policy`, `X-Content-Type-Options`, `Permissions-Policy: camera=(self), microphone=()`), serve `docs/` behind a host that sets them, with the `<meta>` value as the policy.
- **`connect-src`** allows `https://raw.githubusercontent.com` so a base VRM can be fetched from a URL you type. The guard blocks it unless that exact URL was registered. Add your own host to the CSP if you need another.
- **CPU inference** (no GPU delegate) keeps the output reproducible; a large photo takes a few seconds on the main thread, so the page yields between steps to repaint.
- The face model assumes **one clear, front-facing face**. No face detected is an error (`NO_FACE_DETECTED`).
- **Not on webcli.app yet.** This origin is not in [tools.json](https://webcli.app/tools.json); its entry would be `kind: artifact`, `egress: none`, `fetches: []`, `agent: true`, `deterministic: verified`.

## Layout

```
docs/                 GitHub Pages root
  index.html style.css icon.svg
  page.js             the page: inputs, run(), the contract, the preview wiring
  egressGuard.js      runtime egress guard + request log (loaded first)
  preview.js          three.js preview (loaded on first use)
  selfie.js           webcam selfie (video only, stream stopped after the shot)
  autorig/            photo -> face-blendshape GLB (vendored face-to-blendshape-3d + the on-device glue)
  lib/facebind/       the bind: GLB I/O, face-source reading, bindVRM, reshape, hair, scalp, facial hair
  lib/face/           the face reference and the face warp (FaceRefine)
  base/               the two bundled VRoid base VRMs, unmodified (see base/README.md)
  vendor/three/       three.js + the three addons the page uses
  vendor/mediapipe/   MediaPipe Tasks Vision (JS + SIMD wasm) and the two models, with SHA-256s
tests/                unit, static and browser tests
```

## Attribution

- **Base VRMs:** `VRoid_V110_Male_v1.1.3.vrm` and `VRoid_V110_Female_v1.1.3.vrm` are the free base models from [hinzka/52blendshapes-for-VRoid-face](https://github.com/hinzka/52blendshapes-for-VRoid-face), which states they may be used, redistributed and sold freely with no credit required. Included unmodified; binding writes a new file.
- **Autorigger:** `docs/autorig/` vendors [face-to-blendshape-3d](https://github.com/tejaswigowda/face-to-blendshape-3d) (MIT, `docs/autorig/LICENSE`, commit `c656b22`) plus this tool's on-device glue.
- **MediaPipe** Tasks Vision, the Face Landmarker and the Hair Segmenter: Google, Apache-2.0 (`docs/vendor/mediapipe/README.md` lists sources and hashes).
- **three.js** (MIT, `docs/vendor/three/LICENSE`).

## License

GPL-3.0, to match the rest of the family (see `LICENSE`). Vendored components keep their own notices: MIT (three.js, the autorigger) and Apache-2.0 (MediaPipe).
