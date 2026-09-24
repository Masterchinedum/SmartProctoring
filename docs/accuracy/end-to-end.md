# End-to-end identity under realistic webcam conditions

This report measures the whole product — candidate app in a real browser, server, identity engine v2 and the
webcam-v2.1 vision calibration — on **webcam-realistic video** instead of the sharp studio photos the earlier
end-to-end suite used. It reproduces the two failures the product owner saw with a real laptop webcam and says,
per scenario and condition, how often the system now does what it should, how long it takes, and where it still
falls short.

> **What these numbers are.** Simulated laptop-webcam video of public photos, fed to Chromium's fake camera, on a
> shared 4-CPU machine. They show how the complete system behaves under realistic image quality and timing, and they
> are repeatable (`pnpm --filter @sp/e2e exec playwright test tests/2[0-4]-realistic-*`). They are **not**
> production error rates: few identities, one source photo per person and day, synthetic head turns, and a few runs
> per case (§5).

## 1. The owner's two failures, reproduced and re-measured

Final run: commit 98b49a4 (calibration webcam-v2.1), 96 runs (3 per case), 2 Playwright workers on 4 CPUs,
1-minute load average 0.8–5.5 (median 3). **Every target was met; no run missed its target** (§3). Afterwards the
full e2e suite (`pnpm test:e2e`: 65 tests, including one more pass of every realistic case) passed 65/65 in 31 min
at 3f5069b, which differs from 98b49a4 only by recogniser research tooling.

**"A returning student needed several attempts to resume."**

* **Before (first realistic runs today).** With the vision calibration still in progress, a genuine student resuming
  with a window behind them got "try again" 5 times and was held. With active liveness, dim light and another room
  both failed all 5 attempts. Part of the liveness failure was this suite's own weak synthetic right turn (fixed
  since); part was a real client problem in dim light (§4.1).
* **Now: passes on the first attempt.** 3/3 in each of these conditions:

  | Condition | Median time from "Resume" to pass |
  |---|---|
  | same room, typical light | 6.9 s |
  | dim evening | 24 s |
  | window behind (backlit) | 24 s |
  | side lamp | 7 s |
  | laptop camera at 640×480, dim | 24 s |
  | another day (other hairstyle), typical light | 6.4 s |
  | another day, another room and USB camera | 6.5 s |
  | active liveness, typical light | 24 s |

* **Active liveness in dim light or another room.** Passes, 2/3 on the first attempt and 1/3 on the second. The
  slowest took 110 s.
* **Still weak: another day AND poor light.** 1 of 9 passed. In the other 8 the candidate gets lighting guidance and
  can keep trying; it is never called a different person.

**"A person swap right after exam start was not detected."**

* **Detected every run.** 12/12 swaps 5 s after the start were held as *possible different person*, for 3 kinds of
  swap:
  * A stands up and B sits down (~1 s with nobody in view);
  * a 0.5 s cross-dissolve, where the face never leaves the view;
  * A slides out while B slides in.
  
  Both 720p and 480p. The median time from B fully in view to the hold screen was 5.0 s (max 11.1 s). Target:
  median ≲ 20 s.
* **Family member.** A father replacing his son was held 6/6, in 4.9–5.0 s.
* **Dim look-alike.** The same look-alike in a dim room at 640×480 is never *confirmed*: by design, poor light alone
  never holds an exam. It becomes visible to staff 1.4–1.5 s after the swap (3/3), as non-matching identity checks,
  "suspect" evidence and an uncertain *identity could not be verified* event (reason: a suspected different
  person in poor light), while the candidate gets lighting guidance. Before
  webcam-v2.1 the look-alike scored 0.52–0.59 there and was labelled a match; nothing reached staff.

**Other results.**

* **Genuine long sessions.** Six 5-minute sessions of the genuine candidate with lighting changes (lamp off, side lamp,
  window light), head sway and glances: 213 identity samples, all matches. Zero false alarms, zero *could not
  verify*, no hold.
