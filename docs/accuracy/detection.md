# In-browser monitoring detections: design, accuracy baseline and evaluation protocol

This document covers the behavioural and camera-integrity detections of the candidate app
(`packages/detection`), the offline evaluation harness (`packages/detection/src/eval`), the current
baseline (`docs/accuracy/detection-baseline.json`) and how to measure accuracy on real recordings.
Identity (person-swap) accuracy is measured separately by the server harness; see
[identity.md](identity.md).

> **Read this first.** Every number below comes from **synthetic** traces. They are simulated
> `FrameObservation` sequences, not camera video. The results show that the engine's timing,
> debouncing, deduplication and root-cause rules behave as designed. They cover brief glances, single
> bad frames, noise, near-threshold cases and one event per ongoing issue. They do **not** show how
> well MediaPipe sees faces, phones or gaze in real rooms, and they are not production error rates.
> Real-world accuracy has to be measured on recorded and labelled traces from real sessions (§7). The
> harness takes those traces unchanged. In production, reviewer decisions give a second, live
> precision estimate on the "Detection quality" page.

## 1. Summary

The latest run used 33 scenarios × 10 seeds = 330 traces and 22.1 h of simulated monitoring. It
takes about 8 s on one CPU core.

| Question | Result (synthetic) |
|---|---|
| False alerts per hour in label-free sessions: clean, noisy, restless candidate, sub-threshold behaviour, still person (12.9 h) | **0.08 / h** in total: 1 `looking_away` in 200 min of a deliberately restless candidate. **0** in 300 min of normal sessions |
| One-frame extra face, one-frame phone, one-frame dark frame, dropped faces, glances < 1.2 s | **never flagged**. The `noisy_frames` scenario runs these at about 8× the normal rate |
| Duplicate events for one ongoing issue | **0**: every detected ongoing issue appeared as exactly one event |
| Short intrusion of a second face (1.5 s) | **10 / 10** flagged, 1.0–1.2 s after it began. 0.6 s intrusions were not flagged, by policy |
| Detectors with recall < 1 | `looking_away` 28 / 30: two 6-s looks only ~5° above threshold. `camera_feed_suspect` 18 / 20: two replay loops with almost no visible motion (§5) |
| Engine cost | ≤ 0.07 ms per tick (Node 22). Memory is bounded: ≈ 10 min of 1 Hz hashes, a few hundred ring-buffer entries |

## 2. What the engine does

**Input.** The host sends one `FrameObservation` per analysis tick. It contains:

- MediaPipe Face Landmarker faces at 5–10 Hz;
- EfficientDet-Lite0 COCO objects at about 1 Hz. `objects: null` means the detector did not run on that tick;
- frame metrics from a downscaled grayscale frame: luma, contrast, Laplacian sharpness, 64-bit dHash, and mean absolute difference from the previous frame;
- camera state.

**Output.** The engine emits:

- `EpisodeUpdate`s with a stable UUID. Phases are `open`, `update` and `close`, and `version` increases by one with every update;
- `EngineSignal`s: identity-sample requests and candidate prompts;
- a `MonitoringStatus`.

All time comes from `obs.t`.

### 2.1 Episode rules (all detectors)

| Rule | Implementation |
|---|---|
| Onset | The condition must hold continuously for the policy duration. A "run" starts at the first true tick, and interruptions shorter than a per-detector gap tolerance don't break it. In the last *duration* seconds, ≥ 70 % of assessable ticks must be true (≥ 60 % for objects), with a minimum number of supporting ticks (3 for faces and objects). |
| `startedAt` / `endedAt` | `startedAt` is the start of the run, when the condition actually began, not when the threshold was crossed. `endedAt` is the first tick on which it was no longer observed. |
| Hysteresis | An episode closes only after the condition has been absent, or not assessable, for `clearSec` (default 2.5 s). |
| Merge | A new episode in the same slot within `mergeGapSec` (10 s) of the previous one re-opens it. It keeps the same id and original `startedAt`, is sent as phase `update` with `version+1`, and `details.occurrences` counts the segments. `flush()` forgets closed episodes, so nothing merges across a pause. |
| Updates | An update is sent when details change materially, at most every 10 s. Other updates carry a snapshot request: `peak` (for example, more people appeared or another same-direction glance happened, at most every 3 s) or `periodic` (every `periodicScreenshotSec`). The open carries `onset`. Snapshots are capped at `maxScreenshotsPerEvent`. |
| Confidence | `meanScore × (0.55 + 0.45·supportFraction) × (0.75 + 0.25·min(1, duration / (2·onset)))`. Pattern detectors use a count-based score (see code). |
| Unassessable ticks | Behavioural detectors run only when the camera is live and the frame is usable: not covered, not frozen, and not too dark to find a face. Pose and gaze detectors also need a face that isn't cut off and has visibility ≥ 0.5. Otherwise the tick is *unknown*: it neither supports nor refutes the condition, and an open episode closes after `clearSec`. This is how "one root cause → one event" works. For example, a covered lens is `camera_covered`, not `candidate_absent`, and a dark room is `lighting_unusable`, not `face_obstructed`. |

