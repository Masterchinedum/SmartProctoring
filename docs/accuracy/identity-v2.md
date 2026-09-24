# Identity verification v2 — calibrated for real laptop webcams

This document replaces the calibration parts of [identity.md](identity.md) (pipeline description, licences and the
customer data protocol there still apply). It covers why identity v1 failed with a real webcam, what changed in
`apps/server/src/vision`, how it was measured, the before/after numbers, the limitations, and how to re-run the
measurement — including on your own webcam captures.

> **Status.** These results come from simulated laptop-webcam frames rendered from 140 public photos of 43 people
> (34 enrolled, including 3 families), not from real candidates. The simulator is realistic but deliberately harsh
> in dim and backlit light. The numbers show how the design behaves and let you compare v1 with v2; they are **not**
> production error rates. §10 explains how to run the same measurement on your own webcam captures.

## Summary

| Question (webcam simulator; reference enrolled in good/typical light unless noted) | v1 | **v2** |
|---|--:|--:|
| Candidate can **enrol** at check-in (5 frames), good / typical / **dim** / **backlit** light | 82 % / 71 % / **0 %** / **0 %** | 100 % / 100 % / **47 %** / **62 %** |
| **Genuine first-attempt pass at a resume check**, a different day (identity engine's `assessCheck`, 6 frames): good / typical / side-lit | 88 / 70 / 76 % ¹ | **98 / 97 / 94 %** |
| … same, dim / backlit room | 1 / 2 % ¹ | **42 / 46 %** (the rest *uncertain* or *pending* with lighting guidance; 0.3 % *mismatch* in dim, see §11) |
| **False identity mismatch**, genuine, per check (3 frames, burst template), any light | 0–0.4 % ¹ | **0–0.1 %** |
| **False swap alarms per 1,000 candidate-hours** during an exam (same session) | 0 | **0** (0 of 754 simulated sessions; resolution note in §6.4) |
| **Swap confirmed within 3 samples (≤ 18 s after a swap at exam start)**, good / typical / side-lit | 86 / 70 / 76 % | **96 / 94 / 93 %** (median 2 samples = 6 s) |
| … **family-member** impostors | 60 / 36 / 48 % | **79 / 74 / 80 %**; **92 / 87 / 93 %** with the engine's per-session normalisation |
| Swap in a **dim / backlit** room, within 3 samples | 1–2 % (frames unusable) | 12 % confirmed; **58–67 % flagged *suspect*** (poor light alone never confirms, by design) |
| Impostor accepted as the candidate at a check, any light (family) | 0 % (0.9–1.9 %) | 0 % (family 0–2.9 %) |
| Flat photo passes the head-turn liveness in a dim room (Monte-Carlo, measured 6° pose noise) | 1.2 % | **0.006 %** |
| Time per analysed frame (640×480, one CPU thread) | ≈ 30 ms idle | +54 % measured on a loaded box, ≈ 45 ms idle (estimate: +1 SFace run for flip TTA; faceless frames +1 detector pass) |

¹ v1 has no calibrated evidence model: the v1 figure is its own check rule (`aggregateFrames`, 3 frames).

**v2.1 (`webcam-v2.1`, after the realistic e2e run).** Two calibration failures were found and fixed; details in
§4 (gate) and §6.5 (evidence), numbers in §8.1.

| Question (webcam simulator + e2e replica) | v2.0 | **v2.1** |
|---|--:|--:|
| Look-alike swap in the candidate's **own dim / backlit room, reference enrolled in that room**: *suspect* within 3 samples (all impostors / look-alikes scoring ≥ 0.35) | 54 / **0 %** dim, 60 / **7 %** backlit | **85 / 86 %** dim, **78 / 66 %** backlit |
| … the same candidate in that room: false *suspect* / confirm per 1,000 h | 0 / 0 | **0 / 0** |
| Dim-enrolled candidate, light switched on (reference poor, probes good): false confirms per 1,000 h | 47 | **9** (2 failed dim galleries) |
| Backlit frames usable (face contrast 5–7 with a confident detection) | 45 % | **57 %** |
| Backlit resume, first-attempt pass (6 frames), impostor accepted at a check | 62 % / 0.06 % | **71 % / 0.09 %** |

**What changed.** File references are to `apps/server/src/vision`.

1. **Quality gate v2** (`quality.ts` `QUALITY_GATE`). The gate now refuses a frame only where face recognition
   itself breaks down: contrast < 7 (< 5 for a confidently detected face, v2.1), brightness < 40, inter-eye distance < 20 px, detector score < 0.65,
   |yaw| > 30°, strong blur, a cut-off face or extra faces. Every other frame is usable and falls into a
   good / fair / poor **quality bucket** (`calibration.ts` `qualityBucket`). The v1 gate is kept as
   `QUALITY_GATE_V1` for evaluation.
2. **Low-light detection pass** (`engine.ts`, `image.ts` `enhanceForDetection`). When YuNet finds no face, it
   runs a second pass on a denoised, CLAHE-enhanced copy. Dim and backlit face detection rises from 64 % to about
   90 %. Faces found only this way are capped at detector score 0.79, which puts them in the poor bucket.
3. **Embedding model id 2** (`embed-prep.ts` `RECIPE_V2`, `embeddings.ts`). Good and fair frames use flip
   test-time augmentation. Poor frames use a 3×3 denoised crop instead (poor-light EER 10.6 → 8.0 %).
   Contrast, gamma and CLAHE normalisations all made results worse. Stored v1 references remain compatible.
4. **Templates.** `identity.ts` adds `templateFrom` and `scoreAgainst`. The engine now compares the mean of
   the probe burst with the mean of the gallery instead of taking the max over reference frames.
5. **Calibrated evidence** (`calibration.ts`). Each bucket has a likelihood-ratio model with conservative
   tails and a monotone, clamped LLR, plus windowed SPRT thresholds. Positive evidence from poor-quality
   frames is capped below the confirm threshold, so poor light alone never confirms a swap. Per-frame
   `mismatch` labels are quality-aware (`identity.ts` `decideIdentity`). Shared `DEFAULT_IDENTITY_THRESHOLDS`
   are now 0.45 / 0.30.
6. **Liveness** (`liveness.ts`). A head-turn step now needs 2 agreeing frames. Identity-consistency floors
   depend on the quality bucket, and `checkStepFrame` reports progress for each step.

## 1. What was wrong

The product owner tested with a real laptop webcam: a returning student needed several attempts to resume, and a
person swap right after the exam started was not detected. Both have the same root cause. The v1 quality gate
(`QUALITY_GATE_V1`: face contrast ≥ 18, brightness ≥ 40, sharpness ≥ 80, inter-eye ≥ 28 px, |yaw| ≤ 25°) was tuned on
well-lit portrait photos. On webcam frames from a dim room or with a window behind the candidate it marked
essentially every frame *unable to verify*, for genuine candidates and impostors alike, so:

* checks looped on "try again" — a candidate enrolled in a dim room could not even build a reference (0 of 34
  identities enrolled in dim or backlit light in the simulation below);
* swaps were never flagged — no usable frame, no evidence;
* where frames did pass, identity v1 compared single frames with the *maximum* over five reference frames and
  needed two consecutive samples below 0.28, which close relatives (family members) often do not reach.

## 2. Data (internal evaluation only)

`pnpm --filter @sp/server eval:fetch-faces` downloads public multi-image identity sets, pinned to commits, from
`raw.githubusercontent.com` into a local cache (`$SP_FACESETS_DIR`, default `/tmp/claude-0/facesets` when present,
else `<tmp>/sp-facesets`). Images are never committed. Manifest and licence notes: `apps/server/src/eval/datasets.ts`
(the fetch script also writes `manifest.json` into the cache; `--audit` lists suspicious labels).

| Source | Licence (code) | Photos used | Identities with ≥ 2 photos | Notes |
|---|---|--:|--:|---|
| Azure-Samples/cognitive-services-sample-data-files `Face/images` | MIT | 16 | 6 | stock photos of **families**: Family1 dad/mom/daughter/son, Family2 lady/man, Family3 lady/man — the hard look-alike impostors (same shoot, same light) |
| justadudewhohacks/face-api.js `examples/images` | MIT | 38 | 8 | 8 actors × 5 TV stills (2 stills without a detectable face are skipped) |
| serengil/deepface `tests/unit/dataset` | MIT | 62 | 13 | identities from `master.csv` + `face-recognition-pivot.csv` same-person pairs |
| ageitgey/face_recognition `examples` | MIT | 14 | 5 | resolution variants of one photo (`obama-240p…`) are not used |
| cmusatyalab/openface `images/examples` | Apache-2.0 | 6 | 2 | |
| timesler/facenet-pytorch `data/test_images` | MIT | 4 (+1 merged) | 0 | impostors only; `angelina_jolie` is the same person as deepface `p01` and is merged |

The photos themselves are sample / test images of those repositories (stock photos or public figures); their
copyright belongs to the respective owners, which is why they are used only locally. Two label problems were
found and fixed with `--audit`: the Azure "person-group" images are byte-identical copies of Family images, and one
actress appears in two sources.

Total: **140 source photos, 43 identities, 34 enrolled identities (≥ 2 photos), 3 families** (8 family members).

## 3. Webcam simulator (`apps/server/src/eval/webcam-sim.ts`)

Every source photo is rendered as laptop-webcam frames. The head and shoulders are cut out with a feathered mask,
scaled to a sampled distance, placed in a synthetic room, and then exposed, lit, blurred, noised, colour-cast and
JPEG-compressed. Rendering is deterministic: the *scene seed* sets placement, light and camera, and the *frame seed*
sets per-frame noise and jitter. A burst shares its scene.

| Parameter | good | typical indoor | dim evening | backlit window | side-lit |
|---|---|---|---|---|---|
| face luma after auto-exposure | 115–165 | 85–130 | **35–75** | **40–85** (window clips) | 70–130 |
| luma / chroma noise σ (8-bit) | 1.5–3 / 1–2 | 3–6 / 2–4 | **6–12 / 4–8** | 4–8 / 2–5 | 3–7 / 2–4 |
| contrast factor, black lift (flare) | 0.95–1.05, 0–4 | 0.8–0.95, 4–10 | 0.6–0.8, 8–18 | 0.6–0.8, **15–35** | 0.85–1, 2–8 |
| optics + NR blur σ, motion blur (px @720p) | 0.5–0.9, 0–1 | 0.7–1.3, 0–2 | 1.0–1.8, 0.5–3 | 0.8–1.3, 0–1.5 | 0.7–1.2, 0–1.5 |
| colour cast R, B gain | ±4 % | +3–12 %, −3–12 % | +10–25 %, −10–25 % | −10 %, +10 % | +0–12 %, −0–12 % |
| side-light ratio (dark/bright side) | 1 | 0.7–1 | 0.6–1 | 0.8–1 | **0.12–0.35** |
| JPEG quality | 85–92 | 75–90 | 70–85 | 75–90 | 75–90 |

Common to all conditions: **640×480 and 1280×720** frames (the candidate client currently uploads ≤ 640×480);
inter-eye distance 35–90 px at 720p (23–60 px at 480p); roll ±3°; placement ±8 % / ±6 %; and burst jitter of ~1 px
and ±0.5° between the frames of one sample.

Why these ranges are realistic for built-in laptop webcams:

* **Sensor and optics.** 1/4"–1/6" sensors with 1.1–1.4 µm pixels and fixed-focus f/2–2.4 plastic lenses, usually
  streaming 720p. Optics, demosaicing and in-ISP noise reduction leave an effective resolution well below the pixel
  grid, hence σ 0.5–0.9 px of blur in good light and more in dim light, where noise reduction smears detail.
* **Geometry.** Horizontal field of view is ~65–78°. A 63 mm inter-pupillary distance at 45–90 cm gives 55–110 px at
  720p; candidates who sit back reach ~35 px.
* **Auto-exposure.** At 20–100 lux, exposure hits its 1/30–1/15 s limit and gain its maximum, so faces are
  under-exposed, noisy and slightly motion-blurred. With a window behind the candidate, centre-weighted metering
  exposes for the bright background, and veiling glare lifts the blacks.
* **Colour and compression.** Auto white balance leaves warm casts under tungsten or warm LED light. Frames are
  compressed twice, by camera MJPEG and by canvas JPEG at quality 0.7–0.92.

The dim condition is deliberately harsh: faces at luma 35–50 correspond to a room lit mostly by the screen.

**What the simulator does not model.** It does not produce real 3-D head pose changes (pose variety comes only
from different photos of the same person), expression changes within a session, glasses glare, rolling-shutter
effects, frame-rate drops or real sensor noise spectra. The source photos are professional or stock pictures of
adults, not candidates.

## 4. Quality gate v2 and quality buckets

**Method.** The target is recognition reliability, not photometry. For each simulated frame we computed the
similarity to a template of the *same photo* rendered in good light, which isolates capture degradation from any
change in identity. We then binned that similarity by every quality measurement (all conditions and resolutions,
9,080 frames). Genuine-to-genuine similarity collapses as follows (p05 is the 5th percentile, med the median):

| face-region contrast (luma std) | 4–6 | 6–8 | 8–10 | 10–12 | 12–15 | 15–18 | 18–22 | ≥ 30 |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| p05 / median similarity | 0.02 / 0.29 | 0.08 / 0.43 | 0.13 / 0.55 | 0.20 / 0.59 | 0.38 / 0.73 | 0.66 / 0.87 | 0.73 / 0.89 | 0.82 / 0.94 |

| face-region brightness | 30–40 | 40–50 | 50–60 | 60–80 | 80–120 | 120–180 |
|---|--:|--:|--:|--:|--:|--:|
| p05 / median | 0.02 / 0.28 | 0.01 / 0.34 | 0.14 / 0.50 | 0.27 / 0.70 | 0.74 / 0.91 | 0.89 / 0.96 |

| detector score (after the low-light cap) | 0.6–0.65 | 0.65–0.75 | 0.75–0.8 | 0.8–0.85 | 0.85–0.9 | ≥ 0.9 |
|---|--:|--:|--:|--:|--:|--:|
| p05 / median | 0.03 / 0.29 | 0.07 / 0.38 | 0.02 / 0.33 | 0.11 / 0.53 | 0.23 / 0.75 | 0.50 / 0.90 |

The same analysis was repeated within each lighting condition, because darkness confounds the pooled figures.
Face size matters little: in good light, frames with an inter-eye distance of 20–24 px still reach p05 0.91 against
the person's template. Head yaw up to ~35° is also harmless, with p05 ≈ 0.5 at 25–35°. Sharpness (Laplacian
variance) is not useful on these frames, because on noisy dim frames it measures noise rather than focus. A
noise-robust "detail" measure and an Immerkær noise estimate were added to `FaceQuality` (`detail`, `noise`,
`clipped`, all optional fields) but did not predict reliability in this data either.

