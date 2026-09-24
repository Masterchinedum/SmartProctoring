# Face recogniser for webcam conditions — label-free robustness training of SFace

> **Decision: NOT SHIPPED.** SFace (`face_recognition_sface_2021dec.onnx`) with the vision agent's v2.1 pipeline
> stays the production recogniser. Nothing was added to `apps/server/models/`, and `THIRD_PARTY_NOTICES.md` is
> unchanged.
>
> The best candidate, **A_mdeg**, is a label-free fine-tune of SFace's first seven blocks. It roughly halves the
> error in dim and backlit light on held-out identities: pooled webcam EER 7.3 % → 3.7 %, poor-quality-bucket EER
> 5.7 % → 2.8–3.1 %, and first-attempt resume in dim / backlit light 28 → 36–37 % and 36 → 46–48 %. It does not pass the
> safety criteria:
>
> 1. **Matched degradation.** With a reference enrolled in a dim room and impostors captured in the same dim
>    conditions, A_mdeg raises the false-match rate at its good-light operating threshold from 0.64 % to 1.13 %
>    (Δ +0.47 pts, 95 % CI [+0.14, +0.92]).
> 2. **Family members in good light.** False passes at checks rise from 1.1 % to 2.6 %.
> 3. **Clean photos.** Non-inferiority fails marginally with the raw recipe (upper CI of ΔEER +1.06 pts against a
>    +1.0 pt margin).
>
> A quality-routed hybrid (the candidate only for poor-bucket frames) keeps most of the gain and is neutral in good
> light. In dim matched degradation its point estimates still lean worse (none significant). Under the rule "ship
> only if every criterion holds" that is also a no-ship. §7 lists the data that would let the next iteration ship.

Code: [`tools/recognizer/`](../../tools/recognizer/README.md), covering fetch → crops → train → export → evaluate →
production harness. This document builds on [identity-v2.md](identity-v2.md), which covers the quality gate,
recipes, templates, calibration, the webcam simulator and the evaluation sets.

## 1. Problem and constraints

The server verifies identity with OpenCV Zoo **SFace**: Apache-2.0, a MobileNet-style network with 9.7 M
parameters, 128-d embeddings, and input of 1×3×112×112 RGB 0..255 aligned to the ArcFace template. In a real
laptop-webcam test, verification was unreliable in ordinary indoor light. SFace is a compact 2021 model. It
degrades with low light, sensor noise, soft focus and compression, which is exactly what webcams deliver.

Training a new state-of-the-art model is not possible here, for two reasons. There is no licensed
multi-million-identity dataset. The large public face datasets, and the weights trained on them (MS1M, WebFace,
VGGFace2, CASIA, Glint360K, InsightFace models), are non-commercial.

Apache-2.0 does allow derivatives of SFace. So the approach was: **keep SFace's identity knowledge, and teach it,
without identity labels, to produce the same embedding from a degraded webcam capture as from a clean photo.**

## 2. What was built

### 2.1 Tooling (`tools/recognizer/`, code only)

| Piece | Purpose |
|---|---|
| `common.py` | Python mirror of the production path: decode, YuNet pre/post-processing, `align.ts` similarity alignment, SFace re-implemented in PyTorch with its ONNX weights (exact: cosine 0.99999994 against onnxruntime), and BatchNorm folding |
| `prep.py` | Port of `embed-prep.ts` (stretch / gamma / clahe normalisation, flip TTA) |
| `webcam.py` | Training-side webcam simulator: an independent Python/OpenCV implementation of `webcam-sim.ts` with the same ranges |
| `fetch_data.py`, `build_train.py` | Public-domain training portraits, crops, identity audit, and degraded renders |
| `train.py` | Method A (partial fine-tune) and method B (enhancement front-end); losses in §2.3 |
| `export.py` | ONNX export with the same I/O (`data` → `fc1`), parity check, CPU latency, WiSE-FT interpolation option |
| `eval.py`, `report.py` | Held-out evaluation with an identity-cluster bootstrap and paired deltas; markdown tables |
| `ts/harness.mts` | Runs the vision agent's **production harness** (`webcam-eval.ts` / `webcam-report.ts`) with any model. Options: `--refit` recalibrates `BUCKET_MODELS` to that model; `--hybrid-base` gives quality-routed hybrid scoring |
| `ts/matched.mts` | Matched-degradation false-match rates through the production pipeline, with paired bootstrap CIs (base / candidate / hybrid) |
| `ts/render_val_frames.mts`, `check_matched.py` | Validation portraits rendered by the TypeScript simulator, and the matched-degradation check on 150 held-out training-source identities |
| `check_parity.py`, `check_recipes.py`, `ts/dump_embeddings.mts` | Python-vs-server parity |