* **Liveness.** A turning head passes 9/9 (7 on the first attempt). A still photo never passes (6/6, held as *could
  not verify*, never a mismatch).
* **Staff camera test page.** Staff see B as a different person 2.5–3 s after B sits down.

## 2. How it was measured

**System under test.** The real product end to end: the built candidate and staff apps in Chromium, the server
started from source (`NODE_ENV=production`) with a fresh Postgres database, the server's YuNet / SFace identity
pipeline (calibration `webcam-v2.1`, embedding model id 2) and the in-browser MediaPipe monitoring and liveness
guidance. Nothing is mocked except the camera. The identity policy is the **product default**: bursts of 3 frames;
a sample every 6 s for the first 3 minutes after a start or resume, then every 15 s; hold for review on a confirmed
mismatch; 5 attempts; 2 random head-turn steps when liveness is on. Fullscreen is off (headless browser). Liveness is
off in scenarios without head turns, because a recorded video cannot follow instructions.

**Camera resolution.** Chromium's fake camera delivers the video file's own size: a 1280×720 file gives the app a
720p track, like most laptop webcams (the app asks for 1280×720); a 640×480 file gives a VGA track. Every run records
the resolution the app actually received. The earlier fixtures were all 640×480 studio photos, so the earlier suite
never exercised the 720p capture path.

**Fixtures** (`e2e/lib/realistic.ts`, `e2e/scripts/make-realistic.ts`). Built locally and never committed. The vision
team's laptop-webcam simulator (`apps/server/src/eval/webcam-sim.ts`) renders each frame from public multi-image
identity sets: auto-exposure, sensor noise, optics and noise-reduction blur, colour cast, JPEG. The builder then
composes the frames into videos:

| | |
|---|---|
| Candidate A | deepface `p03`. `img47` on exam day; `img8` on "another day" (hair down, smiling, different make-up); `img51` on a third day (head-turn video in another room) |
| Person B | `rose_leslie img2`, a plausible substitute: same gender and colouring. SFace similarity to A's photos is 0.25–0.36, the most A-like non-relative in the sets |
| Family | Azure Face `Family1-Son1` (the candidate) and `Family1-Dad3` (his father). Source-photo similarity 0.23–0.30 |
| Scenes | `home`: laptop webcam 1280×720, inter-eye distance 75 px (~60 cm). `home480`: the same camera at 640×480. `other`: another room with a USB webcam at 640×480, inter-eye 39 px, warm light, low JPEG quality |
| Conditions (home) | **good**: face luma 139, noise σ 2.3. **typical**: 106 / 4.7, blur 1.0 px, JPEG 84. **dim**: face luma 54, noise σ 9.4, blur 1.5 px, motion blur 1.1 px, JPEG 79 (the server measures brightness ≈ 50, contrast ≈ 8). **backlit**: 61 / 6.3 with a bright window and flare lift 25 (server contrast ≈ 7). **side-lit**: 99 / 5.3, dark/bright side ratio 0.18 |

The scene seeds put every simulator parameter near the **middle** of its range. The dim fixture is the simulator's
mid-range evening room, not its harsh screen-lit end (face luma 35–45) that `identity-v2.md` also covers. On top of
the renders the builder adds:

* continuous head and body sway of a few px;
* glances: ±5–8° head turns every ~7 s in the long runs;
* standing up and sitting down;
* 0.5 s cross-dissolves, for lighting changes and for swaps where the face never leaves the view;
* sliding out and sliding in;
* fresh sensor noise on every frame, at 5 frames per second.