**Gate v2 (unusable ⇒ *unable to verify* + guidance).** A frame is unusable when:

* contrast < 7 — or, since v2.1, < 5 when the detector is confident (score ≥ 0.88; see below);
* brightness < 40 or > 235. Brightness 40 is the same limit as v1: below it, 33–50 % of genuine dim frames collapse
  to a similarity below 0.2;
* inter-eye distance < 20 px (v1: 28);
* detector score < 0.65 (v1: 0.75);
* |yaw| > 30° (v1: 25°) or pitch outside [−35°, 25°];
* sharpness < 80 (strong blur, unchanged);
* the face is cut off, or more than one face is visible (unchanged).

**Confident-detection contrast exception (v2.1, `QUALITY_GATE.minContrastConfident` 5 /
`confidentDetectionScore` 0.88, `quality.ts` `lowContrast`).** A window behind the candidate exposes for the bright
background: veiling glare lifts the blacks and leaves the face with a contrast of 6.6–7.1 (realistic e2e fixture:
face luma 61, lift 25), right at the limit, so ~80 % of backlit resume frames were refused, attempts ended with 1–2
usable frames and the candidate was held after 5 attempts although the usable frames scored 0.74–0.84. Within
contrast 5–7, the detector score separates reliable from unreliable faces: backlit frames with a detection score
≥ 0.88 keep p05 0.39 / median 0.63 against the person's template (2 % below 0.3), unconfident ones 16–42 % below 0.3.
Such frames are admitted and are always in the **poor** bucket (contrast < 12), so their evidence is capped like any
poor frame; faces found only by the low-light pass (score ≤ 0.79) never qualify. Effect (simulator, reference
enrolled in good / typical light): usable backlit frames 45 → 57 %, dim 52 → 61 %; the engine's first-attempt pass
at a backlit resume 38 → 48 % (3 frames) and 62 → 71 % (6 frames), dim 41 → 49 % / 63 → 69 %. Cost: none of the
11,376 impostor frames the exception admits reaches the match threshold (107 score ≥ 0.30); impostors accepted at a
check (`likely_match`) went from 11 to 16 of 18,516 backlit 6-frame attempts (0.06 → 0.09 %) and 3 → 4 of 37,032
3-frame attempts; unchanged in dim (7 → 6, 2 → 2). In the e2e replica (the fixture's scene, 1280×720) all 38 backlit
frames (contrast 6.3–6.7, score ≥ 0.88) become usable (before: 0).

**Buckets** (usable frames, `BUCKET_THRESHOLDS`):

* **poor:** contrast < 12, brightness < 50 (or > 225), detector score < 0.8 (this includes every face found only by
  the low-light pass), inter-eye distance < 24 px, or |yaw| > 25°.
* **good:** contrast ≥ 18, brightness 70–200, detector score ≥ 0.88, inter-eye distance ≥ 32 px and |yaw| ≤ 18°.
* **fair:** everything else.

Usable rate and bucket mix per condition, v2:

| | good | typical | dim | backlit | side-lit |
|---|--:|--:|--:|--:|--:|
| usable frames | 98.9 % | 97.0 % | 54.5 % | 50.8 % | 96.1 % |
| good / fair / poor (of usable) | 78 / 19 / 3 % | 64 / 31 / 5 % | 0 / 17 / 83 % | 1 / 15 / 84 % | 65 / 30 / 5 % |
| main reasons for unusable frames | turned 1 % | turned 2 % | contrast < 7: 29 %, dark: 16 %, turned 8 %, no face 7 % | contrast < 7: 43 %, no face 6 % | blur 2 %, turned 2 % |

With v1, 97–99 % of dim and backlit frames were unusable, and so were 20 % of good-light frames at 640×480 (faces
below 28 px).

**Low-light detection pass.** On 400 dim and backlit frames, YuNet alone found a face in 64 %. The variants tried on
a second pass scored: global normalisation 41 %; CLAHE 44–55 %; Gaussian denoise σ 1.5–2 at 77 %; and denoise
(σ 2 at detector scale) followed by 6×6-tile CLAHE (clip 3) at **91 %**, which was chosen. It found no face in 240
empty dark frames. The pass runs only when the first pass finds nothing, and it is switched off for ID-photo
uploads (`AnalyzeOptions.enhanceLowLight`): a photo whose face only an enhancement can find is not a usable
reference.

Candidates still get guidance when frames are usable but poor: `advisoryGuidance(quality)` returns the *too dark*,
*low contrast* or *too small* guidance for such frames. A per-frame *mismatch* label is never given to a poor frame;
it becomes *inconclusive* with lighting guidance instead.

## 5. Embeddings: flip test-time augmentation, and a denoised crop for poor frames

We compared embeddings of the same frames, scored against 5-frame galleries enrolled in good or typical light, as
burst templates. d′ is the separation of the genuine and impostor distributions. EER is the equal error rate; "x"
means the genuine probe is another photo of the person and "s" the same photo. The final gate is applied. Buckets
are those of §4. Data: all 9,080 frames.

| recipe | good: d′x / EERx | fair: d′x / EERx | poor: d′x / EERx / EERs |
|---|--:|--:|--:|
| raw crop (v1) | 5.56 / 0.14 % | 5.54 / 0.30 % | 2.54 / 10.6 % / 5.6 % |
| raw + flip TTA | 5.59 / 0.14 % | 5.60 / 0.24 % | 2.56 / 10.6 % / 5.6 % |
| 3×3 binomial denoise (single view) | 5.52 / 0.14 % | 5.65 / 0.27 % | 2.81 / 8.3 % / 3.9 % |
| denoise + contrast stretch (gain ≤ 2.5) | 5.37 / 0.79 % | 5.55 / 0.59 % | 2.76 / 9.3 % / 5.6 % |
| **v2: flip TTA; denoise for poor frames** | **5.58 / 0.14 %** | **5.61 / 0.24 %** | **2.84 / 8.0 % / 3.9 %** |

An earlier pass on 7,950 frames with a looser gate compared more normalisations with flip TTA. For good / fair /
poor frames:

* grey-world + robust stretch was worse in every bucket: impostor p99 +0.01–0.02, genuine p05 −0.03;
* gamma to a median of 118 + stretch was worse in every bucket;
* CLAHE had EERx 0.60 % / 1.19 % / 9.1 %, against 0.17 % / 0.30 % / 9.8 % for flip TTA alone;
* using CLAHE only below a contrast of 10, 14 or 18 gave no gain.

SFace normalises contrast internally, so photometric pre-processing mostly amplifies noise, and **noise** is what
hurts SFace in poor light. A light denoise of the aligned crop helps there, while mirroring does not. The v2 recipe
(`embed-prep.ts` `RECIPE_V2`, model id 2) therefore embeds good and fair frames as normalize(e(x) + e(flip x)),
which costs one more SFace run (≈ 13–15 ms on one core), and poor frames as e(denoise(x)) with one run. The bucket
is decided from the frame's quality before embedding (`engine.ts`). The embedding still lives in the same SFace
space.

Latency, measured on a loaded 4-core box with the same frames: raw embedding 86 ms, flip + low-light pass 132 ms per
good-light 640×480 frame (+54 %). On an idle core that is roughly 30 → 45 ms.

**Compatibility with stored references.** Model id 2 is the same network and the same embedding space as id 1.
`serializeEmbeddings` now writes id 2, and `deserializeEmbeddings` accepts both ids. We measured all usable
frames against good/typical-light galleries:

| | same-session p05 / median | other-day p05 / median | impostor p99 | other-day EER |
|---|---|---|---|--:|
| v1 reference, v1 probes | 0.51 / 0.911 | 0.30 / 0.619 | 0.307 | 3.84 % |
| **v1 reference, v2 probes** | 0.56 / 0.913 | 0.34 / 0.627 | 0.309 | **2.88 %** |
| v2 reference, v2 probes | 0.57 / 0.917 | 0.34 / 0.628 | 0.309 | 2.88 % |

**No migration is needed.** References stored before the change work as they are and get the full benefit of
the new probes.

## 6. Templates, bursts and the calibrated evidence model

### 6.1 Galleries and bursts

The data has 5 enrolment frames per identity and condition, and 3-frame probe bursts. The 5 frames come from one
photo with session-level jitter, so natural variation is under-represented:

| scoring | all probes: d′x / EERx | dim + backlit: d′x / EERx |
|---|--:|--:|
| 1 enrolment frame, single probe frame (v1-like) | 5.00 / 0.69 % | 2.38 / 13.0 % |
| 5-frame template, single frame | 5.26 / 0.38 % | 2.36 / 13.0 % |
| 5-frame max-over-gallery, single frame | 5.25 / 0.48 % (impostor p99 0.335 vs 0.313) | 2.36 / 13.1 % |
| **5-frame template, burst-of-3 template (`scoreAgainst`)** | **5.39 / 0.30 %** | **2.55 / 10.8 %** |
| 5-frame max-over-gallery, burst template | 5.39 / 0.30 % (impostor p99 0.335, family p99 0.495) | 2.55 / 10.8 % |

This table was measured with flip-TTA embeddings for every frame.

**Recommendation.** Enrol at least 5, and up to 8, near-frontal frames, and score with the **mean template**
(`templateFrom`). Take bursts of 3 and score the **burst template** against the gallery template
(`scoreAgainst(probes, gallery)`). Max-over-gallery has the same EER but fatter impostor tails, which matter for
family members.

### 6.2 LLR model per bucket (`BUCKET_MODELS`, `sampleLLR`)

The model is Gaussian per bucket, fitted on burst-template scores with the reference enrolled in good or typical
light. Genuine means *another photo* of the person, which is the cross-session case; impostor means everyone
else, including family.

| bucket | genuine fit (n) | impostor fit (n) | model used (sd × 1.15) |
|---|---|---|---|
| good | 0.666 ± 0.114 (1,518) | 0.098 ± 0.090 (74,656) | N(0.67, 0.13) vs N(0.10, 0.10) |
| fair | 0.647 ± 0.104 (764) | 0.095 ± 0.090 (35,184) | N(0.65, 0.12) vs N(0.10, 0.10) |
| poor (denoised crop) | 0.490 ± 0.160 (948) | 0.076 ± 0.095 (43,250) | N(0.49, 0.18) vs N(0.08, 0.11) |

Both densities carry a 1 % uniform floor, which gives conservative tails. `sampleLLR` evaluates the log-ratio
only between the impostor mean and the genuine mean, so it is monotone: a higher score is never weaker evidence of
the same person. It is then clamped to ±`llrClamp` = 5.

Genuine drop below the candidate's own enrolment baseline (the gallery's leave-one-out similarity),
`GENUINE_DRIFT`:

| drift, mean ± sd (p99) | good | fair | poor |
|---|---|---|---|
| same session (`continuous`) | 0.02 ± 0.04 (0.14) | 0.06 ± 0.09 (0.41) | 0.21 ± 0.20 (0.70) |
| another photo / day (`relaxed`, pessimistic) | 0.28 ± 0.11 (0.54) | 0.30 ± 0.11 (0.57) | 0.43 ± 0.18 (0.86) |
| family impostor | 0.76 ± 0.11 | 0.77 ± 0.11 | 0.79 ± 0.14 |
| other impostor | 0.85 ± 0.09 | 0.85 ± 0.11 | 0.83 ± 0.15 |

### 6.3 Per-comparison labels (`CALIBRATION.match` / `mismatch`, shared defaults)

Burst templates, reference enrolled in good or typical light:

* **match ≥ 0.45**: 0.00 % of non-family impostors and 1.6 % of family bursts score this high (at 0.48: 0.55 %;
  at 0.50: 0.18 %). Genuine: 98 % of same-session bursts and 85 % of other-day bursts.
* **mismatch < 0.30**, together with the LLR guard: 0.04 % of good or fair other-day genuine bursts are labelled
  mismatch (at 0.28: 0 %), and 93.3 % of impostor bursts are (at 0.28: 92.6 %). Poor frames are never labelled
  mismatch (`decideIdentity`); without that rule, 3.2 % of poor other-day genuine bursts would be.