**Parity with the server.**
- **Evaluation crops are production-exact.** Baseline embeddings of all 6,887 detected webcam frames match the
  server's cached embeddings with cosine ≥ 0.99999. Recipe embeddings (flip, stretch, gamma, clahe) are 1.00000 on
  200 frames.
- **Clean photos.** Aligning from the server's landmarks gives cosine min 0.990 and median 1.000. The small
  residual comes from JPEG decoders (PIL vs libvips).
- **Candidate in the production engine.** Loaded through `onnxruntime-node` with the initializer rewrite, it
  matches the Python embedding at median 1.000000 (min 0.988 on the same decoder-sensitive photo).
- **Fully independent Python path.** Detector input resampled by PIL instead of libvips: median cosine 0.9967,
  because YuNet landmarks move by 1–8 px on small photos. This is why evaluation uses the server's landmarks.

### 2.2 Training data: label-free, public domain

| | |
|---|---|
| Source | Official portraits of members of the US Congress, [`unitedstates/images`](https://github.com/unitedstates/images) `congress/450x550`, commit `aec3e4a8` |
| Licence | **Public domain**: US federal government works, which the GPO has confirmed. The repository's own files are CC0-1.0. Usable commercially and for training. |
| Used | 1,297 listed. 2 excluded by id because they are in the evaluation set (Biden, Obama). 20 without a usable face. 7 dropped by the **identity audit**: any portrait with SFace similarity ≥ 0.45 to any evaluation photo, all look-alikes with a maximum of 0.52. That leaves **1,268 portraits**: 1,118 train, 150 validation. |
| Labels | **None.** Only image bytes are used. Each portrait is its own instance. |
| Degraded renders | 12 per portrait (14,316 in total) from `webcam.py`. The head is placed in a synthetic room at 35–90 px inter-eye (720p, ×⅔ at 480p), then exposure, side light, ISP tone and colour, blur, luma and chroma noise, and JPEG. **YuNet then runs on the degraded frame at production scale and the face is aligned from the detected landmarks**, so landmark jitter is learned too: median 0.11 × inter-eye. Detection success: 100 % good/typical, 72 % dim, 75 % backlit. |
| Extras | Ranges widened by up to 35 % on 35 % of scenes. Low-res sensor (×0.3–0.6) on 20 %. JPEG q 25–60 on 15 %. Crop-level degradations of clean crops on a quarter of each batch. 50 % mirrored. |
| Bias | Mostly older, male and white subjects, studio-lit and frontal (see §6). |

Evaluation frames come from the vision agent's TypeScript simulator (sharp/libvips), and training frames from the
independent Python one. A model cannot win by memorising one implementation's artefacts.

### 2.3 Methods

The teacher is frozen SFace on the clean crop. The student input is the degraded crop of the same portrait. With
L2-normalised student embeddings `s` and teacher embeddings `t`, over batches of 32 distinct portraits plus 8
clean crops:

```
L = mean(1 − ⟨s(deg_i), t_i⟩) + 1.0 · mean(1 − ⟨s(clean_i), t_i⟩)                        cosine distillation + clean compatibility
  + w_rel · mean_{i≠j}(⟨s(deg_i), t_j⟩ − ⟨t_i,t_j⟩)² (+ same for s(clean))                  keep the teacher's impostor geometry
  + w_nce · InfoNCE(s(deg_i) vs the teacher embeddings of all 2×1,118 portraits, τ 0.07)   instance discrimination, still label-free
  + w_dd · mean_{i≠j}(⟨s(deg_i), s(deg_j)⟩ − ⟨t_i,t_j⟩)²                                   degraded-vs-degraded geometry (matched degradation)
  + w_mean · [(mean⟨s(deg_i),t_j⟩ − mean⟨t_i,t_j⟩)² + (mean⟨s(deg_i),s(deg_j)⟩ − mean⟨t_i,t_j⟩)²]   impostor-mean penalties
```

**Runs compared.** All run on CPU on 2–3 shared cores, at about 6–9 s per step.

| Run | What | Validation (150 held-out portraits, degraded vs clean): TAR@FAR1e-3, start → best |
|---|---|---|
| A_upto7 | Method A: `conv_1…conv_7` fine-tuned (269 k of 9.7 M params); BN folded and frozen; cosine + relational (w 5) | not logged (run pre-dates the metric); genuine mean 0.63 → 0.73; impostor mean 0.05 → **0.12** |
| A_nce | As A_upto7, plus InfoNCE 0.1 and relational 10 | 0.810 → 0.906 (step 700) |
| **A_mdeg** | A_nce, then 400 steps with the matched-degradation terms (w_dd 10, w_mean 50), half of the batches all-dim or all-backlit, and early stopping that penalises matched-degradation impostor p99 | 0.906 → 0.913; matched impostor p99 dim 0.357 → 0.340, backlit 0.409 → 0.362 |
| B_enh | Method B: a 65.8 k-param U-Net enhancer (148 M MACs, zero-initialised residual) in front of **frozen** SFace | 0.810 → 0.846 at step 200, against 0.897 for A at the same step. Stopped to free CPU and memory; not taken to the evaluation set |

Early stopping always uses the held-out training-source portraits, never the evaluation identities.

## 3. Evaluation protocol

### 3.1 Data and protocols

* **Identities.** The public sets of `apps/server/src/eval/datasets.ts`: 140 photos of 43 identities, including 3
  Azure families of close relatives. They are disjoint from training.
* **Frames.** The vision agent's cached `webcam-sim.ts` renders (SIM_VERSION 3), with landmarks from the
  **server's** detector. Each photo is rendered in {good, typical, dim, backlit, sidelit} × {640×480, 1280×720} × 2
  scenes × 3 burst frames. Each identity also has 5 check-in frames in each enrolment condition.
* **Derived stress conditions**, made from the typical frames:
  * `lowres`: ×0.4 down then up, JPEG 80;
  * `noisy`: +σ 10 luma and σ 5 chroma;
  * `compressed`: JPEG q 20.
* **Protocols** (`eval.py`)
  * `photo`: a clean photo enrols, frames of *other* photos probe.
  * `checkin`: the mean template of 5 good-light check-in frames.
  * `checkin:dim` / `checkin:backlit`: **matched degradation**, a check-in in the same poor light as the probes.
  * `-3f`: probe = mean of 3 burst frames.
  * `mixed`: the old SFace enrols and the candidate probes, i.e. references stored before a rollout.
* **Production harness** (`ts/harness.mts`). This runs the v2 engine end to end: quality gate, low-light detection
  pass, flip / denoise recipe, templates, calibrated LLR/SPRT, and engine checks, on 9,080 frames. All harness
  numbers below are **v2.1 vs v2.1**, meaning calibration webcam-v2.1 for both base and candidates.

### 3.2 Statistics and decision rules

* **CIs.** Identity-cluster bootstrap, 300–1,000 reps: identities are resampled and trials weighted by
  multiplicity. **Paired** CIs of the difference to the baseline use the same resamples.
* **FMR at operating points.** For matched degradation, the false-match rate is measured at two thresholds: each
  model's own good-light threshold (good check-in vs good probes, impostor FAR 1e-3), and the fixed match threshold
  0.45.
* **Decision rule, fixed before the final runs.**
  * **Win:** the paired CI on pooled webcam frames excludes 0 for both ΔEER and ΔTAR@1e-3.
  * **Non-inferiority on clean / good / typical / sidelit:** upper CI of ΔEER ≤ +1.0 pt and lower CI of
    ΔTAR@1e-3 ≥ −3.0 pts.
  * **Engineering:** ONNX parity ≥ 0.999 and latency ≤ 2×.
* **Lead's additional criteria.**
  * Matched-degradation impostor FMR must not be worse in dim or backlit.
  * No regression for family members: family swaps, and family pass at checks.
  * A clear poor-bucket gain.
  * The out-of-domain evaluation set outranks the in-domain validation set.

## 4. Results

### 4.1 A_mdeg as a drop-in replacement: `photo` protocol, raw crop, single frame

95 % CIs; bold = paired CI excludes 0. n = genuine / impostor trials, from 140 enrolment photos.

| condition | n | EER % base → A_mdeg | ΔEER pts [CI] | TAR@FAR1e-3 % base → A_mdeg | ΔTAR pts [CI] |
|---|--:|--:|--:|--:|--:|
| clean photos | 486 / 18,974 | 1.28 → 1.63 | +0.34 [−0.01, **+1.06**] | 97.5 → 96.7 | −0.81 [**−3.52**, +0.18] |
| **webcam_all (primary)** | 24,354 / 855,099 | 7.33 → 3.68 | **−3.55 [−4.93, −2.10]** | 81.3 → 88.3 | **+6.78 [+3.82, +9.05]** |
| good | 5,555 / 197,246 | 0.77 → 0.81 | +0.07 [−0.01, +0.17] | 98.8 → 98.4 | −0.55 [−2.16, +0.00] |
| typical | 5,528 / 195,744 | 1.04 → 1.17 | +0.10 [−0.09, +0.33] | 96.8 → 96.4 | −0.70 [−2.60, +0.24] |
| dim | 3,980 / 137,522 | 12.5 → 7.6 | **−4.68 [−5.89, −3.16]** | 53.1 → 69.2 | **+15.9 [+11.0, +20.2]** |
| backlit | 3,784 / 129,795 | 12.5 → 6.1 | **−6.21 [−8.61, −3.05]** | 56.6 → 75.5 | **+17.9 [+9.3, +24.8]** |
| sidelit | 5,507 / 194,792 | 1.79 → 1.86 | +0.03 [−0.32, +0.38] | 94.9 → 94.6 | −0.24 [−2.02, +0.99] |
| stress (lowres + noisy + compressed) | 16,584 / 587,232 | 2.4 → 2.0 | **−0.4 [−0.9, −0.0]** | 89.8 → 91.0 | +1.4 [−0.5, +3.5] |
| noisy | 5,528 / 195,744 | 3.2 → 2.5 | −0.6 [−1.4, +0.2] | 84.6 → 87.5 | **+3.2 [+0.3, +6.7]** |

* **With flip TTA** (the v2 recipe for good / fair frames), the picture is the same:
  * webcam_all ΔEER −3.52 [−4.88, −2.04], ΔTAR +6.65 [+3.67, +8.98];
  * clean ΔEER +0.14 [−0.02, +0.54] and ΔTAR −0.85 [−2.88, +0.00], so clean passes non-inferiority with flip but
    not with the raw crop.
* **3-frame probes**: webcam_all EER 7.1 → 3.3 %; dim TAR 58 → 74 %; backlit TAR 58 → 79 %.
* **Good-light check-in** (`checkin`): webcam_all EER 5.99 → 2.53 % (Δ −3.38 [−4.53, −2.29]); dim 11.5 → 5.3 %;
  backlit 11.1 → 5.5 %.
* **Backward compatibility (`mixed`)**: old SFace templates against candidate probes give practically the same
  numbers (webcam_all EER 3.73 %; clean ΔEER +0.2 [−0.0, +0.7]). The candidate lives in SFace's embedding space
  (clean-input compatibility ⟨s, t⟩ = 0.992 on validation).
* **Impostor-side shift.** Impostor similarities shift up by about 0.01–0.06, while genuine scores rise more. Two
  consequences:
  * at the model's own good-light threshold, good-light FMR stays about 0.1 %;
  * at the SFace-fitted thresholds, impostors look slightly more similar. This is why the model **needs
    recalibration** before any use.

### 4.2 Matched degradation (the e2e-found risk)

The reference is enrolled in the **same** poor light as the impostor probes.

**Out-of-domain evaluation set, `eval.py`.** Raw crop, single frame, paired identity bootstrap. 20 identities
enrolled in dim light, 25 in backlight.

| | FMR @ own good-light threshold, base → A_mdeg | Δ pts [CI] | FMR @ 0.45 | Δ pts [CI] | EER % | TAR@1e-3 % |
|---|--:|--:|--:|--:|--:|--:|
| dim / dim | 0.64 → 1.13 % | **+0.47 [+0.14, +0.92]** | 0.10 → 0.18 % | +0.07 [−0.08, +0.28] | 10.4 → 6.9 | 41.5 → 60.3 |
| dim / dim, 480p | 0.81 → 1.42 % | **+0.58 [+0.10, +1.24]** | 0.13 → 0.16 % | +0.02 [−0.19, +0.20] | 13.3 → 8.8 | 37.7 → 54.4 |
| backlit / backlit | 1.43 → 1.00 % | −0.44 [−1.28, +0.45] | 0.46 → 0.23 % | −0.23 [−0.64, +0.15] | 9.3 → 6.7 | 31.8 → 55.9 |
| flip TTA, dim / dim | 0.81 → 1.29 % | **+0.46 [+0.10, +0.99]** | 0.15 → 0.19 % | +0.03 [−0.14, +0.19] | 11.0 → 6.3 | 43.0 → 62.1 |

**Production pipeline, v2.1, `ts/matched.mts`.** Burst templates, 1,000 bootstrap reps.

| | base | A_mdeg | Δ [CI] | hybrid | Δ [CI] |
|---|--:|--:|--:|--:|--:|
| dim, FMR @ own good threshold | 1.27 % | 1.82 % | +0.54 [−0.48, +1.64] | 1.46 % | +0.19 [−0.68, +1.14] |
| dim, FMR @ 0.45 | 0.254 % | 0.288 % | +0.03 [−0.30, +0.30] | 0.254 % | 0.00 [−0.38, +0.28] |
| dim, single frame, FMR @ 0.45 | 0.070 % | 0.140 % | +0.07 [−0.01, +0.18] | 0.133 % | +0.06 [−0.01, +0.17] |
| backlit, FMR @ own good threshold | 1.43 % | 1.51 % | +0.08 [−0.95, +1.10] | 1.24 % | −0.19 [−1.23, +0.63] |
| backlit, FMR @ 0.45 | 0.307 % | 0.295 % | −0.01 [−0.33, +0.39] | 0.236 % | −0.07 [−0.34, +0.19] |
| dim, genuine pass @ 0.45 | 73.3 % | 89.1 % | **+15.8 [+5.5, +30.8]** | 85.8 % | +12.5 [−1.6, +29.3] |
| backlit, genuine pass @ 0.45 | 66.5 % | 80.5 % | **+14.0 [+8.1, +20.6]** | 76.0 % | **+9.5 [+1.5, +18.1]** |

**In-domain check: 150 held-out training-source identities rendered by the TypeScript simulator.** This is
impostor-only, with about 57,000 matched pairs per condition (`check_matched.py`).

| | dim FMR @ own good thr | dim FMR @ 0.45 | backlit FMR @ own | backlit FMR @ 0.45 | good-light FMR (reference) |
|---|--:|--:|--:|--:|--:|
| base SFace | 1.99 % | 0.84 % | 2.07 % | 1.00 % | 0.10 % |
| A_upto7 (no InfoNCE) | 4.13 % | 1.20 % | 3.88 % | 0.98 % | 0.10 % |
| A_nce | 1.51 % | 0.28 % | 1.21 % | 0.20 % | 0.10 % |
| **A_mdeg** | **0.98 %** | **0.17 %** | **0.62 %** | **0.08 %** | 0.10 % |

Three conclusions follow.

* **The inflation is real.** In the matched case, base SFace's false-match rate is about 20× its good-light rate.
* **Training choices matter.**
  * Cosine distillation alone (A_upto7) makes the inflation worse.
  * InfoNCE and the matched-degradation stage reverse it on the in-domain identities.
  * On the out-of-domain evaluation photos (celebrities, TV stills, stock photos), the dim case still ends up
    worse than base, though backlight improves.
* **The evaluation set decides.** It outranks the in-domain set, so this is a fail. With only 16–20 dim-enrolled
  identities it is also the least certain number in this report.

### 4.3 Production harness, v2.1 vs v2.1 (9,080 frames, recipe v2)

*Refit* means `BUCKET_MODELS` refitted to the model's own per-bucket fits, using the vision agent's procedure
(sd × 1.15). Applied to base, that procedure reproduces the shipped values exactly.

| | base v2.1 | A_mdeg, refit | hybrid (A_mdeg on poor frames only), refit |
|---|--:|--:|--:|
| poor-bucket EER % / d′ | 5.73 / 3.22 | 2.82 / 3.94 | 3.08 / 3.87 |
| good / fair bucket EER % | 0.14 / 0.26 | 0.20 / 0.37 | 0.14 / 0.24 |
| condition EER %: dim / backlit | 6.04 / 5.08 | 3.21 / 2.07 | 3.25 / 2.44 |
| condition EER %: good / typical / sidelit | 0.11 / 0.13 / 0.53 | 0.11 / 0.13 / 0.53 | 0.11 / 0.12 / 0.53 |
| enrolled in dim / backlit (of 34) | 16 / 23 | 16 / 23 | 16 / 23 |
| resume check, 3 frames: genuine pass, other photo: all / dim / backlit | 67.4 / 28.0 / 36.2 % | 71.3 / 37.2 / 47.7 % | 71.1 / 35.6 / 46.4 % |
| resume check: impostor → mismatch, good / typical | 86.8 / 83.1 % | 87.7 / 83.0 % | 87.6 / 83.7 % |
| **family pass at checks** (false accept of a relative): good / typical / sidelit / backlit | 1.1 / 1.8 / 1.1 / 0 % | **2.6 / 2.9 / 2.9 / 1.5 %** | 1.1 / 1.8 / 0.7 / 0.7 % |
| swap detected within 3 samples: good / typical | 96.1 / 93.9 % | 95.9 / 93.6 % | 96.1 / 94.0 % |
| **family** swap within 3 samples: good / typical / sidelit | 90.1 / 83.9 / 90.2 % | 90.1 / 82.9 / 87.9 % | 89.1 / 84.3 / 89.9 % |
| matched dim, burst: impostor mean / p99 / max | 0.108 / 0.390 / 0.516 | 0.172 / 0.398 / 0.526 | 0.148 / 0.391 / 0.526 |
| false swap confirmations per 1,000 h (same person) | 0 | 0 | 0 |

The family pass rates are counted over 272 family checks per condition, so each point is 3 vs 7–8 false passes.
The swap-detection columns come from the harness's Monte-Carlo simulation (100 runs), whose noise is about ±1 pt.

*Calibration scope:* only `BUCKET_MODELS` was refitted. The v2.1 `REFERENCE_MODELS`, `CONTINUOUS_MODEL` and
`GENUINE_DRIFT` stayed as fitted for SFace, so the decision-level rows for the candidate are indicative. The
verdict rests on the calibration-free rows: EER, d′, and FMR at thresholds.

**Recipe with the candidate** (v2 = flip for good/fair, 3×3 denoise for poor, vs flip everywhere): poor-bucket EER
2.82 vs 3.10 %. Keep the production v2 recipe; flip TTA and the poor-frame denoise still help a little.

### 4.4 ONNX export and cost (A_mdeg)

| | |
|---|---|
| File (NOT in the repo) | `$RECOG_WORK/export/A_mdeg.onnx`, 38,552,661 bytes, SHA-256 `6950997a1c2c9535f02280765afc0a5ee2ef1977a721f90ddeb471b485a935ce` |
| I/O | `data` float32 [N,3,112,112], RGB 0..255, aligned → `fc1` float32 [N,128] (L2-normalise). Identical to SFace, with dynamic batch |
| PyTorch vs onnxruntime | cosine min 0.9999999 on 256 real crops |
| Latency, onnxruntime CPU, batch 1 (measured on a busy shared box) | 1 thread 39.3 vs 38.1 ms (×1.03); 2 threads 37.8 vs 36.3 ms (×1.04). Same graph as SFace |
| Method B enhancer, had it been used | +148 M MACs (≈ +25 %) |

### 4.5 Scorecard against the ship criteria

| Criterion | A_mdeg (replacement) | Hybrid (poor frames only) |
|---|---|---|
| Win on pooled webcam frames (paired CI) | **yes**: ΔEER −3.55 [−4.93, −2.10], ΔTAR +6.8 [+3.8, +9.1] | yes: poor-bucket EER 5.73 → 3.08 % |
| Non-inferiority, clean photos (ΔEER ≤ +1.0, ΔTAR ≥ −3.0) | **no** with the raw crop (+1.06 / −3.52); yes with flip TTA | yes, by construction (ID photos stay on SFace) |
| Non-inferiority, good / typical / sidelit | yes | yes |
| Matched-degradation FMR not worse (dim, backlit) | **no**: dim +0.47 [+0.14, +0.92] pts | **not shown**: dim point estimates +0.19 / +0.00 / +0.06 pts, none significant; backlit ≤ base |
| Family swaps / family pass at checks not worse | **no**: pass 1.1 → 2.6 % (good), 1.8 → 2.9 % (typical) | yes: 1.1 / 1.8 % unchanged; within-3 detection 90.1 → 89.1 % (MC noise) |
| Parity / latency | yes / yes | yes / yes (+1 model session in memory) |
| **Verdict** | **no-ship** | **no-ship** (not every criterion holds) |

## 5. Additional findings

* **Why matched degradation inflates.** Two frames that went through the *same* degradation get correlated
  embeddings from the *same* network. A post-hoc observation, not pre-registered and small-n: in `mixed` mode the
  reference is embedded by old SFace and the probe by the candidate, and that removed almost all of the inflation.
  * Dim / dim: FMR at the own threshold 0.64 → 0.03 % (Δ −0.61 [−1.24, −0.21]); at 0.45, 0.10 → 0.00 %.
  * Backlit / backlit: 1.43 → 0.14 % (Δ −1.30 [−2.37, −0.53]); at 0.45, 0.46 → 0.004 %.
  * Genuine pass under matched conditions was higher than base but lower than same-model scoring.

  **Cross-model scoring** is the most promising lead for the next iteration: a reference template from one model,
  probes from a differently trained one, or both cross scores fused. It must be confirmed on real data before
  anyone relies on it.
* **Detection limits any recogniser.** In the analyses behind `eval.py`, which were made before the v2 low-light
  detection pass, the production detector found no face in 27 % of dim and 32 % of backlit frames. After the quality gate, dim and backlit swap detection within 3 samples is about 11–12 % for
  every model tested. The largest remaining lever in poor light is capture guidance and gating, not embeddings.
* **Photometric normalisation.** Stretch, gamma and CLAHE on the crop hurt (identity-v2 §5), and `prep.py`
  reproduces those recipes exactly. The candidate needs none of them.

## 6. Limitations

* **Simulated webcams only.** No real webcam captures were available. Both simulators share the same physical
  model, so what transfers to real sensors is unproven.
* **Small evaluation set.** 43 identities, 34 enrolled, 3 families / 8 relatives, and only 16–20 identities
  enrolled in dim light. CIs are wide, and family numbers hinge on a handful of pairs. The evaluation photos are
  celebrities, TV stills and stock photos, not proctoring candidates.
* **Training data bias.** US Congress portraits skew older, male and white, with studio lighting. Demographic
  performance was not measured, and could not be with this data.
* **Selection on the evaluation set.** Several candidates were run on the evaluation set: A_nce at step 200,
  A_nce, A_upto7, A_mdeg, and the hybrid. The decision rule was fixed before the final runs, and no candidate was
  shipped, so selection bias cannot have produced a false ship.
* **Harness decision metrics.** Calibration is refitted only partly (`BUCKET_MODELS`), see §4.3.

## 7. What would let the next iteration ship

**Data.** Consented webcam captures, collected under the customer protocol in [README.md](README.md) and used
only for validation, evaluation and calibration. Training can stay label-free.

| | Minimum |
|---|---|
| People | **≥ 150** adults across the candidate demographics, **including ≥ 20 pairs of close relatives** (siblings, parent/child, twins where possible), so family impostors reach hundreds of pairs rather than 3 families |
| Devices | ≥ 3 laptop webcams (a 720p and a 480p-class built-in, one low-end USB), at 640×480 and 1280×720 |
| Conditions per person | good; typical indoor; **dim evening** (20–100 lux); **backlit** (window behind); side-lit; each on **two different days** |
| Per session and condition | a 5-frame check-in and ≥ 4 bursts of 3 frames. Record the **same room for check-in and probes**, the matched-degradation case |
| Why these numbers | With 150 people, about 150 × 149 ≈ 22,000 impostor pairs per condition, so matched-degradation FMR near 0.1–1 % gets CIs of about ±0.2 pts. Each dim or backlit condition then has ≥ 150 enrolled identities (versus 16–25 here). ≥ 300 genuine trials per demographic group gives the ±1 % bound in README.md |

**Procedure.**
1. **Split** people into a validation set (early stopping, about 30 %) and an evaluation set (about 70 %).
   Identities must be disjoint from each other and from training.
2. **Re-run** `eval.py` and `ts/harness.mts` / `ts/matched.mts` on the real frames. The folder layout of
   `eval:identity --dataset` works as input once landmarks are dumped with `ts/dump_embeddings.mts`.
3. **Fine-tune from A_mdeg**, adding real good-light frames of the same session as the teacher input (session
   grouping only, no names). Add **cross-model scoring** (§5) as a candidate.
4. **Recalibrate everything:** `BUCKET_MODELS`, `REFERENCE_MODELS`, `CONTINUOUS_MODEL`, `GENUINE_DRIFT`.

**Commands:** see [`tools/recognizer/README.md`](../../tools/recognizer/README.md) (fetch → build → train →
export → eval → harness).

## 8. Integration and licensing, if a future candidate ships

* **Drop-in file.** The model uses the same input contract as SFace: YuNet → `align.ts` crop, planar RGB float
  0..255, no normalisation, output 128-d. It works with `embed-prep.ts`. **Keep the v2 recipe** (flip TTA for
  good/fair, denoise for poor); it measured slightly better than flip everywhere.
* **Engine changes.** Load it next to SFace as a second session for a hybrid, or instead of SFace. Give it a new
  embedding model id. The measured `mixed` results support keeping ids 1/2 references comparable
  (`COMPATIBLE_EMBEDDING_MODELS`), but that needs the full recalibration of §7.
* **Latency.** About ×1.0; memory +38 MB per session.
* **Licensing.**
  * A derivative of OpenCV Zoo SFace (Apache-2.0). Ship with the Apache-2.0 licence text, and state in
    `THIRD_PARTY_NOTICES.md` that the file is **modified** (conv_1–conv_7 fine-tuned by SmartProctoring, date,
    method). The ONNX `metadata_props` already carry this.
  * Training images: US Congress official portraits, public domain (GPO), repository CC0-1.0. Credit is courtesy,
    not a licence requirement.
  * No other pretrained weights or datasets were used. Evaluation images (datasets.ts) were used only locally, for
    measurement.
  * Tooling dependencies: PyTorch / NumPy (BSD-3), ONNX / OpenCV (Apache-2.0), onnxruntime (MIT), Pillow
    (MIT-CMU). None ship with the server.