Head turns for active liveness warp the nose region of the source photo before simulation, using the parallax
approach of `synth-headturn.ts`. They are calibrated per person to ±25° of measured yaw. Where the warp saturates on
one side (photo `img47` to the subject's right), the right turn is the mirrored left turn. The embedding uses flip
test-time augmentation, so a mirrored face has the same identity. The browser measures the turns at +27° / −25° in
typical light and +30° / −32° in dim light.

**Metrics.** Each test appends a JSON record to `e2e/.artifacts/realistic-metrics.jsonl`, with the commit and the
machine load; `pnpm --filter @sp/e2e rw:report -- --run <id> --write` regenerates §3. Times are wall-clock from the
candidate's action to what the candidate or staff see:

* clicking Resume → the outcome screen;
* the start of the check → the ready screen;
* the new person fully in view → the hold screen.

A swap test starts the exam 5 s before the swap in the video, so the swap happens right after the start (the owner's
case).

## 3. Results

<!-- rw:tables:start (generated by `pnpm --filter @sp/e2e rw:report -- --run <id> --write`) -->

Measurement runs: 2026-09-24T21-03-51-442Z — 96 measurements, 2026-09-24 21:04 to 2026-09-24 22:00 UTC; commit 98b49a4+dirty; 2 Playwright worker(s) on 4 CPUs; machine load (1-min load average at the end of each test) min 0.8 / median 3 / max 5.5.

### Summary against the targets

| requirement / target | runs | met | key numbers (median / max) | verdict |
|---|---|---|---|---|
| Returning student resumes on the FIRST attempt (typical / dim, same day; another day in typical light; liveness on in typical light) | 12 | 12/12 | time to pass 15.5 / 24.1 s | **met** |
| Resume within 2 attempts (backlit, side lamp, VGA camera, other room / camera, liveness in dim / other room) | 18 | 18/18 | 1st attempt 16/18; time 24.2 / 109.6 s | **met** |
| Another day AND poor light: passes or honestly "unable to verify" with guidance — never a mismatch | 9 | 9/9 | passed 1/9 (1st attempt 0) | **met** |
| Genuine candidate never called a different person (all resume + long runs) | 45 | 0 false identity_mismatch |  | **met** |
| Impostor never passes a resume check (B typical / dim / backlit; son resumes father's exam) | 12 | 12/12 | held as identity_mismatch 3/12 | **met** |
| Quick swap right after exam start (typical light; gap / cross-dissolve / slide; 720p / 480p): held as identity_mismatch, median ≲ 20 s | 12 | 12/12 | delay new person in view → hold 5 / 11.1 s | **met** |
| Swap in a dim room (no gap, 480p): held, or staff-visible suspect / inconclusive (non-matching identity check or identity event) within ~30 s | 3 | 3/3 | held 0/3, delay – / – s; first signal 1.4 / 1.5 s | **met** |
| Family member (father replaces son) mid-exam: held, or staff-visible suspect / inconclusive within ~30 s | 6 | 6/6 | held 6/6, delay 4.9 / 5 s; first signal 0.6 / 0.8 s | **met** |
| Genuine candidate ≥ 5 min with lighting changes and head movement: zero identity_mismatch, no hold | 6 | 6/6 | 213 samples; identity_unverifiable 0 | **met** |
| Active liveness with realistic head turns (typical / dim / other room + VGA) passes | 9 | 9/9 | 1st attempt 7/9; time 32 / 109.5 s | **met** |
| A still photo never passes active liveness (held "could not verify", never a mismatch) | 6 | 6/6 |  | **met** |
| Staff camera test page: enrol A, A consistent, B confirmed as a different person | 3 | 3/3 | B suspect after 1.6 / 2 s, confirmed after 2.6 / 3 s | **met** |

### Resume — genuine candidate (scenario 20)

| condition | liveness | target | camera | runs | target met | 1st-attempt pass | passed | attempts med/max | time to outcome s med/max | re-prompts | resume-check decisions @ similarity | false mismatch |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| typical | off | first | 1280x720 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 6.9 / 7.4 | 0 | match@0.985; match@0.988; match@0.982 | 0 |
| dim | off | first | 1280x720 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 23.8 / 23.8 | 0 | match@0.830; match@0.849; match@0.838 | 0 |
| backlit | off | within2 | 1280x720 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 24.3 / 24.4 | 0 | match@0.823; match@0.824; match@0.820 | 0 |
| sidelit | off | within2 | 1280x720 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 7.2 / 7.3 | 0 | match@0.966; match@0.970; match@0.967 | 0 |
| dim-480p | off | within2 | 640x480 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 24.2 / 24.8 | 0 | match@0.596; match@0.593; match@0.600 | 0 |
| other-day-typical | off | first | 1280x720 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 6.4 / 7.1 | 0 | match@0.710; match@0.696; match@0.701 | 0 |
| other-day-dim | off | honest | 1280x720 | 3 | 3/3 | 0/3 | 1/3 | 5 / 5 | 50 / 50 | 0 | inconclusive@0.362 inconclusive@0.415 inconclusive@0.384 inconclusive@0.360 inconclusive@0.358; inconclusive@0.405 inconclusive@0.369 inconclusive@0.364 inconclusive@0.361 inconclusive@0.361; inconclusive@0.367 match@0.486 | 0 |
| other-day-backlit | off | honest | 1280x720 | 3 | 3/3 | 0/3 | 0/3 | 5 / 5 | 73 / 79.5 | 0 | inconclusive@0.340 inconclusive@0.340 inconclusive@0.386 inconclusive@0.407 inconclusive@0.340; inconclusive@0.329 inconclusive@0.329 inconclusive@0.364 inconclusive@0.383 inconclusive@0.348; inconclusive@0.342 inconclusive@0.342 inconclusive@0.379 inconclusive@0.342 inconclusive@0.379 | 0 |
| other-day-room-camera | off | within2 | 640x480 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 6.5 / 7.2 | 0 | match@0.672; match@0.673; match@0.670 | 0 |
| other-day-room-camera-dim | off | honest | 640x480 | 3 | 3/3 | 0/3 | 0/3 | 5 / 5 | 78 / 81.5 | 0 | inconclusive@0.071 inconclusive@0.071 inconclusive@0.051 inconclusive@0.089 inconclusive@0.051; inconclusive@0.040 inconclusive@0.082 inconclusive@0.063 inconclusive@0.063 inconclusive@0.063; inconclusive@0.056 inconclusive@0.056 inconclusive@0.056 inconclusive@0.056 inconclusive@0.056 | 0 |
| typical | active | first | 1280x720 | 3 | 3/3 | 3/3 | 3/3 | 1 / 1 | 24.1 / 24.1 | 0 | match@0.982; match@0.982; match@0.988 | 0 |
| dim | active | within2 | 1280x720 | 3 | 3/3 | 2/3 | 3/3 | 1 / 2 | 50.2 / 87.3 | 0 | match@0.843; inconclusive@0.804 match@0.841; match@0.812 | 0 |
| other-day-room-camera | active | within2 | 640x480 | 3 | 3/3 | 2/3 | 3/3 | 1 / 2 | 32.7 / 109.6 | 0 | match@0.707; match@0.709; inconclusive@0.727 match@0.733 | 0 |

### Resume — impostor (scenarios 20 / 3)

| impostor | runs | never passed | held: identity_mismatch | outcomes | attempts med/max | time to outcome s med/max | resume-check decisions @ similarity |
|---|---|---|---|---|---|---|---|
| B-typical | 3 | 3/3 | 0/3 | hold (identity_unverifiable) | 5 / 5 | 26.6 / 26.8 | inconclusive@0.350 inconclusive@0.350 inconclusive@0.345 inconclusive@0.349 inconclusive@0.350; inconclusive@0.352 inconclusive@0.364 inconclusive@0.373 inconclusive@0.346 inconclusive@0.361; inconclusive@0.366 inconclusive@0.379 inconclusive@0.366 inconclusive@0.366 inconclusive@0.381 |
| B-dim | 3 | 3/3 | 0/3 | retry | 5 / 5 | 28.5 / 28.7 | inconclusive@0.339 inconclusive@0.353 inconclusive@0.333 inconclusive@0.340 inconclusive@0.342; inconclusive@0.340 inconclusive@0.347 inconclusive@0.291 inconclusive@0.319 inconclusive@0.324; inconclusive@0.337 inconclusive@0.346 inconclusive@0.327 inconclusive@0.331 inconclusive@0.349 |
| B-backlit | 3 | 3/3 | 0/3 | retry | 5 / 5 | 44.2 / 44.3 | inconclusive@0.315 inconclusive@0.313 inconclusive@0.324 inconclusive@0.293 inconclusive@0.310; inconclusive@0.318 inconclusive@0.305 inconclusive@0.315 inconclusive@0.296 inconclusive@0.324; inconclusive@0.301 inconclusive@0.318 inconclusive@0.329 inconclusive@0.311 inconclusive@0.324 |
| family-son-for-father | 3 | 3/3 | 3/3 | hold (identity_mismatch) | 1 / 1 | 7 / 7.4 | mismatch@0.301; mismatch@0.300; mismatch@0.300 |

### Quick swap right after exam start (scenario 21)

| variant | camera | runs | requirement met | held (identity_mismatch) | delay s: new person in view → hold, med/max | delay s: transition start → hold | exam start → swap s | first staff-visible signal s | suspect seen | false alarm before swap | first identity checks after the swap (s after new person in view) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| gap-720p | 1280x720 | 3 | hold: 3/3 | 3/3 | 5.8 / 8.5 | 8.4 / 11.1 | 4.7 | 0.5 / 0.5 | 3/3 | 0/3 | +0.5s track_break:inconclusive@0.37 +4.1s appearance_change:inconclusive@0.39 +7.5s server_request:inconclusive@0.34; +0.5s track_break:inconclusive@0.35 +3.9s server_request:inconclusive@0.39 +4.9s appearance_change:inconclusive@0.40; +0.5s track_break:inconclusive@0.34 +3.9s server_request:inconclusive@0.38 |
| no-gap-crossfade-720p | 1280x720 | 3 | hold: 3/3 | 3/3 | 5 / 11.1 | 5.5 / 11.6 | 4.7 | 0.6 / 0.8 | 3/3 | 0/3 | +0.6s appearance_change:inconclusive@0.36 +4.2s server_request:inconclusive@0.36; +0.6s appearance_change:inconclusive@0.35 +4.1s server_request:inconclusive@0.36; +0.8s appearance_change:inconclusive@0.39 +6.8s server_request:inconclusive@0.38 +10.2s server_request:inconclusive@0.36 |
| gap-480p | 640x480 | 3 | hold: 3/3 | 3/3 | 4.9 / 5 | 7.5 / 7.6 | 4.7 | 0.5 / 0.5 | 3/3 | 0/3 | +0.5s track_break:inconclusive@0.36 +3.9s server_request:inconclusive@0.36; +0.5s track_break:inconclusive@0.36 +3.9s server_request:inconclusive@0.35; +0.5s track_break:inconclusive@0.35 +3.9s server_request:inconclusive@0.35 |
| no-gap-slide-480p | 640x480 | 3 | hold: 3/3 | 3/3 | 4.9 / 5 | 5.4 / 5.5 | 4.7 | 0.8 / 0.8 | 3/3 | 0/3 | +0.8s appearance_change:inconclusive@0.35 +4s server_request:inconclusive@0.35; +0.8s appearance_change:inconclusive@0.34 +4s server_request:inconclusive@0.35; +0.6s appearance_change:inconclusive@0.34 +4.2s server_request:inconclusive@0.35 |
| dim-no-gap-crossfade-480p | 640x480 | 3 | signal: 3/3 | 0/3 | – / – | – / – | 4.7 | 1.4 / 1.5 | 3/3 | 0/3 | +1.4s appearance_change:inconclusive@0.52 +5s server_request:inconclusive@0.51 +8.6s server_request:inconclusive@0.51 +12.1s server_request:inconclusive@0.49; +1.5s appearance_change:inconclusive@0.53 +7.4s server_request:inconclusive@0.48 +11.6s server_request:inconclusive@0.55 +15s server_request:inconclusive@0.53; +1.4s appearance_change:inconclusive@0.55 +7.2s server_request:inconclusive@0.59 +11.6s server_request:inconclusive@0.53 +15s server_request:inconclusive@0.54 |

### Family member takes over mid-exam (scenarios 21 / 3)

| variant | camera | runs | requirement met | held (identity_mismatch) | delay s: new person in view → hold, med/max | delay s: transition start → hold | exam start → swap s | first staff-visible signal s | suspect seen | false alarm before swap | first identity checks after the swap (s after new person in view) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| family-gap-720p | 1280x720 | 3 | signal: 3/3 | 3/3 | 4.9 / 5 | 7.5 / 7.6 | 4.7 | 0.5 / 0.5 | 3/3 | 0/3 | +0.5s track_break:mismatch@0.29 +3.9s server_request:inconclusive@0.30; +0.4s track_break:inconclusive@0.30 +3.8s appearance_change:inconclusive@0.31; +0.5s track_break:inconclusive@0.31 +3.9s server_request:inconclusive@0.32 |
| family-no-gap-crossfade-480p | 640x480 | 3 | signal: 3/3 | 3/3 | 4.9 / 4.9 | 5.4 / 5.4 | 4.7 | 0.8 / 0.8 | 3/3 | 0/3 | +0.8s appearance_change:mismatch@0.29 +4.2s server_request:mismatch@0.29; +0.6s appearance_change:mismatch@0.29 +4s server_request:inconclusive@0.30; +0.8s appearance_change:inconclusive@0.30 +4s server_request:inconclusive@0.33 |

### Genuine candidate, long runs (scenario 22)

| case | run | camera | minutes | identity samples | decisions | min similarity | median similarity | identity_mismatch | identity_unverifiable | lighting_unusable | held | evidence states |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| typical-with-light-changes | 1 | 1280x720 | 5 | 37 | match 37 | 0.82 | 0.96 | 0 | 0 | 0 | no | consistent |
| typical-with-light-changes | 2 | 1280x720 | 5 | 37 | match 37 | 0.81 | 0.97 | 0 | 0 | 0 | no | consistent |
| typical-with-light-changes | 3 | 1280x720 | 5 | 37 | match 37 | 0.80 | 0.96 | 0 | 0 | 0 | no | consistent |
| mostly-dim | 1 | 1280x720 | 5 | 34 | match 34 | 0.79 | 0.82 | 0 | 0 | 0 | no | consistent |
| mostly-dim | 2 | 1280x720 | 5 | 34 | match 34 | 0.65 | 0.83 | 0 | 0 | 0 | no | consistent |
| mostly-dim | 3 | 1280x720 | 5 | 34 | match 34 | 0.79 | 0.82 | 0 | 0 | 0 | no | consistent |

### Active liveness at check-in (scenario 23)

| case | camera | runs | passed | 1st attempt | time s med/max | re-prompts |
|---|---|---|---|---|---|---|
| typical | 1280x720 | 3 | 3/3 | 3/3 | 31.6 / 32 | 0 |
| dim | 1280x720 | 3 | 3/3 | 2/3 | 50.1 / 109.5 | 0 |
| other-room-camera-480p | 640x480 | 3 | 3/3 | 2/3 | 23.9 / 93.5 | 0 |
| still-typical (must never pass) | – | 3 | 0/3 passed | – | 78.2 / 97 → identity_unverifiable | – |
| still-dim (must never pass) | – | 3 | 0/3 passed | – | 92.6 / 100.5 → identity_unverifiable | – |

### Staff camera & identity test page (scenario 24)

| run | camera | enrolment | states with A | states with B | B suspect after s | B confirmed after s |
|---|---|---|---|---|---|---|
| 1 | 1280×720 · faces in view: 1 · yaw 1° | Enrolled 8 of 8 frames. Now start the live comparison. | consistent | suspect, confirmed_mismatch | 0.8 | 2.6 |
| 2 | 1280×720 · faces in view: 1 · yaw 1° | Enrolled 8 of 8 frames. Now start the live comparison. | consistent | monitoring, suspect, confirmed_mismatch | 2 | 3 |
| 3 | 1280×720 · faces in view: 1 · yaw 1° | Enrolled 8 of 8 frames. Now start the live comparison. | consistent | monitoring, suspect, confirmed_mismatch | 1.6 | 2.5 |

### Runs that missed their target

None.

<!-- rw:tables:end -->

## 4. What changed during this work, and what is still open

**Found by these scenarios and fixed**

1. **Active liveness failed in dim light (client).** Fixed in this work.
   * *Cause.* In a dim room the browser's face model still finds the face, but its yaw jumps ±8° from frame to frame;
     in good light it jumps ±1–2°. The head-turn tracker captures a step frame only when the head has *stopped at the
     peak* of the turn: less than 4° of movement over 300 ms, within 3° of the largest turn of the last second. On raw
     dim-light poses that almost never happens, so no step frame was sent and the attempt stalled or expired.
   * *Fix.* `apps/web/src/candidate/check/poseFilter.ts`: a noise-adaptive median of the pose. The window is ~250 ms
     when the pose is steady and up to 1 s when it is jittery. `VerifyStep.tsx` feeds the smoothed pose to the liveness
     tracker only; the server still measures every frame itself.
   * *Tests.* `poseFilter.test.ts`, 7 unit tests, including a replay of the tracker with ±8° noise.
   * *A/B on dim liveness at check-in (720p):*

     | Client smoothing | First-attempt pass | Median time (max) |
     |---|---|---|
     | Off (raw poses) | 0/3 (3/3 eventually) | 140 s (164 s) |
     | On | 4/4 | 40 s (86 s) |

2. **Backlit resume burned all attempts** (identity engine, 5f27235; vision, webcam-v2.1).
   * *Cause.* With a window behind the candidate, face contrast was ≈ 6.6–7.1, right at the gate's minimum of 7, so
     ~80 % of frames were unusable. Each attempt ended "uncertain" with 1–2 usable frames, although those frames
     scored 0.74–0.84.
   * *Fix.* Checks now extend while usable frames agree, pool evidence across retries, and count a quality-only
     failure as half an attempt; webcam-v2.1 accepts confident frames with contrast 5–7 in backlight.
   * *Result.* Backlit resume passes at the first attempt, 3/3.
3. **Dim look-alike was accepted as the candidate** (vision, webcam-v2.1; identity engine, 5f27235).
   * *Cause.* In a dim room at 640×480, B's bursts scored 0.52–0.59 against A's dim enrolment and were labelled
     "match".
   * *Fix.* Models are now conditioned on reference quality, sample labels take the LLR into account, and a suspected
     swap in poor light is shown to staff.
   * *Result.* Such a sample now reads "inconclusive", the evidence reaches "suspect", and staff see it within 1.5 s.
4. **Head-pose asymmetry** (vision, webcam-v2.1). YuNet's landmarks gave +30° and −18.5° of yaw for exact mirror
   images of a synthetically turned face. The pose now averages the landmarks of the frame and its mirror.
5. **An outdated e2e expectation.** Spec 5b asserted identity v1's failure mode: a dim studio room (brightness ~65,
   contrast ~17) must end "unable to verify". Under gate v2 that image is usable and the genuine resume passes at
   the first attempt, which is the fix the owner asked for. 5b now asserts that pass. The "unable to verify →
   guidance → light on → pass" path moved to a truly dark room (5b2).
6. **Diagnosability.** A failed test attaches the server-log lines written during it, and each candidate page's
   identity API answers (check frames with quality, pose and progress; completes with outcome and liveness reasons;
   samples with decision, similarity and evidence) plus a trace of the identity-check screen. Global setup keeps the
   previous runs' server logs instead of overwriting them. The earlier flaky 3b (head-turn liveness at resume under 2
   workers) passed 5/5 in a rerun with 2 workers; the next failure, if any, will carry its logs.