### 2.2 Detectors and thresholds

Policy fields come from `detectionPolicySchema` and are shown with their defaults. Engine constants
are in `ENGINE_CONSTANTS` (`src/engine/context.ts`) and `REPLAY_PARAMS`.

| Event | Condition | Notes |
|---|---|---|
| `candidate_absent` | No face for `absenceSec` (8 s) | Not raised while a COCO `person` is visible without a face (that is `face_obstructed`), or while the frame is covered, frozen or dark. Prompt after 3 s. `identity_sample: face_return` once a single usable face is back after any absence ≥ 3 s. |
| `multiple_people` | ≥ 2 plausible faces (score ≥ 0.5, width ≥ 3.5 % of the frame, de-duplicated) for `multiplePeopleSec` (1 s), **or** ≥ 2 distinct `person` boxes (score ≥ `objectMinConfidence`, nested boxes merged) on ≥ 2 object ticks | Both paths feed one episode. `details.maxFaces` and `details.maxPersons`. A `peak` snapshot when the count rises. `identity_sample: after_multiple_people` at the end. |
| `looking_away` | Attention offset beyond `lookAwayYawDeg` (28°) left or right, `lookDownPitchDeg` (20°) down, or 20 + 5° up, for `lookAwaySec` (5 s) | Attention = head pose − baseline + dead-zoned gaze (gazeX · 25°, gazeY · 20°, dead zone 0.15). `details.direction` ∈ `GAZE_DIRECTIONS`, from the candidate's perspective (`left` = the candidate's left). Details also give the max yaw and pitch offsets. |
| `repeated_looking_away` | ≥ `repeatedLookAwayCount` (5) glances within `repeatedLookAwayWindowSec` (120 s). A glance counts only if it lasts ≥ `glanceMinSec` (1.2 s) and < `lookAwaySec`. | Shorter glances are ignored completely. A glance counts from the moment it reaches 1.2 s, so the onset snapshot shows the candidate looking away. The episode stays open while glances continue and closes after max(20 s, 1.5 × window / count) without one. |
| `offscreen_attention_pattern` | ≥ `sameDirectionCount` (4) glances or looks toward the **same direction** within the window. Same direction means attention vectors within 30° of each other in threshold-normalised space. | This is the more specific pattern. Glances toward its direction are attributed to it and are not counted for `repeated_looking_away` (§6). Each further glance adds a `peak` snapshot. |
| `unusual_movement` | ≥ `movementExitCount` (3) face exits of ≥ 2 s within `movementWindowSec` (300 s), **or** far from the baseline position for `farFromBaselineSec` (15 s): centre shift > 0.25 of the frame, or face width < 0.5× or > 1.9× the baseline | Exits include absences too short for `candidate_absent`. `details.reasons`, `exits[]`, `farFromBaseline{}`. |
| `face_obstructed` | Face cut off at the edge, or face visibility < 0.5, or a `person` without a face, for `obstructionSec` (6 s) | Not raised while lighting is the cause. `identity_sample: after_obstruction` at the end. |
| `phone_detected` / `unauthorized_object` | `cell phone` ≥ `phoneMinConfidence` (0.5); `book` / `laptop` / `tv` ≥ `objectMinConfidence` (0.6). Needs ≥ 60 % of object-detector ticks over `objectPersistSec` (2 s) and ≥ 3 hits. | Only ticks where the detector ran count. One episode per label. If the detector stops, the episode closes after 6 s of silence. |
| `camera_covered` | Frame luma < 20 and contrast < 8, or contrast < 4 at any brightness, for `coveredSec` (4 s) | `identity_sample: after_obstruction` at the end. |
| `camera_frozen` | Frame difference < 0.15 **and** an identical dHash for `frozenSec` (6 s) | Real sensors produce ≥ 0.5 of noise, so a still person is never "frozen". |
| `lighting_unusable` | Frame luma < 35 or > 225, or face luma < 40 or > 235, for `lightingSec` (10 s) | `details.condition` is `too_dark` or `too_bright`. |
| `camera_feed_suspect` | (a) Virtual-camera device label: opens immediately and closes when the camera changes. Phone-as-webcam apps get lower confidence (0.45 vs 0.9). (b) Repeating footage (§5). | `details.signal` is `virtual_camera_label` or `repeating_footage`. |
| `camera_disconnected` / `camera_permission_lost` | Camera `ended`, `muted` or `unavailable` for ≥ 2 s; `no_permission` for ≥ 1 s | Closes on return to live, then `identity_sample: camera_reconnect`. Robust to sparse ticks. |
| `monitoring_degraded` | Throughput < 1.5 fps for 15 s while live | Uses `obs.fps`, or the engine's own estimate. |
| `camera_changed` | `deviceIdHash` changes after the first `setCameraInfo` | Neutral marker: a single `close` update with `startedAt = endedAt`. Also sends `identity_sample: camera_reconnect` and re-calibrates the baseline (option `recalibrateOnCameraChange`). |
| periodic identity | Every `identityIntervalSec` while exactly one usable, roughly frontal face (±22° of baseline) has been stable for 0.6 s | Delayed, not dropped, while the view is not usable. Any other identity sample resets the timer. |

