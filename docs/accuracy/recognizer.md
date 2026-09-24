# Face recogniser for webcam conditions — label-free robustness training of SFace

__STATUS__

Code: [`tools/recognizer/`](../../tools/recognizer/README.md) (fetch → crops → train → export → evaluate). Related:
[identity-v2.md](identity-v2.md) covers the quality gate, flip TTA, templates and calibration. The webcam simulator
and evaluation sets described there are also used here.

## 1. Problem and constraints

The server verifies identity with OpenCV Zoo **SFace** (`face_recognition_sface_2021dec.onnx`, Apache-2.0,
MobileNet-style, 9.7 M parameters, 128-d). In a real laptop-webcam test, verification was unreliable in ordinary
indoor light. SFace is a compact 2021 model. Its embeddings degrade with low light, sensor noise, soft focus and
compression, which is exactly what webcams deliver. On the simulated webcam frames below, baseline SFace has an EER
of about 12.5 % in dim or backlit light, against about 1 % in good light.

A new state-of-the-art recogniser cannot be trained from scratch here. That needs a licensed multi-million-identity
dataset, and the large public face datasets and the weights trained on them (MS1M, WebFace, VGGFace2, CASIA,
Glint360K, InsightFace models) are non-commercial. Apache-2.0 does permit derivatives of SFace. So the approach is
to **keep SFace's identity knowledge and teach it, without labels, to produce the same embedding from a degraded
webcam capture as from a clean photo.**

## 2. Method

### 2.1 Training data (label-free)