**Still open — honest gaps**

1. **Another day AND poor light.** Genuine similarity is 0.33–0.41 in a dim or backlit room at home, and 0.04–0.09 in
   a dim room with a VGA camera. The system cannot tell these images apart from a look-alike, so it says "unable to
   verify" with lighting guidance: 8 of 9 returning students in these conditions did not pass without improving the
   light. They are never called a different person, and quality-only failures cost half an attempt. The fix is
   better light, or staff review.
2. **Look-alike impostor at a resume.** Person B never passed a resume check (12/12), but she was never labelled a
   *possible different person* either:
   * in typical light her checks read "inconclusive" at 0.35–0.38 and the session was held as *could not verify*
     after 5 attempts (~27 s);
   * in dim or backlit light she was still being asked to retry after 5 attempts.

   Resume uses the lenient cross-day model (so a genuine candidate is not flagged after a change of room or camera),
   and B's score falls between the two populations. The same person swapped in mid-exam is held in ~5 s. The
   father resuming his son's exam scored 0.30 and was held as *possible different person* at the first attempt.
   Consider escalating repeated inconclusive-low scores across the pooled attempts to staff earlier.
3. **Dim no-gap swap: a signal, not a hold.** By design, poor light never confirms a swap on its own. The session
   continues, and staff must act on the uncertain signal (§1).
