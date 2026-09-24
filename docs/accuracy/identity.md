# Identity verification — design, accuracy baseline and evaluation protocol

This document covers the server-side identity pipeline (`apps/server/src/vision`), the offline accuracy
harness (`apps/server/src/eval`), the current baseline (`docs/accuracy/identity-baseline.json`) and the
protocol customers should follow to measure accuracy on their own population.

> **Read this first.** The baseline was measured on a tiny public smoke set: 25 labelled photos of 9 adults.
> It shows the pipeline behaves as designed. For example, poor images become *unable to verify* and not
> *mismatch*. It does **not** establish production error rates. With 38 same-person pairs and 0 errors, the
> 95 % upper confidence bound on the false-mismatch rate is still ≈ 3/38 ≈ 8 % ("rule of three"). Before
> relying on the numbers, run the harness on consented data from your own candidates, covering your
> demographics and capture conditions (§8).

## 1. Summary

| Question (clean images, default thresholds 0.40 / 0.28) | Result on the smoke set |
|---|---|
| Genuine probe decided **mismatch** (false identity mismatch), per sample | **0 / 38** pairs; **0 / 684** perturbed genuine trials |
| Impostor probe decided **match** (missed swap), per sample | **0 / 261** clean; **1 / 261** with sensor noise; **1 / 200** with a face mask (folder mode) |
| Impostor probe decided **mismatch** (swap detected), per sample | 79 % (pairs) – 89 % (folder). Most of the rest are *unable to verify* because the probe photo failed the quality gate |
| Poor images (very dark, overexposed, σ = 4 blur, face cut off) | 88 – 100 % *unable to verify*, **0 % mismatch** |
| Swap raises `identity_mismatch` within 1 / 2 min of periodic sampling (30 s, 2 confirmations, independence assumed) | 86 % / 98 % (pairs), 95 % / 99.8 % (folder) |
| Resume check with 3 frames: genuine → mismatch / impostor → match | 0 % / 0 % |
| Genuine vs impostor similarity (clean) | genuine min 0.53, median 0.79; impostor median 0.13, max 0.37 |
| Time per `analyze()` (640×480 JPEG, detection + embedding, 4-core Xeon 2.1 GHz) | ≈ 30–32 ms sequential, ≈ 27–30 ms/image at concurrency 2 |

**Threshold recommendation** (§6): raise the default **match** threshold from 0.40 to **0.45**, and the
**ID-photo match** threshold from 0.36 to **≥ 0.42**. Keep mismatch at 0.28 and ID-photo mismatch at 0.24.

## 2. Models and licensing

| Model | Use | License | Notes |
|---|---|---|---|
| YuNet `face_detection_yunet_2023mar.onnx` (OpenCV Zoo) | face boxes + 5 landmarks | MIT | fixed input 1×3×640×640 BGR 0..255 |
| SFace `face_recognition_sface_2021dec.onnx` (OpenCV Zoo) | 128-d face embedding | Apache-2.0 | input 1×3×112×112 RGB 0..255 |

Both run on CPU through `onnxruntime-node` (MIT). All decoding, alignment and post-processing code was
written for this project; no third-party code was copied.

## 3. Pipeline (`apps/server/src/vision`)

1. **Decode** (`image.ts`). sharp applies EXIF orientation, removes alpha, converts to sRGB 8-bit, and
   downscales to a max side of 1280 px. Inputs are capped at 50 MP (decompression-bomb guard). Corrupt input
   raises `VisionInputError`. Whole-image mean/std luminance and a 64-bit **dHash** are computed in one pass.
2. **Detect** (`detect.ts`). Letterbox into the top-left of 640×640 (zero pad), BGR planar. YuNet outputs are
   decoded per stride (8/16/32): score = √(cls·obj), box = ((c+dx)·s, (r+dy)·s, e^dw·s, e^dh·s), 5 landmarks.
   Score threshold 0.6 (configurable), then greedy NMS at IoU 0.3, and mapping back to original-image
   coordinates. Faces are ranked by area × score, so the candidate's face comes first.
