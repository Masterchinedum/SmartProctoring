# Identity verification v2 — calibrated for real laptop webcams

This document replaces the calibration parts of [identity.md](identity.md) (pipeline description, licences and the
customer data protocol there still apply). It covers why identity v1 failed with a real webcam, what changed in
`apps/server/src/vision`, how it was measured, the before/after numbers, the limitations, and how to re-run the
measurement — including on your own webcam captures.

__RESULTS_SUMMARY__

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

__SIM_LIMITS__

## 4. Quality gate v2 and quality buckets

__GATE__

## 5. Embeddings: flip test-time augmentation, no photometric normalisation

__EMBED__

## 6. Templates, bursts and the calibrated evidence model

__TEMPLATES__

## 7. Liveness under webcam noise

__LIVENESS__

## 8. Before / after

__TABLES__

## 9. Limitations

__LIMITS__

## 10. Re-running the measurement

__RERUN__

## 11. For the identity engine (API summary)

__API__