4. **Liveness needed a second attempt in 2 of 9 runs.** Once in dim light the tracker stalled on one turn. Once
   with the VGA camera in another room, the server rejected the attempt as "Submitted frames are identical — a
   live camera image is required". At 640×480 with a 39 px face, the dHash of the face crops of this synthetic turn
   differed from the frontal frame by ≤ 2 bits (`minFrameHamming`). That is probably a fixture limit, since real turns
   change the ears and cheeks, but it should be checked with real VGA head turns. Liveness in dim light takes 50 s at
   the median (max 110 s).
5. **One person per source photo per day.** Genuine similarities within a session (0.8–0.99) are higher than a real
   session with changing expressions would give (§5).

## 5. Caveats — read before quoting a number

* **A fake camera is not a webcam.** Frames are rendered, not captured. The simulator models exposure, noise, blur,
  colour and compression per its documented ranges (`identity-v2.md` §3), and the result looks and measures like a
  webcam (brightness, contrast, noise and pose jitter as listed above). It still cannot reproduce everything a real
  sensor does: rolling shutter, flicker, auto-exposure hunting, real motion blur of a moving head.
* **Cut-out people.** Each person is a head-and-shoulders cut-out of a photo over a synthetic room. Within one
  session the source photo is the same, so the video has no natural changes of expression, glasses or pose. It varies
  only through noise, sway, glances and lighting. Real sessions vary more, which should make genuine matches harder
  than here. "Another day" uses a different photo of the same person, the closest thing available to a real return.
