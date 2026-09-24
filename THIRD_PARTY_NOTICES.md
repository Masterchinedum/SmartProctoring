# Third-party notices

SmartProctoring is proprietary software. It contains no source code copied from third parties. It
depends on the open-source packages and machine-learning models listed below, all under licenses
that permit commercial use. Run `pnpm licenses list --prod` for the complete, current list.

## Machine-learning models (shipped in this repository)

| File | Purpose | Source | License |
|---|---|---|---|
| `apps/server/models/face_detection_yunet_2023mar.onnx` | Server face detection (5 landmarks) | OpenCV Zoo — YuNet, © 2020 Shiqi Yu | MIT |
| `apps/server/models/face_recognition_sface_2021dec.onnx` | Server face embedding for identity continuity | OpenCV Zoo — SFace (Zhong et al., “SFace: Sigmoid-Constrained Hypersphere Loss for Robust Face Recognition”) | Apache-2.0 |
| `apps/web/public/models/face_landmarker.task` | In-browser face mesh, blendshapes (gaze) | Google MediaPipe Face Landmarker | Apache-2.0 |
| `apps/web/public/models/efficientdet_lite0.tflite` | In-browser object detection (COCO classes: person, cell phone, book, laptop, tv) | Google MediaPipe / TensorFlow Model Garden EfficientDet-Lite0 | Apache-2.0 |

SHA-256:
```
8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4  face_detection_yunet_2023mar.onnx
0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79  face_recognition_sface_2021dec.onnx
```

### MIT License (YuNet)
```
MIT License

Copyright (c) 2020 Shiqi Yu <shiqi.yu@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0 (SFace, MediaPipe models, MediaPipe Tasks runtime, sharp, drizzle-orm, …)
Full text: https://www.apache.org/licenses/LICENSE-2.0 — the models and libraries are used unmodified.

## Runtime libraries (principal)

| Package | License | Notes |
|---|---|---|
| @mediapipe/tasks-vision (JS + WASM, self-hosted) | Apache-2.0 | |
| onnxruntime-node | MIT | CPU binaries shipped in the npm package |
| sharp | Apache-2.0 | Bundles **libvips (LGPL-3.0-or-later)** as a separate, dynamically linked shared library (`@img/sharp-libvips-*`). LGPL permits commercial use of an unmodified dynamically linked library; keep it as a replaceable shared object (the default) and include this notice. |
| fastify, @fastify/* | MIT | |
| drizzle-orm | Apache-2.0 | |
| pg | MIT | |
| ioredis | MIT | optional (multi-instance realtime) |
| zod | MIT | |
| pino | MIT | |
| react, react-dom, react-router-dom | MIT | |
| @tanstack/react-query | MIT | |
| idb | ISC | |

Build/test-only tools (not shipped): TypeScript (Apache-2.0), Vite (MIT), Vitest (MIT), tsup (MIT),
tsx (MIT), drizzle-kit (MIT), Playwright (Apache-2.0).

## Datasets
No face datasets are included in this repository. Accuracy baselines in `docs/accuracy/` were
produced on a small internal smoke set that is not redistributed; production accuracy must be
measured on consented data (see `docs/accuracy/`).