* **ID photo:** 0.42 / 0.24, unchanged; there is no ID-photo data here.

### 6.4 Sequential swap test (`CALIBRATION.sprt`)

**Accumulator** (the identity engine implements it in `services/identity-evidence.ts`):

* Clamped per-sample LLRs are summed over the last `maxSamples` = 8 samples.
* Positive evidence from poor-bucket samples counts at most `maxPoorEvidence` = 4 in total (`windowEvidence`).
* sum ≥ `suspect` = 3 ⇒ suspect; sum ≥ `confirm` = 7 ⇒ confirmed; sum ≤ `clear` = −6 ⇒ window cleared.
* Unusable samples contribute nothing.
* Because 5 < 7, at least 2 fair or good samples are needed to confirm.

`prior` = 0.001 is used only to show a posterior (`posteriorSwap`).

**Simulation.** Each genuine or impostor *session* is one reference × one probe photo × one condition × one
resolution. Its samples are drawn from its own observed bursts, plus sample-to-sample noise. That noise is the
frame scatter inside bursts divided by √3, plus a movement term (good-light scene-to-scene scatter): sd 0.026 /
0.029 / 0.040 for good / fair / poor. Consecutive samples therefore share person, room, camera and light (strong
positive correlation), which is the realistic, pessimistic assumption for false alarms. The sampling cadence is
every 6 s for 3 min, then every 15 s (258 samples per hour). Parameters were chosen by grid search:

| (suspect, confirm, clear, window, clamp, poor cap) | FA/1000 h same session | FA/1000 h other day | swap ≤ 3 samples, good / typical | family ≤ 3, good / typical | dim / backlit swaps |
|---|--:|--:|--:|--:|---|
| (3, 7, −6, 8, 5, **no cap**) | 4.5 (dim 7.1, backlit 11.2; 3 of 754 sessions) | 40 (dim 103, backlit 73) | 97 / 95 % | 78 / 77 % | confirmed ≤ 3: 27–34 % |
| (4, 9, −6, 8, 6, 4) | 0 | 1.4 | 94 / 92 % | 74 / 71 % | suspect ≤ 3: 46–54 % |
| **(3, 7, −6, 8, 5, 4) — chosen** | **0** | **2.0** (final recipe: 1.3) | **96 / 94 %** | **78 / 75 %** | suspect ≤ 3: 49–58 % (final: 58–67 %) |
| (3, 6, −6, 8, 5, 4) | 0 | 2.6 | 96 / 94 % | 80 / 76 % | suspect only |

The grid was run on flip-TTA embeddings before poor frames switched to the denoised crop. The chosen row, re-measured
with the final recipe, is in §8: 0 same-session and 1.3 other-day false alarms per 1,000 h, dim and backlit
*suspect* ≤ 3 samples 67 % and 58 %. Without the poor-evidence cap, 10 % of dim-room and 7 % of backlit genuine
candidates coming back on another day
alarmed within an hour, and 3 of 754 same-session candidates did. With it, poor light produces *suspect* (faster sampling, lighting guidance, an uncertain observation for
staff), and confirmation waits for a usable frame of fair or better quality.

**Resolution of the false-alarm estimate.** In 754 same-session genuine sessions × 60 simulated hours, no
session ever confirmed a swap. The data cannot, however, exclude that up to 3 in 754 (0.4 %) such sessions exist in
reality (95 % bound). If they did, the rate would be ≤ 4 per 1,000 candidate-hours. Establishing ≤ 1 per 1,000 h
needs ≥ 3,000 real genuine sessions (§10).

### 6.5 Reference-conditional and same-session evidence (v2.1)

**The failure.** Realistic e2e (real browser and server, simulator video): candidate A enrolled in a dim room at
640×480; person B (SFace 0.25–0.36 to A in good light) sat down in the same room. B's burst templates scored
0.52–0.59 against A's dim gallery (single frames 0.32–0.51; A's own frames 0.72–0.82), were labelled *match* and the
evidence stayed *consistent* for 45 s. Two causes: the models of §6.2 were fitted on references enrolled in good
light, and a poor-light gallery lifts **everybody's** score in that room (same noise, exposure and colour, and a
template averages the identity noise away but keeps the shared capture); and cross-session genuine scores in poor
light spread from 0.2 to 0.9, so no global model can call 0.55 "someone else".

**Reference-conditional cross-session models (`REFERENCE_MODELS`, `bucketModel(bucket, reference)`,
`referenceBucket`, `referenceClass`).** Fitted on 37 simulated galleries enrolled in dim or backlit light (sds
× 1.15): against a poor-light reference, genuine good / fair / poor probes score N(0.49, 0.155) / N(0.52, 0.15) /
N(0.47, 0.165), impostors N(0.07, 0.107) / N(0.08, 0.11) / N(0.10, 0.125). Good and fair references keep
`BUCKET_MODELS` exactly. `sampleLLR(s, bucket, { reference })` uses them; without a context `sampleLLR` is unchanged.

**Same-session model for a poor-light reference and a poor probe (`CONTINUOUS_MODEL`, `continuousLLR`,
`continuousApplies`).** What does separate B from A is A's **own** level in that room. New simulator data (`room`
frames, `WebcamDataOptions.room`): probes rendered in the enrolment scene of each host (same room, camera and light):
the host again (2 bursts, new frame noise and small movements), the same person from other photos, and 12 other
people plus family members sitting down there — 1,165 same-room sessions over dim / backlit / typical rooms.
Against a poor-light gallery (leave-one-out baseline b):

| same room, poor probe vs poor-light gallery (leave-one-out baseline b) | burst template |
|---|---|
| the candidate | score − b: median +0.14 (dim) / +0.10 (backlit); 1st percentile −0.08 (single frames: median 0.0, 1st percentile −0.2) |
| impostors incl. family (n 385 sessions) | score 0.16 ± 0.12, 99th percentile 0.46, max 0.57 |
| the same person, other photo (another day) | score − b: median −0.11 (dim) / −0.18 (backlit); 5th percentile −0.33 / −0.45 |

The model: genuine s ~ N(b − drift, √(drift.sd² + b.sd²/n)) with drift N(−0.06, 0.078) for a burst template and
N(0.04, 0.09) for a single frame (means conservative, sds with a margin for pose / expression the simulator does not
render); alternative = 0.8 × N(0.16, 0.13) + 0.2 × uniform look-alike on [−0.1, personal mean]; evaluated between
the impostor mean and the personal mean (monotone), clamped ±5. It applies only when `continuousApplies(bucket,
ctx)`: context `'continuous'` (the active period in which the reference was enrolled — never after a resume,
reconnect, camera change or reverify), a usable baseline (n ≥ 3), a poor-light reference **and** a poor probe.
Everything else uses the reference-conditional cross-session model (the engine keeps its per-session
normalisation there). Why so narrow: applied across a change of light or camera it raised false alarms by an order
of magnitude — e.g. a dim-enrolled candidate after the light is switched on, or a different dim room and camera
(the simulator's cross-scene sessions: 250 false *suspects* per 1,000 h, and false confirms from fair frames). When
the light improves after a poor-light enrolment (fair / good probe), the engine now normalises 'relaxed' even
mid-exam: false confirms in that situation 47 → 9 per 1,000 h (the remaining 2 sessions are dim galleries with a
baseline ≈ 0.6 that do not recognise the person in good light at all — an enrolment problem).

The per-sample label follows the evidence: with the sample's LLR (`decideIdentity(…, { llr })`, engine
`sampleLabel(…, llr)`), *match* also needs LLR ≤ −1 (`MATCH_MAX_LLR`) — B's dim-room templates are *inconclusive*.
Poor light still never confirms (`maxPoorEvidence` 4 < `confirm` 7): a dim-room look-alike becomes *suspect*
(faster sampling, lighting guidance, an uncertain observation for staff) and is confirmed once a fair or good frame
agrees.