## 3. Methodology

### 3.1 Synthetic traces (`src/eval/synth.ts`)

The generator simulates what the host would report, not pixels.

- **Candidate.** Head yaw and pitch follow an Ornstein–Uhlenbeck process around the candidate's
  normal pose, with a stationary SD of 3.5° (±5–8° excursions) and ±0.8° measurement noise. The
  normal pose is randomised per seed: yaw ±8°, pitch −12…+2°. Gaze noise is 0.07. Face position and
  size drift. Head turns follow a 0.15-s first-order response.
- **Nuisance events, all of which must be ignored:**
  - dropped faces (0.4 % of ticks);
  - one-frame extra face, one-object-tick phone and one-frame dark frame, each 0.25 / min;
  - brief glances of 0.3–0.9 s, 1.2 / min;
  - reading posture (−6…−12° for 2–6 s), 0.6 / min;
  - object-detector misses of the candidate's `person` box, 8 %.
- **Image model.** A 9 × 8 cell "image" is built from a random room background, a face blob that
  shifts with pose, a body blob and optional hand gestures, plus per-cell noise. Luma, contrast,
  dHash and frame difference come from this image. Hashes therefore flip a few bits from noise, more
  with movement, and never repeat exactly on a live camera. The flat-background noise floor reaches
  3–5 bits, like real webcams.
- **Faults.** Frozen feeds repeat the last analysis result exactly. A replay is a separately
  generated 20-s clip of the same person in the same room, with lively motion, looped from its start
  time. The loop length is not a multiple of the 1 Hz sampling, so each loop iteration is sampled at
  a different phase, as in reality.

The runner calibrates the baseline from the first 5 s with `createBaselineCalibrator`, as the app does
at check-in, then replays every tick through `createMonitoringEngine` and ends with `flush('stop')`.

### 3.2 Scenarios (`src/eval/scenarios.ts`)

Each scenario runs with 10 seeds. Timing and magnitudes vary by seed.

- **Positive scenarios:** 8-s look-away; 10-s look-down; 6 mixed-direction glances in 90 s; 5
  same-direction glances; 12-s absence and return; 4 short exits in 3 min; far from baseline for 25 s;
  a second face for 1.5 s and for 30 s; a background person (person box only); phone for 5 s; book
  for 15 s; covered lens; frozen feed; dark room; replay loop; camera disconnect; permission loss;
  face cut off; face covered; person without a face; virtual camera label; low fps; and a
  near-threshold 6-s look at ~34°.