* **Synthetic head turns.** A nose-region warp, not a 3-D head rotation. The pose estimators read the turns as
  25–32°, but the images lack the cues of a real turn: the far cheek hiding, the ear appearing. On this warp YuNet's
  yaw is not mirror-symmetric (+30° vs −18.5° on exact mirror images). The server's 12° requirement still passes, but
  real turns may measure differently.
* **Few identities.** Five people from public sets and one family pair: a child replaced by his father. Similarity
  distributions and error rates across demographics come from the offline evaluation (`identity-v2.md`: 43
  identities, 3 families), not from here.
* **Few runs.** Each case runs 3 times, so "3/3" means "no failure seen in 3 runs", not "100 %". Timings are medians
  of a handful of runs.
* **Shared, loaded machine.** 4 CPUs shared with other workloads (model training, evaluations, unit tests during
  development); the 1-min load average at the end of each test is recorded above. Heavy load slows the check, the
  sampling cadence and the server's vision queue. Timing-sensitive results (time to pass, detection delay, liveness
  within the challenge window) are pessimistic on a loaded box.
* **What is not covered here:** real cameras (use the staff *Camera & identity test* page and the candidate
  `?debug=1` overlay with a real webcam), glasses or masks, several people sharing a desk, a real network, the
  external second-opinion verifier (off by default), and ID-photo comparison (covered by spec 16 with studio photos).
