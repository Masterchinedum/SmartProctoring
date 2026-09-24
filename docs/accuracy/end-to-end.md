# End-to-end identity under realistic webcam conditions

This report measures the whole product — candidate app in a real browser, server, identity engine v2 and the
webcam-v2.0 vision calibration — on **webcam-realistic video** instead of the sharp studio photos the earlier
end-to-end suite used. It reproduces the two failures the product owner saw with a real laptop webcam and says,
per scenario and condition, how often the system now does what it should, how long it takes, and where it still
falls short.

> **What these numbers are.** Simulated laptop-webcam video of public photos, fed to Chromium's fake camera, on a
> shared 4-CPU machine. They show how the complete system behaves under realistic image quality and timing, and they
> are repeatable (`pnpm --filter @sp/e2e exec playwright test tests/2[0-4]-realistic-*`). They are **not**
> production error rates: few identities, one source photo per person and day, synthetic head turns, and a few runs
> per case (§5).

## 1. The owner's two failures, reproduced and re-measured

__OWNER_SUMMARY__

## 2. How it was measured

**System under test.** The real product end to end: the built candidate and staff apps in Chromium, the server
started from source (`NODE_ENV=production`) with a fresh Postgres database, the server's YuNet / SFace identity
pipeline (calibration `webcam-v2.0`, embedding model id 2) and the in-browser MediaPipe monitoring and liveness
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
<!-- rw:tables:end -->

## 4. What changed during this work, and what is still open

__CHANGES_AND_GAPS__

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