**Self-derived only.** No cohort of other people's images or embeddings is used or shipped: the models are
per-bucket distributions (six numbers each) fitted offline on the simulator, and the only per-person input is the
candidate's own enrolment baseline.

## 7. Liveness under webcam noise

**Pose noise under the simulator.** Five-point yaw was measured on frames of one burst (same scene, sub-pixel
jitter). Its standard deviation was **2.5° in good light, 2.7° typical, 2.9° side-lit, 4.3° backlit and 5.9°
dim**; pitch was similar. Across scenes of the same photo, where face size and placement change, the sd is 9–12°.
This is why liveness always measures relative to the candidate's own frontal frames from the same check.

**Step rule.** v1 passed a step on the *best* of the first 3 frames of a window, with 2 windows per step
(`MAX_STEP_ATTEMPTS`). Under dim-room noise, a flat photo therefore sometimes passed by luck. v2 applies these
rules:

* When a window has ≥ 2 identity-consistent frames, the *second-best* frame must reach **50 %** of the target
  (10° of 20°): `minFramesAgreeing` 2, `agreeingFractionOfTarget` 0.5.
* A single frame must still reach 60 %.

A Monte-Carlo run with the centre taken as the median of 3 frontal frames and 2 windows per step gives:

| per-frame pose noise | rotated flat photo passes, v1 → v2 | real 20° turn passes, v1 → v2 | real 15° turn |
|---|--:|--:|--:|
| 2.5° (good light) | 0 → 0 % | 100 → 100 % | 99.4 → 99.5 % |
| 4.3° (backlit) | 0.02 → 0 % | 99.95 → 99.8 % | 97 → 93 % |
| 6° (dim) | **1.2 → 0.006 %** | 99.6 → 98.3 % | 95 → 84 % |

A client that sends only one frame per window keeps the v1 behaviour for that window. **Clients should send 2–3
frames per step while the pose is held.** A new test covers a flat photo with a noisy outlier frame
(`liveness.test.ts`). The anti-photo parallax test is unchanged and passes.

**Identity consistency inside the challenge** (`FRONTAL_MIN_SIMILARITY`, `TURNED_MIN_SIMILARITY`, per bucket). v1
required every *pair* of frontal frames to be ≥ `match` (0.45). In a dim room, 5 % of genuine frames fall below
that (p01 0.30), which failed liveness for no reason. v2 compares each frontal frame with the template of the other
frontal frames. The floors are:

* frontal: 0.45 good, 0.40 fair, 0.30 poor. Genuine p01 was 0.94 in good light, 0.83 typical, 0.30 dim;
  different people p99 was 0.31–0.37.
* turned frames against the frontal template: 0.30, or 0.25 for poor frames. Genuine turned frames at |yaw| 15–35°
  had p05 0.41–0.54 in good or typical light and about 0.24–0.4 in poor light.

**`checkStepFrame`** returns `satisfied` (this single frame reaches 60 % of the target), `measured`,
`directionalDeg`, `requiredDeg` and `progress` (0–1, for a progress bar). Without a centre it assumes yaw 0° and
pitch −10°, which is how YuNet reads a frontal face. The authoritative result is still `verifyLiveness` over the
step's window.

## 8. Before / after

Produced by `pnpm --filter @sp/server eval:identity -- --webcam --markdown …` (the JSON is in `docs/accuracy/identity-v2-webcam.json`). *Same-session* means the enrolment photo re-captured in another scene or light (mid-exam). *Other day* means other photos of the person (resume; pessimistic). *Mismatch* for a genuine candidate is the critical error; *match* for an impostor is a missed swap.

Calibration `webcam-v2.0`; 140 source photos, 34 enrolled identities, 3 families, 9080 simulated frames.

**Enrolment** (5 check-in frames in the condition; a reference needs 3 usable frontal frames)

| | good | typical | dim | backlit |
|---|--:|--:|--:|--:|
| v1 (legacy) | 28/34 | 24/34 | 0/34 | 0/34 |
| v2 (current) | 34/34 | 34/34 | 16/34 | 21/34 |

**Per-frame decisions (reference enrolled in good or typical light)**

| condition | pipeline | genuine same-session: match / inconcl. / unable / **mismatch** | genuine other day: match / inconcl. / unable / **mismatch** | impostor: mismatch / inconcl. / unable / **match** | family impostor: mismatch / unable / **match** |
|---|---|---|---|---|---|
| all | v1 | 50.9 % / 0.0 % / 49.1 % / **0.0 %** | 47.2 % / 1.9 % / 50.8 % / **0.1 %** | 47.3 % / 1.6 % / 51.1 % / **0.0 %** | 31.7 % / 56.2 % / **1.0 %** |
| all | v2 | 76.1 % / 2.2 % / 21.7 % / **0.0 %** | 67.1 % / 12.5 % / 20.3 % / **0.1 %** | 58.5 % / 21.0 % / 20.6 % / **0.0 %** | 49.6 % / 21.7 % / **1.0 %** |
| good | v1 | 88.3 % / 0.0 % / 11.7 % / **0.0 %** | 87.9 % / 2.3 % / 9.8 % / **0.0 %** | 86.8 % / 3.3 % / 9.9 % / **0.0 %** | 64.3 % / 10.4 % / **2.2 %** |
| good | v2 | 99.3 % / 0.0 % / 0.7 % / **0.0 %** | 95.2 % / 3.4 % / 1.4 % / **0.0 %** | 94.1 % / 4.7 % / 1.1 % / **0.0 %** | 78.3 % / 1.0 % / **1.3 %** |
| typical | v1 | 79.5 % / 0.0 % / 20.5 % / **0.0 %** | 69.9 % / 2.2 % / 27.9 % / **0.0 %** | 70.0 % / 2.2 % / 27.8 % / **0.0 %** | 40.4 % / 43.7 % / **1.7 %** |
| typical | v2 | 98.3 % / 0.0 % / 1.7 % / **0.0 %** | 92.0 % / 4.2 % / 3.8 % / **0.0 %** | 90.6 % / 6.4 % / 3.0 % / **0.0 %** | 75.4 % / 2.9 % / **2.0 %** |
| dim | v1 | 3.5 % / 0.0 % / 96.5 % / **0.0 %** | 1.1 % / 0.0 % / 98.9 % / **0.0 %** | 1.2 % / 0.0 % / 98.8 % / **0.0 %** | 0.0 % / 100.0 % / **0.0 %** |
| dim | v2 | 44.4 % / 7.4 % / 48.3 % / **0.0 %** | 28.6 % / 27.3 % / 44.0 % / **0.1 %** | 9.4 % / 45.0 % / 45.5 % / **0.0 %** | 8.2 % / 37.7 % / **0.2 %** |
| backlit | v1 | 2.4 % / 0.0 % / 97.6 % / **0.0 %** | 1.8 % / 0.2 % / 97.9 % / **0.1 %** | 1.9 % / 0.0 % / 98.0 % / **0.0 %** | 0.0 % / 100.0 % / **0.0 %** |
| backlit | v2 | 41.4 % / 3.4 % / 54.9 % / **0.2 %** | 31.4 % / 20.7 % / 47.7 % / **0.2 %** | 8.2 % / 42.6 % / 49.2 % / **0.0 %** | 3.7 % / 64.2 % / **0.1 %** |
| sidelit | v1 | 80.6 % / 0.0 % / 19.4 % / **0.0 %** | 75.2 % / 4.7 % / 19.6 % / **0.6 %** | 76.8 % / 2.5 % / 20.7 % / **0.0 %** | 53.9 % / 27.0 % / **1.3 %** |
| sidelit | v2 | 97.1 % / 0.0 % / 2.9 % / **0.0 %** | 88.1 % / 7.0 % / 4.5 % / **0.4 %** | 90.0 % / 6.1 % / 3.9 % / **0.0 %** | 82.6 % / 2.5 % / **1.2 %** |

**Checks: the 3 frames of one burst decided together (v1: aggregateFrames; v2: burst template vs gallery template)**

