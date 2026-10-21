# Vendored on-device models

Everything here is static and loaded with same-origin GETs, so a photo is processed with no third-party
request at all (nothing from a CDN at run time).

| File | What | Source | License |
|---|---|---|---|
| `vision_bundle.mjs` | MediaPipe Tasks Vision JS, `@mediapipe/tasks-vision@0.10.35` (`vision_bundle.mjs`) | npm | Apache-2.0 |
| `wasm/vision_wasm_internal.js`, `.wasm` | its SIMD wasm runtime | same package, `wasm/` | Apache-2.0 |
| `hair_segmenter.tflite` | MediaPipe Hair Segmenter (float32): a per-pixel hair mask, used to read the hair color from the photo | `https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite` | Apache-2.0 |
| `face_landmarker.task` | MediaPipe Face Landmarker, float16 | `https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task` | Apache-2.0 |

SHA-256

```
55d7ab624fbb70dcc5adc4ae6d7ea9cfcb569139d3dbfbf2b1deafcb966bc0fe  vision_bundle.mjs
e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c  wasm/vision_wasm_internal.js
6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc  wasm/vision_wasm_internal.wasm
64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff  face_landmarker.task
2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84  hair_segmenter.tflite
```

Only the SIMD runtime is vendored (every current browser supports it); the non-SIMD fallback is not.
To update: replace the files, update the hashes, and run a bind on a sample photo.
