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

The latest run used 48 scenarios × 10 seeds = 480 traces and 62.4 h of simulated monitoring: the 33
original scenarios and 15 **attention** scenarios of realistic exam-taking with the exam page's interaction
timing (§3.2). It takes about 40 s on one CPU core.

| Question | Result (synthetic) |
|---|---|
| Looking-away-family alerts (`looking_away`, `repeated_looking_away`, `offscreen_attention_pattern`) during **normal exam-taking** on a laptop, a laptop low on the lap, and a laptop camera beside an external monitor: reading, answering with the mouse, typing an essay (hunt-and-peck and touch), thinking look-ups, sipping, stretching (28.3 h) | **0 / h** (0 of 60 sessions flagged). The previous engine: **9.67 / h**, 42 of 60 sessions flagged (§4.1). Held-out seeds 11–40: 0 in 85 h |
| Off-screen behaviour: notes beside the laptop, a phone in the lap, a second screen, talking to someone, looking away for 10–30 s, notes while typing, an external-monitor setup, a look away before the region is learned | **all caught**: 130 / 130 required detections (the previous engine: 128 / 130), same onset latency (5.1 s for sustained looks, ~60 s for 4-glance patterns) |
| False alerts per hour in the original label-free sessions (no interaction timing: clean, noisy, restless, sub-threshold, still) | **0.02 / h**: 1 `looking_away` in 200 min of a deliberately restless candidate (unchanged) |
| One-frame extra face, one-frame phone, one-frame dark frame, dropped faces, glances < 1.2 s | **never flagged**. The `noisy_frames` scenario runs these at about 8× the normal rate |
| Duplicate events for one ongoing issue | **0**: every detected ongoing issue appeared as exactly one event (the previous engine reported the same notes pattern twice 12 times) |
| Short intrusion of a second face (1.5 s) | **10 / 10** flagged, 1.0–1.2 s after it began. 0.6 s intrusions were not flagged, by policy |
| Detectors with recall < 1 | `looking_away` 107 / 110: three 6-s looks only ~5° above threshold. `camera_feed_suspect` 18 / 20: two replay loops with almost no visible motion (§5) |
| Engine cost | ≤ 0.13 ms per tick (Node 22). Memory is bounded: ≈ 10 min of 1 Hz hashes, a few hundred ring-buffer entries, 1 600 attention samples |

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
| `looking_away` | Attention outside the candidate's **screen region** — beyond `lookAwayYawDeg` (28°) to a side, `lookDownPitchDeg` (20°) down or `lookUpPitchDeg` (35°) up from its centre, widened where the learned region is wider — for `lookAwaySec` (5 s); a look that is mostly **up** needs `lookUpSec` (15 s) | The region is learned during the exam from where the candidate looks while using the mouse and keyboard; the calibration baseline is its starting point (§2.3). Looking down at the keyboard while typing is excused. `details.direction` ∈ `GAZE_DIRECTIONS`, from the candidate's perspective (`left` = the candidate's left); `details.maxYawOffsetDeg` / `maxPitchOffsetDeg` (head, from the screen centre); `details.reference` = `learned`, `cold_start` or `calibration`. |
| `repeated_looking_away` | ≥ `repeatedLookAwayCount` (5) glances within `repeatedLookAwayWindowSec` (120 s). A glance counts only if it lasts ≥ `glanceMinSec` (1.2 s) and < `lookAwaySec`. | Glances are away runs as above: outside the region, not excused by typing. A look up counts only when clearly beyond the region (up limit + 10°). Shorter glances are ignored completely. A glance counts from the moment it reaches 1.2 s, so the onset snapshot shows the candidate looking away. The episode stays open while glances continue and closes after max(20 s, 1.5 × window / count) without one. |
| `offscreen_attention_pattern` | ≥ `sameDirectionCount` (4) glances or looks toward the **same off-screen spot** within the window: attention vectors within 30° of each other in threshold-normalised space **and** at a similar distance beyond the limits (normalised radius within 0.5) | This is the more specific pattern (notes on the desk, a second screen, a phone in the lap). Glances toward its spot are attributed to it and are not counted for `repeated_looking_away` (§6). Each further glance adds a `peak` snapshot. |
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

### 2.3 Looking away while working: the candidate's working region

Candidates look at the laptop **screen**, not the camera. They read anywhere on it, look down at the keyboard
while typing, move the mouse, and look up while thinking. The first engine measured attention from the
calibration baseline, captured once per period while the candidate looked at the check screen or the camera,
with fixed thresholds. That flagged ordinary work (root cause, measured in §4.1):

- **the work pose is not the calibration pose.** With the camera above a laptop screen the working pose is
  8–15° lower than the check pose; with a laptop camera beside an external monitor it is 20–35° to the side;
- **keyboard glances.** A hunt-and-peck typist looks 20–35° down for 1–4 s every few seconds. Every glance of
  ≥ 1.2 s counted, so an essay produced repeated and same-direction "down" patterns;
- **eye gaze.** Reading the lower part of the screen moves the eyes down; blendshape "eye look down" values are
  large, and the eyes were added to the head pose beyond a small dead zone;
- **thinking look-ups** of 2–8 s up, up-left or up-right, and stretching, crossed the 25° up threshold.

**Interaction signals (timing only).** The exam page reports when the candidate last pressed a key (anywhere,
and in an answer field), moved or pressed the pointer, scrolled, and changed an answer: epoch ms on the
monitoring clock, as `FrameObservation.activity` (`@sp/shared` `ActivityTiming`). Never which key, what text,
or where the pointer is. It stays in the browser: it feeds the in-browser engine and appears only in a locally
downloaded evaluation trace. Observations without `activity` (older clients and traces) keep the calibration
geometry.

**The working region (`src/engine/attention.ts`, `ATTENTION_PARAMS`).** Learned online per camera, with robust
statistics over bounded memory (ring buffers of 600 pointer, 300 typing, 300 calm-reading and 400 keyboard
samples of head yaw / pitch and eye gaze):

| Sample | Taken when | Used for |
|---|---|---|
| Screen, pointer | pointer moved / pressed, page scrolled or an answer changed within 1.5 s, no key within 1.5 s; within 55° / 40° of the baseline | screen centre (median head pose), eye-gaze centre, region extent |
| Screen, typing | a key within 1.5 s and attention inside the learned screen core (after warm-up) | same (a touch typist looks at the text) |
| Screen, calm reading | no interaction, head steady (range ≤ 4° over 5 ticks), inside the core (after warm-up); every 2nd tick | same; restricted to the core so it cannot widen the region |
| Keyboard | a key within 1.5 s, attention below the screen core and within ±12° of its centre — **committed only if another key follows within 1 s** | keyboard cone: horizontal 10th–90th percentile ± 5° (half-width 10–14°, centre within ±5°), bottom 5th percentile − 5° (at least 30° below the centre) |

- **Screen region:** centre = median head pose of the screen samples. Extents = 10th / 90th percentiles of the
  attention offsets, clamped to 6–20° sideways, 5–15° up, 6–14° down. Limits = max(policy threshold, extent +
  10°): a candidate who scans a wide monitor with their head widens the side limit; the policy threshold is the
  minimum.
- **Cold start:** until 25 interaction samples (≈ 5 s of mouse use), the centre blends from the baseline toward
  the samples and the limits carry generous extras (+10° sideways, +12° down, +10° up) that fade out.
- **Persistence:** the host keeps the learned state between periods of the same session in memory
  (`engine.attentionState()` → next engine's `attentionState` option). It is reset when the camera changes
  (another `deviceIdHash`, also mid-period) or when a new calibration moved by more than 15°.
- **Policy switch:** `attentionReference: 'calibration'` turns learning off (the previous geometry, with the new
  gaze, keyboard and look-up rules).

**Away decision** (per tick; attention = head offset from the screen centre + eye contribution):

1. Away when outside the boundary `(|h| / side limit)^3 + (|v| / vertical limit)^3 ≥ 1` (a rounded box: a look
   well off in both directions — down and to the side, where notes lie — counts before either limit alone;
   calibration-only mode keeps the plain box because its centre may be off by the work-pose offset).
2. **Typing excuse:** a downward breach inside the keyboard cone is excused while a key was pressed within
   `typingExcuseSec` (3 s). A side breach is never excused. When a look that was excused goes on after the typing
   stopped, it counts **from the last keystroke** (or from when the look began, if later): a phone in the lap
   right after typing is "looking down without typing" from then on.
3. **Up / thinking:** a look is "up" when mostly above the screen, or when the gaze elevation is ≥ 12° and it is
   not an extreme side turn (< 1.4 × the side limit): thinking looks go up-left / up-right; notes, second screens
   and people beside the desk are at eye level or below. Up runs need `lookUpSec` (15 s) for `looking_away`, and an
   up glance joins glance patterns only when its mean is > 10° beyond the up limit.
4. **Eye gaze confirms the head** (`gazeMode: 'confirm'`): the eyes (dead zone 0.1 around the learned gaze
   centre; ±1 ≈ 25° / 20°) count only where the head is already turned the same way — ramping from 30 % to 65 % of
   the limit — and always when they counter-rotate back toward the screen. Reading with the eyes (head near the
   centre) never becomes "away". Measured alternatives are in §4.2.

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

- **Attention scenarios (`src/eval/behaviour.ts`).** A target-driven head-and-eye model replaces the plain
  pose model. The candidate looks at targets (degrees from the middle of the screen they work on). For the
  first 5 s they look at the calibration target (the check screen / camera). The work centre sits 8–15° below
  it for a camera above a laptop screen, and 20–35° to the side for a laptop camera beside an external monitor
  when the check was done at the camera. The head covers 25–45 % of a shift within the screen and 55–85 % of a
  large shift (keyboard, notes, second screen), with a 0.3-s lag and the usual jitter; the eyes cover the rest
  and compensate 80 % of the head jitter. The reported gaze is a blendshape estimate: per-person gain
  (0.8–1.3 horizontal, 0.9–1.6 vertical, since "look down" reads strongly), bias and noise, clamped to ±1.
  Behaviour scripts generate reading (lines swept left to right, some passages filling the screen, scrolling),
  multiple-choice answers with the pointer (move, click, "Next"), essays typed hunt-and-peck (keyboard glances of
  1–4 s, 20–35° down, keys every 0.2–0.5 s while looking, then a look at the text) or by a touch typist (eyes on
  the text, a rare 0.5–1.5-s keyboard glance), thinking look-ups (2–8 s up / up-left / up-right every 1–3 min),
  sipping (reach, head tilted back) and stretching (3–8 s). The matching activity stream (pointer, clicks,
  scrolls, keys, answer changes) is reported on every observation, like the app.

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
  candidate for 5 min. These traces carry no `activity` (an older host), so the engine keeps the
  calibration geometry for them.
- **Attention scenarios, normal exam-taking (must not flag; `group: attention_normal`):**
  - `laptop_exam_hunt_typist`: 30 min, camera above the screen, check pose at the camera (work 8–15° lower):
    multiple-choice with the mouse for ~45 % of the time, then an essay typed hunt-and-peck; thinking look-ups,
    sipping, stretching;
  - `laptop_exam_touch_typist`: the same with a touch typist;
  - `external_monitor_cal_camera`: 30 min at an external monitor 20–35° to the side of the laptop camera, check
    done at the camera; `external_monitor_cal_monitor`: the check done on the monitor;
  - `laptop_low`: 30 min, small laptop held low (absolute pitch ≈ −20°), keyboard 20–28° below the screen;
  - `laptop_exam_restless`: stress test, 20 min, head jitter ±6°, noisy gaze, 3 brief glances / min.
- **Attention scenarios, off-screen behaviour (`group: attention_offscreen`),** 8 min each: 60–90 s of normal
  work first (reading and answering with the mouse, sometimes typing), then the behaviour interleaved with work,
  then work to the end. Labels are required for the detector each scenario measures; other looking-away events
  during the behaviour are allowed (optional labels):
  - `offscreen_side_notes`: notes 25–40° to one side and 20–35° down, 6 glances of 2–8 s, no typing during a glance;
  - `offscreen_phone_lap`: a phone in the lap 35–50° down, 3 looks of 5–30 s without typing (looks ≥ 6 s required);
  - `offscreen_phone_glances`: 6 phone checks of 2–5 s within ~2.5 min (a "down" pattern);
  - `offscreen_second_screen`: a second screen 35–50° to a side, 6 glances of 2–8 s;
  - `offscreen_talk_side`: turning 50–80° to talk to someone for 6–20 s, twice;
  - `offscreen_sustained`: looking away (left / right / down-left / down-right / down) for 10–30 s, twice;
  - `offscreen_external_monitor_notes`: external monitor (check at the camera) with notes on the other side;
  - `offscreen_notes_while_typing`: a touch typist copying from notes 25–35° to a side while typing;
  - `offscreen_early_sustained`: a 10–20-s look away 20–40 s into the exam, before the region is learned.

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
| Looking-away summary (`--attention`, report key `attention`) | Normal exam-taking: false alerts of `looking_away`, `repeated_looking_away` and `offscreen_attention_pattern` per hour and sessions with any. Off-screen behaviour: recall and latency of the detector each scenario measures; "caught" = the required label is overlapped (±2 s) by any looking-away-family event; events outside every label = false alerts during the surrounding normal work. |

## 4. Results

These are the results of `pnpm --filter @sp/detection eval` with default policy, seeds 1–10. The
JSON is in `detection-baseline.json` (its `attention` key holds the looking-away summary of §4.1).

| Event type | GT | TP | FP | FN | Dup | Precision | Recall | F1 | False alerts / h | Onset latency mean (s) | p95 (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `multiple_people` | 30 | 30 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 1.5 | 2.5 |
| `candidate_absent` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 8.8 | 9.3 |
| `looking_away` | 110 | 107 | 1 | 3 | 0 | 0.991 | 0.973 | 0.982 | 0.02 | 5.1 | 5.3 |
| `repeated_looking_away` | 10 | 10 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 63.1 | 71.7 |
| `offscreen_attention_pattern` | 60 | 60 | 0 | 0 | 0 | 1.000 | 1.000 | 1.000 | 0.00 | 61.3 | 77.7 |
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
- **Pattern latencies are long by definition.** The 4th or 5th glance of a scripted pattern happens about
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
| near_threshold_look_6s | 10 | 20 | looking_away ×10 | looking_away ×7 | — | looking_away ×3 |
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
| laptop_exam_hunt_typist | 10 | 300 | — | — | — | — |
| laptop_exam_touch_typist | 10 | 300 | — | — | — | — |
| external_monitor_cal_camera | 10 | 300 | — | — | — | — |
| external_monitor_cal_monitor | 10 | 300 | — | — | — | — |
| laptop_low | 10 | 300 | — | — | — | — |
| laptop_exam_restless | 10 | 200 | — | — | — | — |
| offscreen_side_notes | 10 | 80 | offscreen_attention_pattern ×10 | offscreen_attention_pattern ×10 | — | — |
| offscreen_phone_lap | 10 | 80 | looking_away ×30 | looking_away ×30 | — | — |
| offscreen_phone_glances | 10 | 80 | offscreen_attention_pattern ×10 | offscreen_attention_pattern ×10 | — | — |
| offscreen_second_screen | 10 | 80 | offscreen_attention_pattern ×10 | offscreen_attention_pattern ×10 | — | — |
| offscreen_talk_side | 10 | 80 | looking_away ×20 | looking_away ×20 | — | — |
| offscreen_sustained | 10 | 80 | looking_away ×20 | looking_away ×20 | — | — |
| offscreen_external_monitor_notes | 10 | 80 | offscreen_attention_pattern ×10 | offscreen_attention_pattern ×10 | — | — |
| offscreen_notes_while_typing | 10 | 80 | offscreen_attention_pattern ×10 | offscreen_attention_pattern ×10 | — | — |
| offscreen_early_sustained | 10 | 80 | looking_away ×10 | looking_away ×10 | — | — |

**The errors, explained:**

- **Restless candidate, one `looking_away` (seed 1, 6 s, confidence 0.68).** Jitter of ±7°, a
  reading posture and gaze noise lined up to keep attention past the down threshold for 5 s. This
  scenario carries no interaction timing, so the calibration geometry applies (as before the working
  region existed). The confidence is lower than for clear look-aways.
- **Near-threshold look, 3 misses (previously 2).** The head was turned about 34° for 6 s, only ~6° above
  the 28° threshold with ±3.5° jitter, so too few ticks exceeded the threshold within a 6-s span to meet
  the 70 % rule. The one extra miss comes from the eye handling (the eyes now count beyond a 0.1 dead zone
  around the gaze centre, where the previous engine used 0.15 around zero), which moves individual ticks
  by about ±1°. This is the intended trade-off at the boundary. Lowering `lookAwayYawDeg` or `lookAwaySec`
  moves it.
- **Replay, 2 misses.** In these seeds the looped clip barely changes the 64-bit image hash. Its
  consecutive-sample changes are 0–3 bits, at the noise floor of a live camera, so the replay cannot
  be told apart from a still live scene. See §5.

### 4.1 Looking away while working: before / after

**Before** = the engine as it was (commit `82a0034`: attention from the calibration baseline, fixed
thresholds, no interaction timing) replayed on the same attention scenarios; **after** = this engine with
default policy. Seeds 1–10 unless noted. Reproduce with `pnpm --filter @sp/detection eval -- --attention`
(and, for "before", the same harness on the old engine).

**Normal exam-taking — looking-away-family false alerts** (events; per hour; sessions with at least one):

| Scenario (10 × 30 min; restless 10 × 20 min) | Before: `looking_away` | Before: repeated | Before: same-direction | Before: per h | Before: sessions | After: all three | After: sessions |
|---|---:|---:|---:|---:|---:|---:|---:|
| Laptop, camera above the screen, hunt-and-peck typist | 13 | 0 | 13 | 5.20 | 10 / 10 | 0 | 0 / 10 |
| Laptop, touch typist | 0 | 0 | 2 | 0.40 | 1 / 10 | 0 | 0 / 10 |
| External monitor, check at the laptop camera | 104 | 5 | 49 | 31.60 | 10 / 10 | 0 | 0 / 10 |
| External monitor, check on the monitor | 19 | 0 | 7 | 5.20 | 8 / 10 | 0 | 0 / 10 |
| Small laptop held low (pitch −20°) | 0 | 0 | 3 | 0.60 | 3 / 10 | 0 | 0 / 10 |
| Restless candidate (stress) | 45 | 0 | 14 | 17.70 | 10 / 10 | 0 | 0 / 10 |
| **Total, 28.3 h** | **6.39 / h** | **0.18 / h** | **3.11 / h** | **9.67 / h** | **42 / 60** | **0 / h** | **0 / 60** |
| Held-out seeds 11–40, 85 h | | | | | | **0 / h** | **0 / 180** |

**Root cause, confirmed.** Each "before" false alert was attributed to what the scripted candidate was doing
during it (274 events): **keyboard glances while typing 131 (48 %)**, **reading at the work pose 106 (39 %)**
— almost all with an external monitor 20–35° from the camera, and the rest with the work pose 8–15° below a
laptop calibration plus eyes down on the lower part of the screen — and **thinking look-ups, stretching and
sipping 37 (13 %)**, alone or mixed with reading glances in a pattern.

**Off-screen behaviour — recall of the measured detector and onset latency:**

| Scenario | Measures | Before: recall | Before: latency mean / p95 (s) | After: recall | After: latency mean / p95 (s) | After, held-out 11–40 |
|---|---|---:|---:|---:|---:|---:|
| Notes on the desk to one side | `offscreen_attention_pattern` | 10 / 10 | 56.2 / 76.0 | 10 / 10 | 63.3 / 76.0 | 30 / 30 |
| Phone in the lap, 5–30 s, no typing | `looking_away` | 29 / 30 | 4.9 / 5.2 | 30 / 30 | 5.1 / 5.2 | 86 / 86 |
| Phone checks, 2–5 s × 6 | `offscreen_attention_pattern` | 10 / 10 | 17.7 / 64.8 | 10 / 10 | 63.0 / 81.9 | 28 / 30 |
| Second screen to a side | `offscreen_attention_pattern` | 10 / 10 | 56.1 / 88.6 | 10 / 10 | 62.8 / 77.1 | 29 / 30 (30 / 30 caught by a family event) |
| Turning to talk to someone | `looking_away` | 20 / 20 | 5.1 / 5.2 | 20 / 20 | 5.1 / 5.2 | 60 / 60 |
| Looking away 10–30 s | `looking_away` | 20 / 20 | 5.1 / 5.2 | 20 / 20 | 5.2 / 5.2 | 60 / 60 |
| External monitor + notes | `offscreen_attention_pattern` | 9 / 10 | 31.4 / 98.8 | 10 / 10 | 60.9 / 77.5 | 30 / 30 |
| Notes while touch-typing | `offscreen_attention_pattern` | 10 / 10 | 49.6 / 86.0 | 10 / 10 | 55.6 / 113.8 | 29 / 30 (30 / 30 caught) |
| Look away before the region is learned | `looking_away` | 10 / 10 | 5.1 / 5.2 | 10 / 10 | 5.1 / 5.2 | 30 / 30 |
| Looking-away-family events elsewhere in these 80-min sessions | | 37 | | 0 | | 0 |

Reading the latency columns: the "before" pattern latencies look shorter only because the old engine often
had a pattern open already — from keyboard glances or the turned work pose — when the behaviour began
(37 family events outside the behaviour; the family event that "caught" the external-monitor notes opened
on average 38 s *before* the first glance). After the change, a pattern opens when the 4th glance at the spot
qualifies, as specified.

**Trade-offs, stated plainly.** No required case lost recall on seeds 1–10. On held-out seeds, 2 of 30
phone-check patterns, 1 of 30 second-screen patterns and 1 of 30 notes-while-typing patterns did not reach
four qualifying glances (the family still caught the second screen and the notes). Phone checks shorter
than the 3-s typing excuse right after typing are not seen (§8). The first ~5 s of mouse use after a
camera change run with generous limits (cold start); the early-look scenario is still caught (a look of
35–50° exceeds even the cold-start limit).

### 4.2 Design choices, measured

**Eye gaze** (`gazeMode`; held-out seeds 11–30, 56.7 h of normal exam-taking per cell; off-screen
detections missed out of 257 required; measured with `lookUpSec` 12, before it became 15):

| Condition | `confirm` (default) | `deadzone` (previous: eyes beyond ±0.15) | `learned` (beyond the learned reading range) |
|---|---|---|---|
| Model as specified | 0 false alerts; 2 missed | 0; 1 missed | 0; 15 missed |
| Blendshape gain ×1.5 horizontal, ×1.8 vertical | 0; 1 missed | 0; 1 missed | — |
| Gain ×1.3 / ×1.4 and all reading 5° lower on the screen | 3 (stretch followed by a look-up, > 12 s up); 7 missed — **1 false alert with `lookUpSec` 15** | 0; 3 missed | — |
| Constant "look down" bias −0.3 (eyelids, glasses), gain ×1.3 / ×1.4 | 0; 3 missed | 0; 1 missed | — |

With the working region learned and the keyboard excused, all three modes stay near zero false alerts, and the
previous fixed dead zone even has slightly better recall. The default is nevertheless `confirm`: it is the only
mode in which the eyes **cannot** make a reading candidate "away" (the head must already be clearly turned),
which is the failure the owner reported and the one the synthetic eye model is least able to rule out
(real blendshape "look down" values vary with eyelids, glasses and camera angle). Centring the dead zone on the
learned gaze centre was worse (3–5 false alerts in the hardest condition) and widening it to 0.25 lost
second-screen recall (16 / 20). `--attention-param gazeMode=deadzone` replays a recording with the alternative,
so real traces can settle it.

**Boundary shape** (seeds 1–10 and held-out 11–40): a box missed diagonal glances (notes 20–25° to the side and
20° down, inside both limits: notes-while-typing 8 / 10, held-out 23 / 30); a rounded box, p = 3, catches them
(10 / 10, 29 / 30) with no false alert added in over 100 h of normal work. The previous-geometry mode keeps the box.

**Policy defaults** (one at a time from the defaults, seeds 1–10; normal exam-taking stayed at 0 alerts in
every variant, so the choice rests on recall, latency and the original scenarios without interaction timing):

| Field | Tried | Effect | Default |
|---|---|---|---|
| `lookAwaySec` | 4, **5**, 6 | 4: 1 s faster, 3× the false alerts without interaction timing; 6: misses 6-s looks (20 / 30) | 5 (unchanged) |
| `glanceMinSec` | **1.2**, 1.5, 2 | 1.5 loses a mixed-direction pattern; 2 loses most patterns (off 2 / 10) | 1.2 (unchanged) |
| `repeatedLookAwayCount` | 4, **5**, 6 | 6 loses one pattern; 4 no gain | 5 (unchanged) |
| `sameDirectionCount` | 3, **4** | 3 detects notes ~20 s sooner (41 s vs 61 s) but doubles false alerts without interaction timing | 4 (unchanged; 3 is a per-exam option for strict exams) |
| `lookDownPitchDeg` | 18, **20**, 22 | 18: 4× the false alerts without interaction timing; 22: slower patterns | 20 (unchanged) |
| `lookUpPitchDeg` (new) | 30, **35**, 40 | no difference on these scenarios; 35 = 10° above the previous up threshold | 35 |
| `lookUpSec` (new) | 8, 10, 12, **15** | no difference at nominal conditions; 15 removes the stretch-plus-thinking look (~14 s) under stress | 15 |
| `typingExcuseSec` (new) | 1.5, 2, **3** | no difference here (the excuse is backdated to the last keystroke when a look outlasts it) | 3 (as specified) |

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
- **Baseline.** Position thresholds are relative to the per-period baseline; attention thresholds are
  relative to the learned working region, which starts from the baseline (§2.3).
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

### 7.1 Recording a session (for the exam owner)

The app records exactly what the in-browser engine analysed when the exam link is opened with `?trace=1`.
Nothing extra is uploaded: the file stays in the browser until you download it.

1. Create a session as usual and copy the candidate link. Append `?trace=1` (or `&trace=1` if the link
   already has a `?`). Add `&debug=1` to also see the live diagnostics overlay, including "looking away from":
   whether the engine is still in cold start or uses the learned working region, the region's offset from the
   calibration and the current limits.
2. Take the check-in and the exam on the device you want to test (for example a MacBook, camera above the
   screen), the way a candidate would: read, answer with the mouse, type an essay, think. To test detection
   too, script some behaviour and **note the times** (a phone on your lap for 15 s, notes beside the laptop,
   looking at a second screen). Pausing and resuming is fine; the trace covers all periods of the page.
3. Download the trace with **"Download monitoring trace"**: in the exam page footer at any time, or on the
   "Your exam has been submitted" screen at the end. The file is `trace-<date>.jsonl`. The recorder keeps the
   most recent 40 000 lines, about 2 h at 5 Hz. A page reload starts a new trace, so download before reloading.
4. Send the `.jsonl` file (and your notes of what you did when) to whoever runs the evaluation. What it
   contains: face boxes, head pose, eye-gaze estimates, frame statistics (brightness, a 64-bit image hash),
   object detections and interaction **timing** (when a key, the pointer, scrolling or an answer last changed),
   plus the events the live engine raised. It contains **no images, no typed text, no keys and no pointer
   positions**. It is still personal data of the person recorded: get their consent and keep it under your
   retention policy.

To evaluate it:

```sh
pnpm --filter @sp/detection eval -- --trace ~/Downloads/trace-2026-09-29T10-00-00-000Z.jsonl
```

Without labels this lists every episode the engine raises on the recording, with times relative to the
first observation, direction and count; `--verbose` adds details. With labels (next section) it also scores
precision, recall and latency. `--policy policy.json` replays with another exam policy (for example
`{"detection":{"attentionReference":"calibration"}}` for the calibration-only geometry), so one recording can
compare settings. Traces recorded before interaction timing existed replay with the calibration geometry.

### 7.2 Evaluating recordings

The harness accepts recorded sessions without changes:

```sh
pnpm --filter @sp/detection eval -- --trace session1.jsonl --labels session1.labels.json \
                                    --trace session2.jsonl --labels session2.labels.json --out report.json
```

Paths are resolved from the directory you run pnpm in. With `--trace`, synthetic scenarios run only
when `--scenario` is also given. `--policy policy.json` evaluates a different exam policy.

**Trace format (JSONL).** One record per line. Blank lines and `#` comments are allowed.

- A `FrameObservation`, exactly what the app passed to `engine.ingest()`, including `activity` (interaction
  timing, epoch ms: `keyAt`, `answerKeyAt`, `pointerAt`, `clickAt`, `scrollAt`, `answerAt`).
- Control records for the other engine calls, so the replay reproduces the session:
  - `{"$":"camera","t":…,"label":"…","deviceIdHash":"…"}` for `setCameraInfo`
  - `{"$":"baseline","baseline":{…}}` for `setBaseline`
  - `{"$":"flush","t":…,"reason":"pause"}` for `flush`
  - `{"$":"meta",…}` is ignored (use it for app version, device, consent id and similar)

If a trace has no baseline record, the harness calibrates from its first 5 s.

A trace contains only derived numbers: poses, boxes, luma, hashes, interaction timing. It contains **no
images and no typed content**. Recording still needs the candidate's explicit consent for research use, and
traces fall under the retention policy. Replaying a multi-period trace uses one engine through the `flush`
records, which is equivalent to the app handing the learned working region from one period's engine to the
next (same camera).

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
- **How real candidates look while working.** The attention scenarios (§3.2) are a model: head / eye split,
  keyboard and screen geometry, blendshape gain and bias, reading and typing rhythms were chosen from general
  knowledge, not measured on candidates. The before / after comparison shows that the design removes the
  mechanisms that flagged ordinary work; the real false-alert rate needs recorded sessions (§7.1). **Record and
  replay real sessions — laptops with the camera above the screen, external monitors, hunt-and-peck and touch
  typists — before quoting a rate to customers.**

**Known limitations of the working-region design** (by construction, not only synthetic):

- **Keyboard-only candidates** (navigating with Tab / arrows, never touching the pointer) never warm the region
  from pointer use; the engine stays in cold start (calibration centre, generous limits): fewer false alerts,
  less sensitivity.
- **The first ~30–60 s** of each new camera are cold start: limits are 10–12° wider until about 5 s of mouse use.
- **Notes right next to the keyboard** (within ~12–15° of the screen's horizontal centre, below the screen) are
  indistinguishable from the keyboard while the candidate types. Notes further to the side are never excused.
- **A phone looked at right after typing** is excused for up to `typingExcuseSec` (3 s), then counts from the last
  keystroke; a short phone check (< 3 s) straight after typing is not seen.
- **Deliberate training**: moving the mouse while looking elsewhere is learned like screen use. Robust
  statistics (median, 10th–90th percentiles) and caps (the side limit cannot grow beyond 30°, down 24°) bound
  the effect.
- **Eye-gaze estimates** vary with glasses, eyelids and camera angle. The engine adds the eyes only where the
  head is already clearly turned, so eye-only glances (the head still) are missed by design.

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
- **Interaction timing.** Attach `activity` (last key / pointer / click / scroll / answer change, epoch ms on the
  observation clock) to every observation; without it the engine keeps the calibration geometry. Keep the
  engine's `attentionState()` when a period ends and pass it to the next period's engine
  (`attentionState` option) so the candidate's working region survives pause / resume; the engine resets it
  itself when the camera changes.