| condition | pipeline | genuine same-session: match / inconcl. / unable / **mismatch** | genuine other day: match / inconcl. / unable / **mismatch** | impostor: mismatch / inconcl. / unable / **match** | family impostor: mismatch / unable / **match** |
|---|---|---|---|---|---|
| all | v1 | 50.5 % / 2.2 % / 47.3 % / **0.0 %** | 47.3 % / 4.0 % / 48.7 % / **0.1 %** | 47.0 % / 4.2 % / 48.8 % / **0.0 %** | 31.7 % / 55.2 % / **0.9 %** |
| all | v2 | 79.2 % / 1.7 % / 19.1 % / **0.0 %** | 70.9 % / 12.4 % / 16.8 % / **0.0 %** | 58.5 % / 24.2 % / 17.3 % / **0.0 %** | 48.7 % / 19.3 % / **1.3 %** |
| good | v1 | 87.5 % / 2.4 % / 10.1 % / **0.0 %** | 88.1 % / 3.9 % / 8.0 % / **0.0 %** | 86.6 % / 5.5 % / 7.8 % / **0.0 %** | 63.7 % / 8.5 % / **1.9 %** |
| good | v2 | 99.3 % / 0.0 % / 0.7 % / **0.0 %** | 96.0 % / 3.2 % / 0.8 % / **0.0 %** | 94.2 % / 5.1 % / 0.7 % / **0.0 %** | 77.2 % / 0.7 % / **1.5 %** |
| typical | v1 | 79.3 % / 4.3 % / 16.3 % / **0.0 %** | 70.0 % / 6.9 % / 23.0 % / **0.0 %** | 69.7 % / 7.2 % / 23.1 % / **0.0 %** | 41.0 % / 42.0 % / **1.9 %** |
| typical | v2 | 99.3 % / 0.0 % / 0.7 % / **0.0 %** | 94.6 % / 3.1 % / 2.3 % / **0.0 %** | 90.7 % / 7.5 % / 1.8 % / **0.0 %** | 73.9 % / 2.9 % / **2.6 %** |
| dim | v1 | 2.9 % / 1.9 % / 95.2 % / **0.0 %** | 1.1 % / 0.0 % / 98.9 % / **0.0 %** | 0.9 % / 0.5 % / 98.6 % / **0.0 %** | 0.0 % / 100.0 % / **0.0 %** |
| dim | v2 | 51.8 % / 6.3 % / 41.9 % / **0.0 %** | 35.8 % / 27.8 % / 36.3 % / **0.0 %** | 9.7 % / 52.0 % / 38.2 % / **0.0 %** | 7.4 % / 30.9 % / **0.7 %** |
| backlit | v1 | 2.4 % / 0.0 % / 97.6 % / **0.0 %** | 1.8 % / 1.4 % / 96.8 % / **0.0 %** | 1.6 % / 1.5 % / 97.0 % / **0.0 %** | 0.0 % / 100.0 % / **0.0 %** |
| backlit | v2 | 48.5 % / 2.2 % / 49.3 % / **0.0 %** | 36.0 % / 22.3 % / 41.8 % / **0.0 %** | 8.5 % / 48.1 % / 43.4 % / **0.0 %** | 4.0 % / 59.6 % / **0.0 %** |
| sidelit | v1 | 80.3 % / 2.4 % / 17.3 % / **0.0 %** | 75.5 % / 7.6 % / 16.5 % / **0.4 %** | 76.4 % / 6.2 % / 17.3 % / **0.0 %** | 53.8 % / 25.5 % / **0.9 %** |
| sidelit | v2 | 97.1 % / 0.0 % / 2.9 % / **0.0 %** | 91.9 % / 5.4 % / 2.6 % / **0.1 %** | 89.4 % / 8.1 % / 2.5 % / **0.0 %** | 80.9 % / 2.2 % / **1.8 %** |
| good@640x480 | v1 | 78.8 % / 1.0 % / 20.2 % / **0.0 %** | 80.9 % / 5.0 % / 14.2 % / **0.0 %** | 79.5 % / 6.2 % / 14.2 % / **0.0 %** | 57.5 % / 15.1 % / **1.9 %** |
| good@640x480 | v2 | 98.5 % / 0.0 % / 1.5 % / **0.0 %** | 96.1 % / 2.8 % / 1.0 % / **0.0 %** | 92.7 % / 6.2 % / 1.1 % / **0.0 %** | 76.5 % / 1.5 % / **1.5 %** |
| good@1280x720 | v1 | 96.2 % / 3.8 % / 0.0 % / **0.0 %** | 95.4 % / 2.8 % / 1.8 % / **0.0 %** | 93.8 % / 4.8 % / 1.4 % / **0.0 %** | 69.8 % / 1.9 % / **1.9 %** |
| good@1280x720 | v2 | 100.0 % / 0.0 % / 0.0 % / **0.0 %** | 95.9 % / 3.6 % / 0.5 % / **0.0 %** | 95.7 % / 3.9 % / 0.4 % / **0.0 %** | 77.9 % / 0.0 % / **1.5 %** |
| dim@640x480 | v1 | 1.9 % / 3.8 % / 94.2 % / **0.0 %** | 0.7 % / 0.0 % / 99.3 % / **0.0 %** | 0.7 % / 0.7 % / 98.6 % / **0.0 %** | 0.0 % / 100.0 % / **0.0 %** |
| dim@640x480 | v2 | 50.0 % / 8.8 % / 41.2 % / **0.0 %** | 24.7 % / 35.6 % / 39.7 % / **0.0 %** | 8.6 % / 51.8 % / 39.6 % / **0.0 %** | 8.8 % / 26.5 % / **0.0 %** |
| dim@1280x720 | v1 | 3.8 % / 0.0 % / 96.2 % / **0.0 %** | 1.4 % / 0.0 % / 98.6 % / **0.0 %** | 1.1 % / 0.4 % / 98.6 % / **0.0 %** | 0.0 % / 100.0 % / **0.0 %** |
| dim@1280x720 | v2 | 53.7 % / 3.7 % / 42.6 % / **0.0 %** | 46.9 % / 20.1 % / 33.0 % / **0.0 %** | 10.9 % / 52.2 % / 36.8 % / **0.0 %** | 5.9 % / 35.3 % / **1.5 %** |

**Resume / reconnect checks as the identity engine decides them** (`assessCheck`, relaxed context): pass / uncertain / pending (too few usable frames) / **mismatch**, with 3 frames → 6 frames

| condition | genuine same-session | genuine other day | impostor | family impostor |
|---|---|---|---|---|
| all | 74.3 / 4 / 21.8 / **0** → 84.7 / 3.8 / 11.5 / **0** | 63.5 / 16.6 / 19.9 / **0** → 75.3 / 14.8 / 9.9 / **0.1** | 0 / 24.7 / 20.3 / **54.9** → 0 / 18.3 / 10.4 / **71.4** | 0.3 / 35.5 / 20.9 / **43.3** → 1.5 / 25.4 / 11.8 / **61.3** |
| good | 99.3 / 0 / 0.7 / **0** → 100 / 0 / 0 / **0** | 93.3 / 5.7 / 1 / **0** → 97.7 / 2.3 / 0 / **0** | 0 / 9.5 / 0.9 / **89.6** → 0 / 1.5 / 0 / **98.4** | 0.4 / 31.3 / 0.7 / **67.6** → 2.2 / 10.3 / 0 / **87.5** |
| typical | 97.8 / 0 / 2.2 / **0** → 100 / 0 / 0 / **0** | 87.4 / 9 / 3.6 / **0** → 97.2 / 1.8 / 1 / **0** | 0 / 11.3 / 3 / **85.6** → 0 / 2.5 / 0.7 / **96.7** | 1.1 / 27.2 / 2.9 / **68.8** → 2.9 / 11.8 / 0 / **85.3** |
| dim | 40.4 / 12.5 / 47.1 / **0** → 63.2 / 13.2 / 23.5 / **0** | 24.9 / 31.6 / 43.6 / **0** → 41.8 / 37.9 / 20.1 / **0.3** | 0 / 47 / 45 / **8** → 0 / 43 / 22.2 / **34.8** | 0 / 58.8 / 35.3 / **5.9** → 0 / 59.6 / 10.3 / **30.1** |
| backlit | 36.8 / 7.4 / 55.9 / **0** → 60.3 / 5.9 / 33.8 / **0** | 28.5 / 23.8 / 47.7 / **0** → 46.1 / 26 / 27.8 / **0** | 0 / 44.1 / 49.5 / **6.4** → 0 / 41.8 / 28.5 / **29.6** | 0 / 33.8 / 63.2 / **2.9** → 0 / 39 / 48.5 / **12.5** |
| sidelit | 97.1 / 0 / 2.9 / **0** → 100 / 0 / 0 / **0** | 83.2 / 13.1 / 3.6 / **0** → 93.6 / 5.9 / 0.5 / **0** | 0 / 11.8 / 3.2 / **85** → 0 / 2.4 / 0.4 / **97.2** | 0 / 26.5 / 2.2 / **71.3** → 2.2 / 6.6 / 0 / **91.2** |