- **Negative scenarios:** a 30-min clean session; 10 min of frequent single bad frames; 25 brief
  glances; a 20-min restless candidate (±7° jitter, 3 glances / min, frequent reading posture); a
  30-s head turn of ~20° (below threshold); 8 glances of 0.8–1.0 s (just below `glanceMinSec`); a
  0.6-s second face (below `multiplePeopleSec`); a phone at detector score 0.30–0.38; a very still
  candidate for 5 min.

### 3.3 Matching and metrics (`src/eval/metrics.ts`)

A predicted episode matches a ground-truth (GT) episode of the same type when their intervals
overlap, allowing ±2 s at each end. Matching is one-to-one, largest overlap first.

| Metric | Definition |
|---|---|
| TP / FN | GT episodes that are matched / not matched |
| FP | Predictions that overlap no GT of their type. Predictions overlapping only *optional* labels are ignored. |
| Duplicates | Extra predictions overlapping an already-matched GT: the same ongoing issue reported more than once. Must be 0. |
| One event per issue | Every matched GT is covered by exactly one predicted episode |
| False alerts / h | FP ÷ monitored hours not covered by GT of that type, summed over all traces |
| Onset latency | Time from the GT start to the first `open` emission. For pattern detectors the GT starts at the first glance or exit, so latency includes the time needed for the pattern to form. |

## 4. Results

These are the results of `pnpm --filter @sp/detection eval` with default policy, seeds 1–10. The
JSON is in `detection-baseline.json`.

