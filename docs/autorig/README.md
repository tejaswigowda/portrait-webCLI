# Vendored autorigger

`arkit-mapper.js`, `face-mesh-generator.js`, `face-mesh-triangulation.js` and `texture-mapper.js` are copied
unmodified from [tejaswigowda/face-to-blendshape-3d](https://github.com/tejaswigowda/face-to-blendshape-3d)
at commit `c656b2276fb83a1cd5463f4f5e1d0c28e9731cba` (MIT, see `LICENSE`).

`faceFromImage.js` is the new glue: photo → on-device landmarks → the face-blendshape GLB, using the
vendored MediaPipe models in `../vendor/mediapipe/` instead of the CDN the original loads from. It also reads the hair
mask, hair shape, iris and brow colors and the face proportions from the photo and stores them in the face GLB's
node `extras`. Nothing here has network code; see `PRIVACY.md` at the repository root.