**Swap detection during the exam** (simulated sequences, sampling every 6 s for 3 min then 15 s, bursts of 3)

| condition | pipeline | false confirmed swaps / 1000 h, same session | … other day (resume) | swap confirmed ≤ 3 samples | median samples | family ≤ 3 samples | suspect ≤ 3 samples |
|---|---|--:|--:|--:|--:|--:|--:|
| good | v1 | 0 | 0 | 85.5 % | 2 | 60.4 % | 88.4 % |
| good | v2 | 0 | 0 | 95.9 % | 2 | 78.8 % | 99.0 % |
| good | v2 + session normalisation | 0 | 25.258 | 97.4 % | 2 | 92.0 % | 99.6 % |
| typical | v1 | 0 | 0 | 70.2 % | 2 | 36.0 % | 74.3 % |
| typical | v2 | 0 | 0 | 93.6 % | 2 | 74.3 % | 98.3 % |
| typical | v2 + session normalisation | 0 | 9.235 | 95.1 % | 2 | 86.8 % | 98.9 % |
| dim | v1 | 0 | 0 | 1.3 % | never (median) | 0.0 % | 1.4 % |
| dim | v2 | 0 | 0.177 | 12.5 % | never (median) | 11.1 % | 66.6 % |
| dim | v2 + session normalisation | 0 | 10.593 | 12.7 % | never (median) | 11.3 % | 68.4 % |
| backlit | v1 | 0 | 7.092 | 2.2 % | never (median) | 0.0 % | 2.9 % |
| backlit | v2 | 0 | 2.05 | 11.5 % | never (median) | 5.4 % | 57.8 % |
| backlit | v2 + session normalisation | 0 | 17.07 | 11.7 % | never (median) | 5.7 % | 60.5 % |
| sidelit | v1 | 0 | 23.286 | 75.5 % | 2 | 48.0 % | 79.9 % |
| sidelit | v2 | 0 | 4.081 | 92.8 % | 2 | 79.7 % | 97.9 % |
| sidelit | v2 + session normalisation | 0 | 27.148 | 94.2 % | 2 | 93.3 % | 98.5 % |

### 8.1 v2.1: same-room monitoring and the backlit gate

The tables above are `webcam-v2.0`. v2.1 changes only (a) which frames with contrast 5–7 are usable and (b) the
evidence against poor-light references; good-light results are unchanged. The report's new section
*Same room and light as the enrolment* (`eval:identity -- --webcam`) produces the plain-calibration rows; the
engine rows use the identity engine's `comparisonLLR` in the 'continuous' context (burst templates scored with their
frame count). Genuine sessions are simulated for 3 h each (40 runs); per-sample noise as in §6.4.
(`identity-v2-webcam.json` and the tables above remain the v2.0 run.)

| candidate's own room, reference enrolled there | v2.0 engine | **v2.1 engine** | v2.1, templates scored as single frames ² |
|---|--:|--:|--:|
| dim: the candidate, false suspect / confirm per 1,000 h (14 sessions) | 0 / 0 | **0 / 0** | 0 / 0 |
| dim: impostor or family, *suspect* ≤ 3 samples / ever (172) | 54 / 64 % | **85 / 86 %** | 83 / 86 % |
| dim: look-alikes (mean score ≥ 0.35), *suspect* ≤ 3 samples (11) | 0 % | **86 %** | 60 % |
| dim: confirmed ≤ 3 samples (needs a fair / good frame) | 9 % | 5 % | 5 % |
| backlit: the candidate (21) | 0 / 0 | **0 / 0** | 0 / 0 |
| backlit: impostor or family, *suspect* ≤ 3 / ever (253) | 60 / 68 % | **78 / 80 %** | 77 / 79 % |
| backlit: look-alikes ≥ 0.35 (12) | 7 % | **66 %** | 45 % |
| the same person from another photo in that room (another day; not a mid-exam case), false suspect / confirm per 1,000 h | 0–36 / 0–36 | 340–540 / **0** | 110–300 / 0 |

² If the engine does not pass the burst's frame count to `comparisonLLR`, templates are judged by the single-frame
drift (more lenient). Impostor sessions that never reach *suspect* are mostly sessions without a single usable
impostor frame in that light (62 of 418) and impostors whose frames are *fair* (judged by the cross-session model).

Other sessions, v2.0 → v2.1 engine (continuous context, 3 h): reference enrolled in dim / backlit light and the
light switched on (probes good / typical / side-lit) — false confirms per 1,000 h 47 / 28 / 34 → 9 / 9 / 9; a
different dim or backlit room and camera (cross-scene, same bucket; a camera change is a 'relaxed' event in the
engine, so this is a stress test) — false suspects 20 → 128 (dim) and 14 → 86 (backlit) per 1,000 h, confirms 0 → 0;
good-light swap detection unchanged (confirmed ≤ 3 samples 96 / 94 / 93 % good / typical / side-lit).

**E2e replay.** The realistic e2e videos themselves (`e2e/.fixtures/realistic`), decoded as Chromium does (limited-range
YUV) and cropped like the candidate client (2.4× the face box, JPEG 0.92), through the engine's own `buildGallery`,
`aggregateBurst` and `accumulate` in the 'continuous' context:

| fixture | reference (gallery baseline) | v2.0 | **v2.1** |
|---|---|---|---|
| `rwSwapDimBlend480`: A, then B in the same dim room, 640×480 | A dim, 0.79 | B's bursts 0.34–0.56 (the e2e run measured 0.46–0.59) labelled *match*, evidence *consistent* | B: *monitoring* at the 1st sample, ***suspect* at the 2nd**; A's bursts 0.78–0.94 → LLR −2.9 … −3.2 |
| `rwB_dim` vs A enrolled at home, dim, 1280×720 | A dim, 0.88 | *match* / *consistent* | ***suspect* at the 1st sample** (LLR +4.1 … +5 per burst) |
| `rwGenuineDim`: A for 60 s — dim → lamp on → dim → window light (backlit) → dim | A dim, 0.88 | *consistent* | **0 suspects**: every burst ≤ −3 (lamp on: good frames, 'relaxed' normalisation, −5) |