| Event type | GT | TP | FP | FN | Dup | Precision | Recall | F1 | False alerts / h | Onset latency mean (s) | p95 (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `multiple_people` | 30 | 30 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 1.5 | 2.5 |
| `candidate_absent` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 8.8 | 9.3 |
| `looking_away` | 30 | 28 | 1 | 2 | 0 | 0.966 | 0.933 | 0.949 | 0.04 | 5.1 | 5.3 |
| `repeated_looking_away` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 63.1 | 71.7 |
| `offscreen_attention_pattern` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 60.2 | 63.8 |
| `unusual_movement` | 20 | 20 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 57.3 | 102.8 |
| `phone_detected` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 2.5 | 2.9 |
| `unauthorized_object` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 2.7 | 4.1 |
| `camera_covered` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 4.0 | 4.2 |
| `camera_feed_suspect` | 20 | 18 | 0 | 2 | 0 | 1.000 | 0.900 | 0.947 | 0.00 | 14.7 | 35.4 |
| `face_obstructed` | 30 | 30 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 6.1 | 6.2 |
| `lighting_unusable` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 10.1 | 10.2 |
| `camera_disconnected` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 2.1 | 2.2 |
| `camera_permission_lost` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 1.1 | 1.2 |
| `camera_frozen` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 6.1 | 6.2 |
| `monitoring_degraded` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 15.1 | 15.2 |

Notes on reading the table:

- **Latencies follow the policy durations.** For example: absence 8 s, look-away 5 s, frozen 6 s,
  lighting 10 s, degraded 15 s, second face 1 s, objects 2 s plus up to one object-detector period.
- **Pattern latencies are long by definition.** The 5th glance of the scripted pattern happens about
  60 s after the first. The 3rd exit happens about 95 s after the first.
- **`camera_feed_suspect` mixes two signals.** The virtual-camera label is reported at once (0 s).
  Replay loops are detected 33 s after the replay began (mean; p95 43 s): about one loop length (20 s)
  plus the 12-s query window.

Results per scenario (10 runs each):

| Scenario | Runs | Minutes | Expected | Detected | False positives | Missed |
|---|---:|---:|---|---|---|---|
| clean_30min | 10 | 300 | — | — | — | — |
| noisy_frames | 10 | 100 | — | — | — | — |
| brief_glances | 10 | 50 | — | — | — | — |
| fidgety_candidate | 10 | 200 | — | — | looking_away ×1 | — |
| sub_threshold_look | 10 | 20 | — | — | — | — |
| glances_below_min | 10 | 25 | — | — | — | — |
| multi_face_0_6s | 10 | 15 | — | — | — | — |
| phone_low_score | 10 | 15 | — | — | — | — |
| near_threshold_look_6s | 10 | 20 | looking_away ×10 | looking_away ×8 | — | looking_away ×2 |
| look_away_8s | 10 | 20 | looking_away ×10 | looking_away ×10 | — | — |
| look_down_10s | 10 | 20 | looking_away ×10 | looking_away ×10 | — | — |
| repeated_glances | 10 | 30 | repeated_looking_away ×10 | repeated_looking_away ×10 | — | — |
| same_direction_glances | 10 | 33.3 | offscreen_attention_pattern ×10 | offscreen_attention_pattern ×10 | — | — |
| absence_12s | 10 | 20 | candidate_absent ×10 | candidate_absent ×10 | — | — |
| short_exits | 10 | 43.3 | unusual_movement ×10 | unusual_movement ×10 | — | — |
| far_from_baseline | 10 | 25 | unusual_movement ×10 | unusual_movement ×10 | — | — |
| multi_face_1_5s | 10 | 15 | multiple_people ×10 | multiple_people ×10 | — | — |
| multi_face_30s | 10 | 20 | multiple_people ×10 | multiple_people ×10 | — | — |
| background_person | 10 | 20 | multiple_people ×10 | multiple_people ×10 | — | — |
| phone_5s | 10 | 15 | phone_detected ×10 | phone_detected ×10 | — | — |
| book_15s | 10 | 15 | unauthorized_object ×10 | unauthorized_object ×10 | — | — |
| covered_lens | 10 | 20 | camera_covered ×10 | camera_covered ×10 | — | — |
| frozen_feed | 10 | 20 | camera_frozen ×10 | camera_frozen ×10 | — | — |
| dark_room | 10 | 25 | lighting_unusable ×10 | lighting_unusable ×10 | — | — |
| replay_loop | 10 | 50 | camera_feed_suspect ×10 | camera_feed_suspect ×8 | — | camera_feed_suspect ×2 |
| still_person | 10 | 50 | — | — | — | — |
| camera_disconnect | 10 | 20 | camera_disconnected ×10 | camera_disconnected ×10 | — | — |
| permission_lost | 10 | 20 | camera_permission_lost ×10 | camera_permission_lost ×10 | — | — |
| face_cut_off | 10 | 20 | face_obstructed ×10 | face_obstructed ×10 | — | — |
| face_covered | 10 | 20 | face_obstructed ×10 | face_obstructed ×10 | — | — |
| person_without_face | 10 | 20 | face_obstructed ×10 | face_obstructed ×10 | — | — |
| virtual_camera | 10 | 15 | camera_feed_suspect ×10 | camera_feed_suspect ×10 | — | — |
| low_fps | 10 | 25 | monitoring_degraded ×10 | monitoring_degraded ×10 | — | — |

**The errors, explained:**

- **Restless candidate, one `looking_away` (seed 1, 6 s, confidence 0.68).** Jitter of ±7°, a
  reading posture and gaze noise lined up to keep attention past the down threshold for 5 s. That is
  what a real candidate reading notes on the desk would also produce. The confidence is lower than
  for clear look-aways (min 0.76, median 0.83).
- **Near-threshold look, 2 misses.** The head was turned about 34° for 6 s, only ~6° above the 28°
  threshold with ±3.5° jitter. Too few ticks exceeded the threshold within a 6-s span to meet the
  70 % rule. This is the intended trade-off at the boundary. Lowering `lookAwayYawDeg` or
  `lookAwaySec` moves it.
- **Replay, 2 misses.** In these seeds the looped clip barely changes the 64-bit image hash. Its
  consecutive-sample changes are 0–3 bits, at the noise floor of a live camera, so the replay cannot
  be told apart from a still live scene. See §5.

## 5. Replay and loop detection: design choices

The initial rule was: "the last 6 one-second samples contain motion (a change > 4 bits) and each is
within 4 bits of an earlier run that started ≥ 15 s before". It produced false alerts in the first
evaluation, for two reasons:

- dHash noise on flat backgrounds alone flips 3–5 bits between frames;
- a live candidate who repeats one movement, such as glancing at the same spot, recreates a short
  hash sequence exactly.

It also missed real loops, because each iteration is sampled at a different phase. The shipped rule
(`REPLAY_PARAMS`) has these parts:

1. A 12-sample query. Motion is the accumulated change above the scene's noise floor, defined as the
   25th percentile of recent consecutive-sample distances, and it must reach ≥ 16 bits.
2. Each earlier sample is compared with the recent full-rate frames within ±0.6 s of the matching
   query time. This makes the comparison phase-tolerant. The match tolerance is 4 bits, or noise
   floor + 2 in noisy scenes.
3. The best alignment must be **discriminative**. Its total distance must be ≤ 0.4 × the 10th
   percentile of all other alignments, excluding other loop iterations, and at least 16 bits better.
   In live footage many alignments fit about equally well (static periods) or none does.
4. Three consecutive matching evaluations at the same lag (±1 s).

Result: 0 false alerts in 22 h of synthetic monitoring, including 5 h of normal sessions, 3.3 h of a
restless candidate, 1.7 h of frequent bad frames and 50 min of a very still candidate. 8 / 10 loops
with motion were detected, 33 s after the replay began.

The limitation is inherent to image hashing: **a replay of footage that barely changes cannot be
told apart from a still live person.** Other signals cover part of that gap:

- the virtual-camera label;
- `camera_frozen`;
- the server's liveness challenge at check-in and resume;
- periodic identity samples, since a replay shows the enrolled face and so does not catch that
  attack on its own.

## 6. Design decisions that affect the numbers

- **Double reporting of glance patterns.** `offscreen_attention_pattern` (same direction) is more
  specific than `repeated_looking_away`. A glance toward a direction that has, or just triggered, an
  open same-direction pattern is attributed to that pattern only. A `repeated_looking_away` episode
  that is already open, for example one triggered earlier by mixed directions, stays open but stops
  receiving glances of that direction. Glances that belonged to a closed pattern are never counted
  again.
- **Sustained looks in the same-direction pattern.** Looks lasting `lookAwaySec` or longer count
  toward `offscreen_attention_pattern` ("glances/looks toward the same direction"). They do not count
  toward `repeated_looking_away`, which covers short glances; sustained looks are already reported as
  `looking_away`.
- **Persons without faces.** A COCO `person` without a face is `face_obstructed`, not
  `candidate_absent`. Two distinct `person` boxes are `multiple_people`, even when the second face is
  too small or turned away to be detected.
- **Dark frames.** A dark frame with no face is *unknown* for absence. The system does not claim the
  candidate left when it cannot see; `lighting_unusable` records the period instead.
- **Baseline.** All attention and position thresholds are relative to the per-period baseline.
  - The app calibrates it at check-in and after every resume (`createBaselineCalibrator`) and passes
    it with `setBaseline`.
  - Absolute landmark pose carries per-person and per-camera offsets. A laptop camera below the eyes
    reads −20° or more for a candidate looking at the screen. The calibrator therefore accepts any
    steady pose within |yaw| ≤ 40° and |pitch| ≤ 45°.
  - Until a baseline is set, the defaults are: yaw 0, pitch 0, centre (0.5, 0.45), width 0.3.
- **Head-pose points.** `fivePointsFromMesh` returns the same anatomical points YuNet returns on the
  server: iris centres, pronasale (mesh landmark 4) and mouth corners 61 / 291.
  - Mesh landmark 1 sits about 0.7 cm below the pronasale. With it, a real-browser e2e run read pitch
    about 20° lower than the server on the same frames (−27…−28° vs −5…−9°).
  - With landmark 4 the client and server liveness measurements agree.
  - A frontal adult face reads about −5…−8° on both sides. That is fine: everything that uses pose is
    relative to a baseline or centre.

## 7. Real traces: recording, labelling, evaluating

The harness accepts recorded sessions without changes:

```sh
pnpm --filter @sp/detection eval -- --trace session1.jsonl --labels session1.labels.json \
                                    --trace session2.jsonl --labels session2.labels.json --out report.json
```

Paths are resolved from the directory you run pnpm in. With `--trace`, synthetic scenarios run only
when `--scenario` is also given. `--policy policy.json` evaluates a different exam policy.

**Trace format (JSONL).** One record per line. Blank lines and `#` comments are allowed.

- A `FrameObservation`, exactly what the app passed to `engine.ingest()`.
- Control records for the other engine calls, so the replay reproduces the session:
  - `{"$":"camera","t":…,"label":"…","deviceIdHash":"…"}` for `setCameraInfo`
  - `{"$":"baseline","baseline":{…}}` for `setBaseline`
  - `{"$":"flush","t":…,"reason":"pause"}` for `flush`
  - `{"$":"meta",…}` is ignored (use it for app version, device, consent id and similar)

If a trace has no baseline record, the harness calibrates from its first 5 s.

A trace contains only derived numbers: poses, boxes, luma, hashes. It contains **no images**. Recording
still needs the candidate's explicit consent for research use, and traces fall under the retention
policy.

**Labels (JSON).** Use the format `[{"type":"candidate_absent","start":12.4,"end":31.0,"optional":false,"note":"…"}]`.

- Times are seconds from the first observation, or epoch ms if ≥ 1e11.
- Label what **actually happened**, from the session's reference video or the tester's script.
  Label behaviour, not the engine's output.
- `start` is when the behaviour began: the candidate turned their head, the phone appeared, the
  second person entered.
- `end` is when it stopped.
- Mark a label `optional: true` when it is ambiguous. Examples: a borderline head turn, a phone
  partly off-screen, a second person only in a reflection. Optional labels are neither required nor
  penalised.
- Label every occurrence. A pattern (`repeated_looking_away`, `offscreen_attention_pattern`,
  `unusual_movement`) spans from its first glance or exit to its last.
- Label browser events separately. They are not evaluated here because their source is exact.

**Recommended protocol.** For each detector, collect at least 30 positive episodes and at least 5 h
of label-free monitoring before quoting a rate. With 0 errors in n trials, the 95 % upper bound is
still ≈ 3 / n. Vary:

- lighting: daylight, a lamp behind the candidate, a dim room;
- cameras: laptop built-in, USB, phone-as-webcam; 480p and 720p;
- glasses and reflective glasses, hairstyles and head coverings, beards;
- skin tones;
- camera angles: below or beside the screen;
- distance;
- backgrounds, including posters with faces;
- device speed, which gives different fps.

Scripted sessions should include the synthetic scenarios' behaviours and natural, unscripted
periods. Report results per condition as well as overall. `--check` compares a run against the
stored baseline and fails on a drop in F1 or a rise in the false-alert rate. Use it in CI after
changing thresholds or detectors.

## 8. What synthetic evaluation can and cannot tell

**It can tell:**

- Whether the state machines honour the policy: onset durations, minimum-glance rules, hysteresis,
  merge gaps, `startedAt` / `endedAt` fidelity, snapshot caps and version ordering.
- Whether single bad frames, dropped detections, brief glances and ordinary jitter stay silent, and
  how much margin there is near thresholds.
- Whether one ongoing issue yields exactly one event, and root causes don't double-report. For
  example: covered lens vs absence, darkness vs obstruction, camera off vs everything else.
- Latency budgets and CPU cost per tick.
- Regressions. Run `--check` after every change.

**It cannot tell:**

- **Perception accuracy.** How often MediaPipe misses a real face, hallucinates one in a poster,
  mis-estimates gaze with glasses or at steep camera angles, or confuses a phone with a wallet or
  remote. The simulator assumes that faces and objects are reported when present, apart from the
  noise it injects.
- **Behaviour distributions.** How real candidates move, read, fidget and think. The restless
  scenario is a stress test, not a model of any population.
- **Image-level effects on the camera checks.** Auto-exposure ramps, compression, flicker and
  low-light noise.
- **Whether reviewers agree with the flags.** Production reviewer decisions (reviewed vs dismissed)
  measure this per detector.

## 9. Operational assumptions (host integration)

- **Un-mirrored analysis.** Analyse the un-mirrored video; mirror only the preview with CSS. Pose
  signs follow `POSE_CONVENTION`.
- **Tick scheduling.** Run analysis on a timer (5–10 Hz), not only on new-frame callbacks. A frozen
  track produces no new frames, and the engine must keep receiving ticks with the camera state. The
  host must not analyse the same frame twice, because that would look frozen.
- **Ticks while the camera is off.** While the camera is not live, keep calling `ingest` at ≥ 1 Hz
  with `camera` set and `frame: null`. Otherwise time-based transitions wait for the next tick. The
  disconnect episode is still emitted with the correct times, but late.
- **MediaPipe settings.** Configure `numFaces` ≥ 3 so a second face can be seen. Run the object
  detector at about 1 Hz with a score threshold at or below the policy minimum.
- **Grayscale frames.** Pass `gray` to `facesFromMediapipe` for face-region brightness and
  visibility. Compute frame metrics on the same downscaled frame (`createFrameMetricsTracker`).
- **Session boundaries.** Call `setBaseline` after check-in and after every resume. Call
  `flush(t, reason)` at pause, hold, submit and stop.