3. **Pose**: `poseFromFivePoints` from `@sp/shared`, the same function and convention the browser uses
   (yaw+ = subject's left, pitch+ = up).
4. **Align** (`align.ts`). A least-squares 2-D similarity transform maps the 5 landmarks onto the ArcFace
   112×112 template. The [a −b; b a] parameterisation cannot reflect. The crop is inverse-mapped with
   bilinear sampling and a black border. If the working image was downscaled and the face is small in it
   (inter-eye < 40 px), the face region is re-decoded from the full-resolution original.
5. **Quality gate** (`quality.ts`, §4) on the primary face.
6. **Embed**: SFace on the aligned crop, L2-normalised.
7. **Decide** (`identity.ts`, §5) against the protected reference: the max cosine similarity over up to 5
   reference embeddings.

**Performance.** One analysis of a 640×480 JPEG breaks down as: decode ≈ 4.5 ms, stats 0.6 ms, tensor
packing 1.6 ms, YuNet ≈ 7 ms, alignment and quality 0.7 ms, SFace 13–19 ms. Total ≈ 30–32 ms sequential
(≈ 15 ms without the embedding). With the default concurrency of 2, throughput is ≈ 27–30 ms/image. That is
≈ 35 analyses/s per process, enough for ≈ 1,000 candidates at one sample every 30 s. Inference runs on native threads and does not block the event loop.
Two settings matter:

- **Spin-waiting is disabled** in onnxruntime's thread pools (`session.intra_op.allow_spinning = 0`).
  Otherwise the two sessions starve each other: YuNet took 15 ms instead of 6 ms, SFace 31 ms instead of 13 ms.
- **Back-pressure:** analyses beyond `maxQueue` (default 256) are rejected with `VisionBusyError`, which
  routes should map to HTTP 503.

A worker-thread pool was not used. onnxruntime-node already runs inference off the main thread and
serialises runs per process, so workers would add complexity without adding throughput.

## 4. Quality gate

An image that fails the gate yields **`unable_to_verify`** with candidate guidance (`QUALITY_GUIDANCE`).
It is never `mismatch`. Defaults are in `QUALITY_GATE` and can be overridden per call (`AnalyzeOptions.gate`).

| Check | Issue | Default | Why |
|---|---|---|---|
| no face | `no_face` (+ `too_dark` / `too_bright` / `low_contrast` from whole-image luminance) | — | tells the candidate *why* no face was found |
| second face ≥ 40 % of the primary's width | `multiple_faces` | 0.4 | distant background faces/posters do not block verification (they are still listed in `faces[]`); `faceCount` counts significant faces only |
| face box > 8 % outside the image, or a landmark at the edge | `face_cut_off` | 0.08 | partial faces embed poorly (cut-at-nose probes drop to 0.36–0.69 similarity) |
| face-region brightness < 40 or > 220 | `too_dark` / `too_bright` | 40 / 220 | overexposed genuine probes fall to 0.28 similarity, right at the mismatch threshold |
| face-region contrast (luma std) < 18 | `low_contrast` | 18 | washed-out / very dim faces |
| inter-eye distance < 28 px (original image) | `face_too_small` | 28 | SFace template inter-eye distance is 35 px |
| contrast-normalised variance of Laplacian on the aligned crop < 80 | `blurry` | 80 | see calibration below |
| \|yaw\| > 25° or pitch outside [−35°, +25°] | `face_turned` | see note | |
| YuNet score < 0.75 | `low_detection_confidence` | 0.75 | heavy occlusion / very poor images |

**Sharpness calibration.** Sharpness is the variance of the 4-neighbour Laplacian over the inner face
region of the 112×112 grey crop. It is normalised to a face-region std of 50, so that dim lighting does not
masquerade as blur. On the smoke set at webcam size (max side 640):

| | clean | σ=1 | σ=2 | σ=3 | σ=4 | σ=6 |
|---|--:|--:|--:|--:|--:|--:|
| sharpness median | 1573 | 703 | 185 | 74 | 39 | 18 |
| sharpness 5th pct | 409 | 203 | 38 | 14 | 7 | 7 |
| similarity to the clean image, min | 1.00 | 0.96 | 0.84 | 0.66 | 0.44 | 0.19 |

No clean photo scored below ≈ 300. A threshold of 80 rejects most σ ≥ 3 images and keeps σ ≤ 2 images,
which still embed reliably. Webcam frames are softer than these photos, so the threshold is deliberately
not higher. `blurry` is not added when `too_dark` or `low_contrast` already explains the image, which keeps
the guidance actionable.

**Pitch window.** The pitch window is asymmetric, [−35°, +25°]. With YuNet landmarks, the shared five-point
formula reads near-frontal portraits as looking down by ≈ 10–12°: the median nose-depth ratio is 0.593
against the formula's frontal constant of 0.54. Laptop webcams also sit above the eyes, so candidates
normally appear to look slightly down. The reported pose is exactly `poseFromFivePoints(landmarks)`; only
the gate window accounts for the offset. Liveness uses pose *relative to the candidate's own frontal
frames*, so a constant offset does not affect it.

**ID photos** use the more lenient `ID_PHOTO_QUALITY_GATE` (inter-eye ≥ 20 px, score ≥ 0.65, sharpness ≥ 50,
second face must reach 70 % of the primary to count, since ID cards often carry a small "ghost" portrait).
The rejection guidance there is written for the staff member uploading the photo.

## 5. Decisions

### Per sample (`decideIdentity`)

- Quality gate failed, or no embedding → **unable_to_verify**, with guidance.
- similarity ≥ match → **match**.
- similarity < mismatch → **mismatch**.
- Anything in between → **inconclusive**.
- ID-photo comparisons use `idPhotoMatch` / `idPhotoMismatch`.

Confidence is 0..1, with CONFIDENCE_MARGIN = 0.25:

- match: 0.5 + 0.5·clamp01((s − match) / 0.25)
- mismatch: 0.5 + 0.5·clamp01((mismatch − s) / 0.25)
- inconclusive: 0.5 + 0.5·(1 − |s − mid| / half-width), where mid is the centre of the grey zone
- unable_to_verify: 1, because the image objectively failed the gate and no identity claim is made.

### Reference (`buildReference`)

- Needs ≥ 3 usable frames with |yaw| ≤ 20° and pitch within [−30°, +20°].
- Any pair below the mismatch threshold fails outright with "Frames appear to show different people or are
  inconsistent".
- Grey-zone frames are dropped, most inconsistent first, until every remaining pair is ≥ match. At least 3
  frames must remain.
- Up to 5 embeddings are stored: the best-quality frame first, then farthest-point selection for diversity.
- The reference is never updated from later samples.

### Multi-frame checks (`aggregateFrames`, used on resume / reconnect)

- No usable frame → unable_to_verify.
- ≥ 2 matching frames → match.
- ≥ 2 mismatching usable frames and no match → mismatch.
- Anything else → inconclusive.

### Liveness (`verifyLiveness`)

- **Direction:** frontal frames define the centre pose (median). Each step needs a frame whose pose, relative
  to that centre, moved the required way by ≥ 60 % of the target. Both horizontal turns must occur with
  opposite yaw signs; a flat photo shows no parallax.
- **Frames:** only the first 3 frames per step are considered. Five-point pose jitters by 5–10° between
  frames, so unlimited attempts would let a photo fish for an outlier.
- **One face, one person:** every frame must show one face and the same person (turned frames ≥ 0.30,
  frontal-to-frontal ≥ match).
- **Timing and order:** frames must not be identical images (dHash distance > 2), must fall inside
  [issuedAt, expiresAt] ± 1 s, and must be in the requested order.
- **Client cross-check:** client-reported yaw/pitch, when provided, must not strongly contradict the
  server measurement.

## 6. Results (smoke set)

**Dataset.** The public deepface unit-test photos labelled in its `master.csv`: 25 images of 9 subjects,
38 same-person and 262 different-person pairs. All subjects are adult public figures in professional
portraits, taken years apart with different cameras, backgrounds, clothing and hairstyles. Images were
resized to a max side of 640 px and re-encoded (JPEG q=92) to resemble webcam frames.

The two modes were run as follows:

- **Pairs mode:** each pair enrols one image as a single-image reference. The other image is the probe.
- **Folder mode:** the subjects were grouped by union-find over the "same" pairs. The most frontal usable
  image of each subject became the reference; all other images are genuine probes, and every image of
  another subject is an impostor probe. Condition tags were assigned by visible attributes only.

Numbers below use the current defaults (match 0.40, mismatch 0.28, 2 confirmations). The full data,
including ROC points, EER and per-group event estimates, is in `identity-baseline.json`.

### 6.1 Capture conditions (folder mode, unperturbed)

| Group | Genuine n | Match | Inconcl. | Unable | **False mismatch** | Impostor n | **False match** | Swap detected / sample | Genuine usable sim min / median | Impostor usable sim median / max |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| all | 16 | 87.5% | 0.0% | 12.5% | **0.0%** | 200 | **0.0%** | 88.5% | 0.53 / 0.71 | 0.13 / 0.37 |
| background | 13 | 92.3% | 0.0% | 7.7% | **0.0%** | 104 | **0.0%** | 89.4% | 0.53 / 0.71 | 0.14 / 0.34 |
| camera | 16 | 87.5% | 0.0% | 12.5% | **0.0%** | 128 | **0.0%** | 83.6% | 0.53 / 0.71 | 0.14 / 0.34 |
| clothing | 13 | 84.6% | 0.0% | 15.4% | **0.0%** | 104 | **0.0%** | 80.8% | 0.65 / 0.71 | 0.14 / 0.34 |
| glasses | 1 | 100.0% | 0.0% | 0.0% | **0.0%** | 8 | **0.0%** | 87.5% | 0.78 / 0.78 | 0.09 / 0.34 |
| hairstyle | 8 | 100.0% | 0.0% | 0.0% | **0.0%** | 64 | **0.0%** | 95.3% | 0.53 / 0.70 | 0.15 / 0.31 |
| lighting | 3 | 66.7% | 0.0% | 33.3% | **0.0%** | 24 | **0.0%** | 66.7% | 0.68 / 0.71 | 0.13 / 0.26 |
| pause-years (photos years apart) | 2 | 100.0% | 0.0% | 0.0% | **0.0%** | 16 | **0.0%** | 100.0% | 0.53 / 0.62 | 0.13 / 0.28 |

The "unable" genuine probes are turned faces (|yaw| ≈ 28–30°) that the gate correctly refuses to judge. The
per-condition groups are far too small to compare conditions against each other; they show the harness
mechanics.

### 6.2 Synthetic perturbations of every probe (pairs mode)

| Perturbation | Genuine n | Match | Inconcl. | Unable | **False mismatch** | Impostor n | **False match** | Swap detected / sample | Genuine usable sim min / median | Impostor usable sim median / max |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| none (all) | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.0%** | 78.9% | 0.53 / 0.80 | 0.13 / 0.37 |
| dim (×0.35) | 38 | 2.6% | 0.0% | 97.4% | **0.0%** | 261 | **0.0%** | 5.4% | 0.78 / 0.78 | 0.03 / 0.21 |
| very_dark (×0.15) | 38 | 0.0% | 0.0% | 100.0% | **0.0%** | 261 | **0.0%** | 0.0% | – / – | – / – |
| low_light (×0.5 + noise σ=8) | 38 | 94.7% | 0.0% | 5.3% | **0.0%** | 261 | **0.0%** | 88.1% | 0.53 / 0.76 | 0.10 / 0.37 |
| overexposed (×1.8+40) | 38 | 5.3% | 0.0% | 94.7% | **0.0%** | 261 | **0.0%** | 14.2% | 0.60 / 0.63 | 0.08 / 0.33 |
| gamma_dark (γ 2.0) | 38 | 94.7% | 0.0% | 5.3% | **0.0%** | 261 | **0.0%** | 88.9% | 0.54 / 0.79 | 0.13 / 0.37 |
| gamma_bright (γ 0.5) | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.0%** | 79.3% | 0.53 / 0.79 | 0.13 / 0.37 |
| blur_s2 | 38 | 100.0% | 0.0% | 0.0% | **0.0%** | 261 | **0.0%** | 93.5% | 0.57 / 0.79 | 0.13 / 0.36 |
| blur_s4 | 38 | 5.3% | 0.0% | 94.7% | **0.0%** | 261 | **0.0%** | 10.3% | 0.75 / 0.77 | 0.14 / 0.29 |
| jpeg_q15 | 38 | 94.7% | 0.0% | 5.3% | **0.0%** | 261 | **0.0%** | 87.7% | 0.47 / 0.77 | 0.12 / 0.37 |
| lowres_160 (160 px camera) | 38 | 100.0% | 0.0% | 0.0% | **0.0%** | 261 | **0.0%** | 94.6% | 0.51 / 0.79 | 0.13 / 0.38 |
| noise (σ=12) | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.4%** | 80.5% | 0.55 / 0.77 | 0.14 / 0.42 |
| warm_cast | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.0%** | 80.1% | 0.55 / 0.78 | 0.14 / 0.37 |
| cool_cast | 38 | 73.7% | 0.0% | 26.3% | **0.0%** | 261 | **0.0%** | 77.4% | 0.53 / 0.79 | 0.11 / 0.36 |
| occlusion_mask (nose down) | 38 | 94.7% | 0.0% | 5.3% | **0.0%** | 261 | **0.0%** | 81.6% | 0.43 / 0.56 | 0.13 / 0.40 |
| occlusion_hand (mouth) | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.0%** | 78.9% | 0.56 / 0.73 | 0.12 / 0.35 |
| crop_cut (face cut at nose) | 38 | 0.0% | 0.0% | 100.0% | **0.0%** | 261 | **0.0%** | 0.0% | – / – | – / – |
| camera_b (320 px, noise, cool, q40) | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.0%** | 78.2% | 0.51 / 0.79 | 0.12 / 0.35 |
| camera_c (warm, γ0.8, blur 1, q60) | 38 | 92.1% | 0.0% | 7.9% | **0.0%** | 261 | **0.0%** | 79.7% | 0.55 / 0.80 | 0.13 / 0.34 |

Folder mode gives the same picture: 0 false mismatches in every group, and 1 false match of 200 each under
`noise` (0.42) and `occlusion_mask` (0.41).

Readings from these results:

- **The critical number, false identity mismatch, is 0 in every condition.** The closest genuine probe
  (masked, 0.43) is still 0.15 above the mismatch threshold.
- **The gate does its job.** The perturbations that push genuine similarity down the most (overexposed:
  genuine as low as 0.28; cut-off: 0.36; σ = 4 blur) are almost entirely `unable_to_verify`.
- **The gate is conservative in dim light.** Linear dimming ×0.35 lowers face contrast below 18, so 97 %
  of those probes become `unable_to_verify` even though SFace still matches them (0.78). The realistic
  `low_light` case (auto-gain: ×0.5 plus sensor noise) passes 95 %. Candidates in very dim rooms are asked
  to add light, which is intended behaviour.
- **Cool cast shows pose jitter, not an embedding problem.** The 26 % unable rate is `face_turned`:
  five-point pose moves by 5–10° with small image changes, and several probes sit near the 25° yaw limit.
- **Occlusion is not detected by the gate.** A mask from the nose down still matches genuine faces (median
  0.56) but reduces discrimination: an impostor reached 0.40–0.41. The browser's obstruction detector
  flags covered faces during monitoring. The recommended 0.45 match threshold removes these false matches;
  7.9 % of masked genuine probes then become *inconclusive*, never mismatch.

### 6.3 Event-level estimates (clean, pairs mode; `events` in the JSON has them for every group)

**Assumption.** Consecutive samples are treated as independent draws from the per-sample rates. Real
samples of one candidate are positively correlated (same room, camera and lighting), so the independent
figure for false alerts is optimistic. The JSON therefore also gives the fully correlated bound: the
probability that a session raises one event at all equals the per-sample false-mismatch rate. A
confirmed `identity_mismatch` needs 2 consecutive mismatching samples (a follow-up is requested
immediately after the first). Samples are taken every 30 s. In practice a swap usually also triggers an
immediate `face_return` / `camera_reconnect` sample, so these periodic-only figures are conservative.

| | Pairs | Folder |
|---|--:|--:|
| False `identity_mismatch` events per candidate-hour (independent) | 0 (observed rate 0/38; ≤ 120·0.079² ≈ 0.75 at the 95 % bound) | 0 |
| Swap → `identity_mismatch` within 0.5 / 1 / 2 / 5 min | 62 % / 86 % / 98 % / >99.9 % | 78 % / 95 % / 99.8 % / 100 % |
| Expected time to detection | 0.8 min | 0.6 min |
| Resume check (3 frames): genuine → match / mismatch | 98.2 % / 0 % | 95.7 % / 0 % |
| Resume check (3 frames): impostor → mismatch / match | 88.6 % / 0 % | 96.3 % / 0 % |

### 6.4 Threshold study

| Threshold | Evidence | Recommendation |
|---|---|---|
| `match` 0.40 | Highest impostor seen: 0.37 clean, 0.42 noisy, 0.41 masked. Lowest usable genuine: 0.53 clean, 0.43 masked | **0.45.** Removes every observed false match. Only masked genuine probes shift, to *inconclusive* (7.9 % pairs, 19 % folder); no genuine probe became mismatch |
| `mismatch` 0.28 | Lowest usable genuine 0.43, a margin of 0.15. At 0.28, 5.8 % of impostors sit in the grey zone | Keep 0.28. Raising it would detect swaps faster but narrows the margin that protects honest candidates, and this data cannot justify it |
| `idPhotoMatch` 0.36 | Clean impostor pairs already reach 0.37 | **≥ 0.42.** At 0.36, a different person can "match" an ID photo |
| `idPhotoMismatch` 0.24 | Older ID photos lower genuine similarity; no ID-photo data here | Keep 0.24 so that old photos land in *inconclusive*, not mismatch |
| `mismatchConfirmations` 2 | — | Keep 2 |

Customers should re-derive these from their own data. The pairs mode `roc` array gives FMR/FNMR at
0.20 … 0.60.

## 7. Limitations

- **Tiny, unrepresentative smoke set:** 9 adult public figures in professional photos. There is no
  demographic coverage analysis, no children, few glasses changes, and no real webcams. Every rate above has
  wide confidence intervals: 0 errors in 38 trials only bounds the rate below ≈ 8 %.
- **Synthetic perturbations are approximations.** Real low light brings noise, motion blur and
  auto-exposure. Real masks and hands have texture. Real cameras differ in optics and processing.
- **No occlusion gate.** Lower-face occlusion is not flagged on the server. A colour/texture heuristic was
  rejected because it would misfire on beards, which would be a demographic failure.
- **Noisy absolute pose.** Five-point pose is ±5–10° per frame, and pitch has a detector-specific offset
  (§4). Borderline frames can flip between usable and `face_turned`.
- **Limited liveness.** The active liveness check defeats flat photos and static images. It does not detect
  a screen replay of a video in which the person turns their head, 3-D masks, or bent-photo attacks. Virtual-
  camera detection and replay/loop detection run in the browser and are separate signals.
- **Different populations need re-validation.** SFace is a general-purpose model and has not been validated
  here across skin tones, ages or genders. Face-recognition error rates are known to vary across
  demographic groups, so validate on your population before relying on automated holds. Keep `onMismatch`
  set to hold *for review*, never to automatic termination.

## 8. Recommended dataset protocol (customers)

Collect **with informed consent**, from the population who will actually take exams, on their own devices:

- **Subjects.** At least 100 people, ideally 300 or more, balanced across skin tone, gender and age bands,
  including people who wear glasses, head coverings or facial hair. Record the demographics only as
  aggregate strata, if at all.
- **Reference.** 3–5 frontal webcam frames per subject, taken at the start of a session under normal
  conditions. Tag them `reference`.
- **Probes per subject.** Include at least one image per condition tag:
  - `lighting-dim`, `lighting-bright`, `lighting-backlit`, `lighting-window`
  - `camera-b`: a different webcam or phone
  - `glasses-on` / `glasses-off`, relative to the reference
  - `hairstyle`
  - `clothing`
  - `background`: a different room
  - `pause-1h`, `pause-1d`, `pause-1w`, `pause-1m`: same person later
  - `angle`: laptop at a different height
  - optionally `mask`, `headphones`, `hand-on-face`
- **Layout.** `<dir>/<subject>/<tag>[+<tag>]__<anything>.jpg`, for example
  `s017/lighting-dim+camera-b__003.jpg`. Folder names are anonymised in the report.
- **Size.** Aim for ≥ 3,000 genuine and ≥ 100,000 impostor trials, so that a 0.1 % false-mismatch rate
  can be distinguished from 1 %.
- **Evaluate.** Run clean and `--perturb`, and gate go-live on:
  - false mismatch ≤ 0.1 % per sample, with no condition group above 0.5 %
  - false match ≤ 0.1 %
  - unable-to-verify ≤ 5 % in normal conditions.
- **Re-run** after any model, threshold or gate change, and periodically on reviewer-labelled production
  outcomes (reviewed vs dismissed identity events).

## 9. Running the harness

```bash
# folder dataset (condition tags in file names), with synthetic perturbations
pnpm --filter @sp/server eval:identity -- --dataset /data/identity-eval --perturb --out eval-reports/local/identity.json

# deepface-style pairs CSV (file_x,file_y,Decision); images next to the CSV or --images <dir>
pnpm --filter @sp/server eval:identity -- --pairs /data/deepface/master.csv --perturb --out pairs.json

# threshold what-ifs and options
pnpm --filter @sp/server eval:identity -- --dataset /data/identity-eval --match 0.45 --mismatch 0.28 --confirmations 2 --interval 30
#   --only dim,blur_s4   restrict perturbations      --size 0   analyse original resolution (default: 640 px, webcam-like)
#   --models <dir>       model directory              --no-anonymize   keep folder names in ids
```

The console prints one row per condition and per perturbation, followed by the event-level estimates. The
JSON contains everything: outcome counts and rates, similarity distributions (all probes and usable only),
EER, ROC points, top quality issues and event estimates per group. No image data or file names are
included (subject ids are anonymised).

The baseline in `identity-baseline.json` was produced with the pairs and folder commands above on the
deepface photos. The folder arrangement was built in a scratch directory with symlinks.