Sensitivity to what the e2e measured (B's bursts 0.52–0.59 in one run, 0.46–0.58 in another; the gallery baseline is
not in the run's metrics): with the burst's frame count passed to `comparisonLLR` (§11), *suspect* by the 1st–3rd
sample for baselines ≥ 0.75 (the 0.46–0.58 run: 1st sample for baselines ≥ 0.66); without it (templates judged by
the single-frame drift) the 0.52–0.59 run never reaches *suspect* and the other only for baselines ≥ 0.8. With the
frame count and the sample's LLR passed to `sampleLabel`, B's bursts are labelled *inconclusive* (LLR > −1) —
staff-visible — for baselines ≥ 0.7, while A's stay *match*.

## 9. Limitations

* **Simulated, not real, webcam frames.** The simulator reproduces exposure, noise, blur, colour casts, compression,
  size and placement. It does not reproduce real head motion, expressions, glasses glare or real sensor noise.
  Genuine *same-session* probes reuse the enrolment photo and are optimistic. Genuine *other-day* probes use other
  photos, some taken years apart, and are pessimistic.
* **Small, unrepresentative identity set.** 34 enrolled adults, 8 family members in 3 families. Public figures and
  stock photos dominate. There is no demographic analysis. Family results rest on 716 family sessions from few
  people.
* **Dim-room candidates are still hard.** About half of dim or backlit frames are unusable: contrast below 7 means
  the face features span fewer than ±10 grey levels. A dim-room check passes on the first attempt in 42–63 % of
  cases with 6 frames, and more with the adaptive 10-frame collection. The rest are *uncertain* or *pending* with
  guidance to add light. The engine's current `assessCheck` still labels 0.3 % of dim-room checks *likely
  mismatch*, because it sums poor-frame evidence without the cap; §11 describes the fix. A swap in a dark room is flagged *suspect* but not confirmed until a
  fair or good frame arrives.
* **Family members.** SFace scores close relatives photographed in the same session up to 0.53. Without
  per-session normalisation, 6–14 % of family swaps in good light go unconfirmed within 40 samples; they still
  raise *suspect* in most cases. The identity engine's normalisation brings detection within 3 samples to 87–93 %.
* **Normalisation across days.** The identity engine's 'continuous' normalisation must not be applied to a session
  that resumed on another day, room or camera. In the simulation it produced 9–27 false alarms per 1,000 h on
  other-day genuine sessions; use the 'relaxed' drift (`GENUINE_DRIFT.relaxed`) after a resume or reconnect.
* **Liveness** still does not detect replayed video of the person turning their head, 3-D masks, or a single-frame
  client that fishes across windows (bounded to 2 windows per step).
* The false-alarm bound in §6.4 is limited by the number of distinct sessions (754), not by Monte-Carlo runs.
* **Same-session model (v2.1).** It rests on 35 simulated dim / backlit candidates re-rendered in their own
  enrolment scene: real mid-exam variation (expressions, larger head movements, glasses, a monitor lighting the
  face) is wider than that, and only a margin in the drift sds covers it. In poor light a genuine change of
  appearance (glasses on / off, hair) can therefore raise *suspect* (never *confirmed*: poor evidence is capped).
  A look-alike whose face is *fair* in the candidate's dim room, or who enters after a resume ('relaxed'), is judged
  by the cross-session model and may go unnoticed until the light improves. A dim gallery that does not recognise
  the person in good light (baseline ≈ 0.6) still produces false alarms when the light is switched on — re-enrol in
  better light.
* **Backlit gate exception.** Admitted frames (contrast 5–7) are poor-bucket evidence; the measured impostor cost
  is ≤ 0.03 percentage points of accepted checks, from simulated backlight only.

## 10. Re-running the measurement

```bash
# 1. fetch the public identity sets (once; ~150 files, ~37 MB) into the cache (frames + analyses add ~0.9 GB)
pnpm --filter @sp/server eval:fetch-faces            # add -- --audit to list suspicious labels
# 2. simulate, analyse (cached), and compare v1 with v2. First run: ~9k frames x 2 engines (tens of minutes on 4
#    cores); re-runs use the caches.
pnpm --filter @sp/server eval:identity -- --webcam --shards 3 --out webcam.json --markdown webcam.md
#    --quick         12 identities, 640x480 only, 1 scene (minutes)
#    --no-legacy     skip the v1 baseline
#    --runs 100      Monte-Carlo runs per session
#    --facesets DIR  cache directory (or SP_FACESETS_DIR)
```

**On your own webcam captures.** This is what you need before relying on the numbers.

1. Record, with consent, check-in frames and later frames per person on your candidates' real laptops. The staff
   identity self-test (`POST /api/admin/tools/identity-test`, mode `enroll` then `probe`) lets an operator do this
   with their own webcam. Aim for at least 30 people, ideally 300 or more, several rooms and lighting conditions,
   and some relatives.
2. Save the frames as a folder dataset: `<dir>/<person>/<tag>[+<tag>]__<n>.jpg`. Tag 5 check-in frames per
   person `reference`, and tag the rest by condition, for example `lighting-dim`, `lighting-backlit`,
   `camera-b`, `pause-1d`, `family-<name>`.
3. Run `pnpm --filter @sp/server eval:identity -- --dataset <dir> --size 0 --out report.json`. This uses the
   production gate, embedding and thresholds: per-condition match / inconclusive / unable / mismatch, similarity
   distributions and ROC.
4. Compare the per-bucket genuine and impostor similarity quantiles in the JSON with §6.2. If your genuine means
   are more than ~0.05 lower, or your impostor p99 is higher, refit `BUCKET_MODELS` and re-run the sequential
   simulation. The grid-search code is in `apps/server/src/eval/webcam-metrics.ts` (`simulateSequential`); feed it
   sessions built from your data. Bump `CALIBRATION.version` whenever the numbers change.
5. Gate go-live on your own data: false mismatch at checks ≤ 0.1 %, swap confirmed within 3 samples ≥ 90 % in
   normal light, and unable-to-verify ≤ 5 % in normal light.

The simulator can also be pointed at your own photos instead of the public sets. Put them in the cache layout
with a manifest (`datasets.ts` `loadFaceset(dir, manifest)`).

## 11. For the identity engine (API summary)

These are the calibration contracts the identity engine codes against, all exported from `vision/index.ts`:

* `qualityBucket(q)` returns `'good' | 'fair' | 'poor'` and applies only to usable frames. Unusable means
  `quality.usable === false`.
* `sampleLLR(similarity, bucket)` is monotone and clamped to ±5. `posteriorSwap(sum, prior?)` converts the
  accumulated evidence to a posterior. `BUCKET_MODELS` holds the per-bucket fits and `GENUINE_DRIFT` the measured
  per-session drift.
* `CALIBRATION` = `{ version: 'webcam-v2.1', match 0.45, mismatch 0.30, idPhotoMatch 0.42, idPhotoMismatch 0.24,
  prior 0.001, sprt { suspect 3, confirm 7, clear −6, maxSamples 8, maxPoorEvidence 4 }, llrClamp 5,
  minFramesForDecision 3 }`.
* **New:** `windowEvidence(window)` is the window sum with the poor-evidence cap. Use it for the SPRT window
  **and** in `assessCheck`. Poor-only evidence should end *uncertain* with lighting guidance, not *likely
  mismatch*: today `assessCheck` holds 0.3 % of genuine dim-room resumes for review.
* **v2.1 — conditional on the reference.** `sampleLLR(similarity, bucket, ctx?)` takes an optional
  `EvidenceContext` `{ reference?: QualityBucket, baseline?: {mean, sd, n}, context?: 'continuous' | 'relaxed',
  frames?: number }`. Without it, nothing changed. `reference` = the gallery's bucket (`referenceBucket(qualities)`,
  or the engine's stored median bucket); a good / fair / missing reference keeps `BUCKET_MODELS` exactly.
  When `continuousApplies(bucket, ctx)` (context 'continuous', poor reference, poor probe, baseline n ≥ 3) pass the
  RAW similarity (the same-session model uses the baseline itself); otherwise pass the (optionally per-session
  normalised) similarity, normalised against `bucketModel(bucket, reference)`. The identity engine does exactly this
  in `comparisonLLR(similarity, bucket, baseline, context, frames = 1)`; burst templates must pass their usable frame
  count as `frames`. `decideIdentity(…, against, evidence?)` accepts `{ llr }` (or an `EvidenceContext`): *match* then
  also needs LLR ≤ −`MATCH_MAX_LLR` (1). `QUALITY_GATE.minContrastConfident` / `confidentDetectionScore` and
  `lowContrast(contrast, detectionScore, gate)` implement the backlit exception.
* `templateFrom(embeddings)` and `scoreAgainst(probe | probes[], gallery)` produce THE score the models are
  calibrated for: probe or burst template against the gallery template.
* `decideIdentity` labels are quality-aware: a poor frame is never labelled *mismatch*, and a non-poor frame only
  when `sampleLLR ≥ MISMATCH_MIN_LLR` (2). `advisoryGuidance(quality)` returns soft guidance for usable-but-poor
  frames.
* `AnalyzeOptions.enhanceLowLight` (default on) and `embeddingVariants` (evaluation only) are new.
  `ImageAnalysis.embeddingVariants` and the optional `FaceQuality.noise`, `.detail` and `.clipped` fields are
  additive.
* **Mirror-symmetric head pose (v2.1, `VisionEngineOptions.symmetricPose` / service option, default on).** YuNet
  does not place landmarks mirror-symmetrically: the same turned face measured +30.6°, its mirror image −18.4° (e2e
  head-turn fixture; turned frames yaw(I) + yaw(mirror I) = +8.8 ± 4.2°, frontal +4 ± 3.5°; `biden.jpg` +12.7 / −23.2°),
  so turns to one side read ~1.5× larger — liveness steps, the |yaw| gate and the pose bucket favoured one side. The
  engine now also detects on the mirror image and averages the two landmark sets (alignment and embeddings keep the
  frame's own landmarks): pose(mirror I) = −pose(I) by construction (measured residual ±1°, from JPEG re-encoding).
  Cost: one detector pass per frame with a face (+~25 % analysis time measured on a loaded 4-core box). The liveness
  thresholds are mirror-symmetric (`stepDelta`); tests: `liveness.test.ts` (mirrored pairs at and around the
  thresholds), `service.test.ts` (real images and their mirror), `engine.test.ts`. Simulator caches keep the pose
  they were analysed with.
* Liveness adds `LIVENESS_DEFAULTS.minFramesAgreeing` / `agreeingFractionOfTarget` and the per-bucket consistency
  floors. `checkStepFrame` → `StepFrameFeedback` with `progress`. Send 2–3 frames per step.