| | |
|---|---|
| Source | Official portraits of members of the US Congress, [`unitedstates/images`](https://github.com/unitedstates/images) `congress/450x550`, commit `aec3e4a8` |
| Licence | **Public domain**: US federal government works. The GPO has confirmed that the member photos are public domain, and the repository's own files are CC0-1.0. Usable commercially, and for training. |
| Used | 1,297 portraits listed. 2 excluded by id because the people are in the evaluation set (Biden, Obama). 20 had no usable face. 7 more were dropped by the identity audit (below). **1,268 portraits**, split 1,118 train / 150 validation. |
| Labels | **None.** Only image bytes are used. Each portrait is its own "instance", and names and ids never enter training. |
| Identity audit | SFace similarity of every portrait to every evaluation photo. Any portrait at ≥ 0.45 (the product's match threshold) to any evaluation photo is dropped: 7 look-alikes, max 0.52. The list is in `$RECOG_WORK/train/audit.json`. This makes the training and evaluation identities disjoint even where the id exclusion missed someone. |
| Bias | The portraits are skewed toward older, male and white subjects, and they are studio-lit and frontal. See §6. |

### 2.2 Degradations: rendered frames, not only crop noise

Each portrait was rendered as **12 simulated webcam frames**, 14,316 in total, by `tools/recognizer/webcam.py`. This
is an independent Python/OpenCV implementation of the vision agent's simulator (`apps/server/src/eval/webcam-sim.ts`)
with the same condition ranges. The steps follow a real capture:
1. The head and shoulders are placed in a synthetic room (wall, desk, and a bright window when backlit) at an
   inter-eye distance of 35–90 px at 720p (×⅔ at 640×480), with ±3° roll.
2. Side-light ramp, then auto-exposure to the target face luma.
3. ISP tone-curve variation, colour-temperature gains, flare lift, and contrast loss.
4. Gaussian PSF and motion blur.
5. Luma noise and low-frequency chroma noise, then a noise-reduction blur.
6. JPEG 4:2:0.
7. **Then detection and alignment as in production.** YuNet runs on the degraded frame at the scale the server
   would use (640 / frame width), and the face is aligned from the detected landmarks.

The student therefore also learns to tolerate the landmark jitter of degraded frames: median 0.11 × inter-eye,
90th percentile 0.19. Detection on the degraded frames succeeded for 100 % of good and typical frames, 72 % of dim
and 75 % of backlit. When it failed, the true landmarks plus 3 % jitter were used.

Training-only extensions: 35 % of scenes have their ranges widened by up to 35 %, 20 % use a low-resolution sensor
(×0.3–0.6 then bilinear upscale), and 15 % get heavy JPEG (q 25–60). Online, a quarter of each batch is replaced by
cheap **crop-level** degradations of clean crops (exposure, gamma, colour, blur, down/up-scale, noise). Half of all
samples are mirrored.

Training and evaluation deliberately use **different implementations** of the same physics: PIL/OpenCV
resampling, noise and JPEG here, sharp/libvips in TypeScript for evaluation. A model cannot win by memorising one
simulator's artefacts.

### 2.3 Objective

The teacher is the frozen original SFace on the clean aligned crop, with targets precomputed for both
orientations. The student input is the degraded crop of the same portrait. With L2-normalised embeddings `s`
(student) and `t` (teacher), over a batch of 32 distinct portraits plus 8 clean crops:

```
L = mean(1 − ⟨s(deg_i), t_i⟩)                                  degraded → clean
  + 1.0 · mean(1 − ⟨s(clean_i), t_i⟩)                          stay compatible on clean input
  + w_rel · mean_{i≠j} (⟨s(deg_i), t_j⟩ − ⟨t_i, t_j⟩)²          keep the teacher's impostor geometry
  + w_rel · mean_{i≠j} (⟨s(clean_i), t_j⟩ − ⟨t_i, t_j⟩)²
  + w_nce · InfoNCE(s(deg_i) against the teacher embeddings of all 2 × 1,118 training portraits, τ = 0.07)
```

The InfoNCE term is instance discrimination against *fixed* teacher prototypes, and it is still label-free. It
was added after the first run: with the cosine term alone, uninformative (very dark) inputs regress toward the
mean face, which raised impostor similarity (validation impostor mean 0.05 → 0.11).

* **Method A (self-distillation fine-tune).** Layers `conv_1 … conv_7` of SFace are fine-tuned: 269 k of 9.7 M
  parameters, the high-resolution blocks where noise and contrast are handled. BatchNorm statistics are frozen
  and folded into the convolutions, so the function is exactly the same at the start. `conv_8 … conv_14` and the
  FC layer are frozen. AdamW, lr 1e-4, cosine decay, 1,200 steps.
* **Method B (enhancement front-end).** A small U-Net `E` (65.8 k parameters, 148 M MACs, zero-initialised
  residual so it is the identity at the start) is placed in front of **frozen** SFace, plus 0.1 · |E(clean) −
  clean| / 255. Exported together as one model.
* **Early stopping** is on the 150 held-out *training-source* portraits, never on the evaluation identities.
  Score: validation TAR@FAR 1e-3 + 0.5 · TAR@FAR 1e-2 + 0.25 · mean cosine, with a penalty when clean-input
  compatibility drops below 0.985.

CPU only (4 shared cores): about 7–9 s per step.

## 3. Evaluation protocol (the only thing that decides)

* **Identities**: the public identity sets of `apps/server/src/eval/datasets.ts`: 140 photos of 43 identities,
  including 3 Azure families of close relatives. They are disjoint from training (§2.1). Frames: the vision
  agent's cached webcam renders (`$SP_FACESETS_DIR/_frames/v3`, `webcam-sim.ts` SIM_VERSION 3). Every photo of
  the 34 identities with ≥ 2 photos is rendered × {good, typical, dim, backlit, sidelit} × {640×480, 1280×720} ×
  2 scenes × 3 burst frames, plus 5 "check-in" frames per identity. That gives 7,950 frames, 6,887 with a detected
  face.
* **Production-exact crops**: landmarks come from the server's own detector (analysis cache), crops come from the
  Python port of `align.ts`, and the recipes come from the Python port of `embed-prep.ts`. Measured against the
  server: baseline embeddings on all 6,887 frames have **cosine ≥ 0.99999**, and the recipe embeddings (flip,
  stretch, gamma, clahe) are 1.00000 on 200 frames. Clean photos: ≥ 0.990 from the server's landmarks
  (`check_parity.py`; the remaining difference is JPEG decoder IDCT).
* **Derived stress conditions**, made here from the `typical` frames: `lowres` (×0.4 down then up, JPEG 80),
  `noisy` (+σ 10 luma, σ 5 chroma), `compressed` (JPEG q 20). `webcam_all` pools the 5 simulator conditions and is
  the **primary endpoint**. `stress_all` pools the 3 derived ones.
* **Protocols**
  * `photo`: enrol with a clean photo (every photo in turn), probe with frames of *other* photos. Near-duplicate
    photo pairs (clean similarity ≥ 0.97) are excluded.
  * `checkin`: enrol with the mean template of the 5 good-light check-in frames, probe with the other photos'
    frames.
  * `-3f`: probe = mean of the 3 burst frames (resume check).
  * `mixed`: enrolment embedded with the **old** SFace, probe with the candidate. This tests backward
    compatibility with stored templates.
* **Statistics**: EER and TAR at FAR 1e-2 / 1e-3 per condition. 95 % CIs come from an identity-cluster bootstrap
  (identities resampled, 200–400 reps). **Paired** bootstrap CIs of the difference to the baseline use the same
  resamples, and they decide. The quality gate is not applied: all frames with a detected face count, because the
  gate and buckets are recalibrated separately (identity-v2).
* **Decision rule, fixed before the final runs.** Ship only if both hold:
  * **Win**: the paired 95 % CI on `webcam_all` excludes 0 for both ΔEER (< 0) and ΔTAR@1e-3 (> 0).
  * **Non-inferiority** on clean, good, typical and sidelit: the upper CI of ΔEER is ≤ +1.0 pt and the lower CI of
    ΔTAR@1e-3 is ≥ −3.0 pts.

  In addition, ONNX parity must be ≥ 0.999 and CPU latency ≤ 2× the current model.

__RESULTS__
