# Handover — state of the product

This document is the "what exists, what was verified, what is left" summary for the owner.

## 1. What was built

A complete, self-hostable proctoring product (monorepo, TypeScript end to end):

| Area | Where | Highlights |
|---|---|---|
| Candidate app | `apps/web/src/candidate` | Consent + privacy notice → camera readiness checklist → live-person challenge (randomised head turns) → protected identity reference → exam (5 question types, autosave, countdown) → pause / resume (even after closing the browser, days later, other room/camera) → reconnect / re-verify / hold / submit screens. In-browser monitoring (MediaPipe face mesh + object detector), offline-safe IndexedDB outbox, heartbeat, "reporting interrupted" banner, WCAG 2.1 AA work. |
| Monitoring engine | `packages/detection` | Pure-TS, debounced detectors: absence, multiple people, look-away (sustained / repeated / same-direction), unusual movement, obstruction, phone & other objects, covered lens, frozen feed, lighting, replay/virtual camera, camera disconnect/permission, browser signals (tab, focus, fullscreen, clipboard, extra display). One event per ongoing issue, relative to the candidate's own baseline. |
| Identity (server) | `apps/server/src/vision`, `apps/server/src/services/identity-*.ts` | Identity v2 (see §3a): YuNet + SFace (ONNX) with a webcam-calibrated quality gate (good / fair / poor buckets, low-light detection pass, flip test-time augmentation), an enrolment gallery of 5–8 frames with the candidate's own baseline, calibrated likelihood ratios per quality bucket and reference quality, and a sequential test (consistent → suspect → confirmed) over bursts of 3 frames. Samples right after the exam starts or resumes and whenever the face track breaks. Poor light alone never confirms a swap. Checks extend and pool frames when frames fail only on quality. Server-verified liveness (landmark parallax, symmetric pose). Optional external second opinion (AWS Rekognition, off by default). |
| Server | `apps/server` | Fastify + Postgres. Session state machine (clock stop/continue per rules, pause reason/approval/limits, periods incl. unobserved, holds, reconnect & instance takeover, expiry), idempotent event ingestion with original timestamps, encrypted evidence store, retention + legal hold, audit log, realtime WebSocket, reports, identity comparison, detection-quality metrics, abandoned-session cleanup, key rotation (`rekey`), rate limits (Redis-shared when configured). |
| Staff app | `apps/web/src/admin` | Live dashboard (active / paused / on hold / disconnected / completed, live flags, pause approvals), session timeline with observed/unobserved periods, event drawer with screenshots, review / dismiss / notes, side-by-side swap comparison with surrounding timeline, printable final report, CSV export, exams + policy editor, candidates + ID photos, invite links, time extension, holds/releases/terminate, settings, users & roles, audit log, quality page, integrations, **camera & identity self-test** (`/admin/tools/camera-test`: run the real check and live identity evidence on your own webcam). |
| Integrations | `/api/v1`, webhooks, SMTP | API keys, integration API (candidates, assignments, sessions, reports, events), signed webhook outbox with retries, email alerts with throttling. See `INTEGRATION_API.md`. |
| Ops | `Dockerfile`, `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml` | Single container serving API + SPA; Postgres; optional Redis. |

Requirement-by-requirement mapping: the requirements audit (90 atomic requirements) is summarised in §3.

## 2. How to run

* Dev: `pnpm install && createdb proctor && pnpm --filter @sp/server seed && pnpm dev` → http://localhost:5173/admin (`admin@example.com` / `ChangeMe123!`, dev only). Candidate links are printed by the seed.
* Production: `docker compose up -d --build` behind TLS — see `OPERATIONS.md` (secrets, TRUST_PROXY, backups, key rotation, sizing).

## 3. Verification performed

* **Unit + integration tests**: `pnpm test` — 1,042 tests across shared (9), detection engine (144), server (579, real Postgres, real ONNX models where relevant; 5 Redis-only tests skip without Redis) and web (310). All green at handover (final run 2026-09-25, after the code-review fixes and the Balanced profile); `pnpm typecheck` clean.
* **End-to-end**: `pnpm test:e2e` — real Chromium with a fake camera (Y4M videos generated from still photos + a synthetic head-turn video, plus webcam-realistic 720p/480p videos rendered by the webcam simulator), real server, real models: 65 tests (33 core + 32 webcam-realistic identity scenarios, `accuracy/end-to-end.md`), all passing, covering all core scenarios — happy path with pause/close/resume, pause rules, liveness (still photo fails, turning head passes, tampered client rejected), person swap mid-exam (held ~12 s after the second person appears, compared, released/terminated), different person on resume (held with before/after evidence), dim room (unable to verify → guidance → pass), multiple people, absence + face-return check, covered lens, browser events, 40 s offline (both sides see the interruption; events delivered late exactly once), reload/second browser, staff UI, time extension/expiry, degraded models, environment change as context only, accessibility walkthroughs, the resume confirmation screen, answers typed right after an approved pause, approved ID-photo comparison (advisory/required), retention purge + legal hold, key rotation with `rekey`, webhooks (signature, retries), email alerts (throttled digests) and the `/api/v1` integration flow.
* **Requirements audits (two rounds)**: independent read-throughs of the spec against the code with empirical verification against a running server using the real models; every P0/P1/P2 finding of both rounds fixed with regression tests (incl. a stale re-enrolment authorisation, an offline-queue blockage, answers typed in the seconds after an approved pause, false fullscreen/outage flags on the resume confirmation screen, and reports treating an unreturned browser as observed).
* **Code review of the identity rework (round 2)** — an independent read of every identity change found 13 issues;
  all were fixed with regression tests (`apps/server/test/identity-review.test.ts` and others). Main ones:
  - a long session could use up its evidence-storage budget and then block resume checks;
  - a very low ID-photo score on dim check-in frames raised nothing in advisory mode;
  - candidates could see the live identity trend, and abandoning a check cost nothing;
  - a page reload left the comparison lenient for the rest of the exam; it now re-baselines per period;
  - a provider "same person" could override a confirmed swap;
  - pooling across retries was too permissive;
  - undecided burst templates outlived the privacy promise;
  - one dark frame failed liveness;
  - late samples counted as current;
  - nothing noticed when samples stopped arriving; there is now a watchdog.
* **Security review** (+ follow-ups): IDOR/role checks on every route, CSRF, rate limits, decompression bombs, crypto, headers, SSRF, token leakage, dependency audit (`pnpm audit --prod`: clean). See `SECURITY.md`.
* **Load test** (`e2e/scripts/load-test.ts`, now following the identity-v2 client cadence; `CADENCE=v1` for the old
  one) and profiling — on a 4-vCPU VM (Postgres and the load generator on the same box), re-measured with
  identity v2 on 2026-09-25 (`PERFORMANCE.md` §7):
  - **Limit:** face analysis, ≈ 35 frames/s per 4-vCPU instance (≈ 29 with real client face crops).
  - **Demand per candidate:** a v2 frame costs 1.9× a v1 frame (flip TTA + mirrored detection). A candidate
    sends 0.5 frames/s in the first 3 minutes after the exam starts or resumes and 0.2 frames/s after that
    (v1: 0.033 frames/s).
  - **Start-up (all candidates in the window):** 54 candidates: identity sample p95 132 ms. 91 or more: saturated
    (p95 2.4 s at 91, 13.8 s at 182).
  - **Steady state:** 136 candidates: p95 181 ms. 182: p95 0.9 s at 100 % analysis load.
  - **N=500:** check-ins took minutes (check-frame p95 22 s) and 47 % of identity frames were refused after retries.
  - **Request path:** stays fast throughout; heartbeat p95 ≤ 28 ms at N=500.
  - **Sizing:** ≈ 11 candidates per vCPU when everyone starts together, as in a scheduled exam (≈ 45 per 4-vCPU
    instance). ≈ 27 per vCPU in steady state. The identity-v1 figure was ≈ 250 per vCPU.
  - **Scale:** by vision workers or instances, with Redis. Details, per-frame profile and the v1 before/after work
    are in `PERFORMANCE.md`.
* **Accuracy**: identity harness and behavioural-detector harness with committed baselines — see `accuracy/`.

## 3a. Round 2 — identity rebuilt after real-webcam testing

**What the owner saw.** On a real MacBook webcam a returning student needed several attempts to resume, and a person
who switched places right after the exam started was not detected.

**Root causes (measured, not guessed).** The v1 quality gate had been tuned on sharp studio photos. On laptop-webcam
frames in a dim or backlit room it rejected almost every frame as *unable to verify*: 0 of 34 simulated identities
could even enrol in dim or backlit light. So checks looped on "try again", and a swap produced no usable evidence at
all. Where frames did pass, v1 compared single frames with the best reference frame and needed two consecutive
samples below a fixed threshold. It sampled only every 30 s, and never specifically at exam start.

**What changed.**

| Area | Change | Where |
|---|---|---|
| Capture | 1280×720 camera, native-resolution face crops (no downscaling of the face), bursts of 3 frames per sample | `apps/web/src/candidate/monitoring/{camera,frames,sampler}.ts` |
| When samples are taken | Immediately at exam start and after every resume / reconnect, then every 6 s for 3 min, then every 15 s (per-exam *Balanced* intensity: 2-frame routine samples every 12 s, then every 30 s). Immediately when the face track breaks (face missing 0.25–3 s, box jump, brief second face) or the face's appearance changes abruptly. Faster when the server's evidence is inconclusive | `runtime.ts`, `packages/detection/src/engine/detectors/continuity.ts`, server `identitySample` requests |
| Quality gate | Refuses only where recognition breaks down; good / fair / poor buckets; low-light second detection pass; confident low-contrast faces usable in backlight | `vision/quality.ts`, `engine.ts` |
| Recognition | Flip test-time augmentation for good/fair frames, denoised crop for poor frames; template-vs-gallery scoring | `vision/embed-prep.ts`, `identity.ts` |
| Decision | Calibrated likelihood ratios per quality bucket and per reference quality (a dim-enrolled reference is judged against the candidate's own level in that room); per-session normalisation; sequential test with *suspect* (faster sampling, visible to staff) and *confirmed* (hold) levels; poor light capped below confirm | `vision/calibration.ts`, `services/identity-evidence.ts` |
| Checks (check-in, resume, reconnect) | Adaptive: the server says how many frames it still needs; extends up to 24 frames while usable frames agree; pools usable frames across retries of the same check; quality-only failures cost half an attempt; lighting guidance | `services/checks.ts`, `apps/web/src/candidate/check/` |
| Liveness | The phone-photo defence is unchanged (landmark parallax on the server). Peak capture with in-place re-prompts. Noise-adaptive pose smoothing in dim light, where browser pose jitters ±8°. Mirror-averaged landmarks so left and right turns measure the same | `vision/liveness.ts`, `engine.ts`, `check/poseFilter.ts` |
| Staff | Poor-light suspects and second-opinion disagreements are shown on the identity tab and timeline. A check that runs out of attempts now says why: images too poor to compare (not evidence of anything), or clear images that never matched convincingly (compare them; this is how a look-alike at resume shows up). Camera & identity self-test page | `apps/web/src/admin`, `services/checks.ts` |
| Optional second opinion | AWS Rekognition CompareFaces at check-in / resume / suspected swap. Never flips a clear internal decision; disagreements go to a human. Consent-gated, fail-open, off by default | `apps/server/src/verifiers`, `docs/EXTERNAL_VERIFIER.md` |

**Measured (simulator, `docs/accuracy/identity-v2.md`).** 140 public photos of 43 people, including 3 families,
rendered as laptop-webcam frames:

| | v1 | v2.1 |
|---|--:|--:|
| Enrolment possible: good / typical / dim / backlit | 82 / 71 / 0 / 0 % | 100 / 100 / 47 / 62 % |
| Genuine resume passes first attempt: good / typical / side-lit | 88 / 70 / 76 % | 98 / 97 / 94 % |
| … dim / backlit | 1 / 2 % | 42 / 46 % at v2.0. The v2.1 backlit gate raises backlit to 71 % (6-frame check, identity-v2 §8.1). The rest get lighting guidance and a retry, never *mismatch* |
| False swap alarms, same session | 0 | 0 (754 simulated sessions) |
| Swap confirmed within 3 samples (≤ 18 s): good / typical / side-lit | 86 / 70 / 76 % | 96 / 94 / 93 % |
| Family-member swaps confirmed within 3 samples | 60 / 36 / 48 % | 92 / 87 / 93 % |
| Look-alike swap in the candidate's own dim room, *suspect* within 3 samples | 0 % | 86 % (confirmation waits for a clear frame) |

**Measured end to end (real Chromium, real server, webcam-realistic video; `docs/accuracy/end-to-end.md`).**

Final run: commit 98b49a4, calibration webcam-v2.1, 3 runs per case (96 runs), on a quiet 4-CPU machine.
**Every target was met.** The full e2e suite then passed 65/65.

| What the owner saw / what matters | Result now |
|---|---|
| Returning student resumes on the **first attempt** | 3/3 in every condition: same room, typical light (median 6.9 s); dim (24 s); window behind (24 s); side lamp (7 s); 640×480 dim (24 s); another day (6.4 s); another day + other room + USB camera (6.5 s); active liveness (24 s) |
| … with active liveness in dim light / another room | 2/3 first attempt, 1/3 second attempt (max 110 s) |
| … another day **and** poor light | Weak: 1/9 pass. The rest get lighting guidance and retry; never called a different person |
| **Swap 5 s after exam start** (stand up / sit down, cross-dissolve with the face never leaving view, slide; 720p and 480p) | **Held 12/12**, median 5.0 s after the new person is in view (max 11.1 s) |
| Family member (father replaces son) | Held 6/6 mid-exam (≈ 5 s); 3/3 at resume |
| Look-alike swap in a dim room at 640×480 | Visible to staff 3/3, 1.4–1.5 s after the swap (non-matching checks, *suspect*, uncertain event); never auto-held, by design |
| Look-alike at resume | Never passes (12/12); held for review after the attempts |
| Genuine 5-minute sessions with light changes, sway, glances (6) | 213/213 samples matched; **0 false alarms**, 0 *could not verify* |
| Liveness | Turning head 9/9 (7 first attempt); still photo never passes (6/6) |
| Staff camera-test page | A different person confirmed 2.5–3 s after sitting down |

Bugs the realistic run found, all fixed:
- the head-turn check stalled in dim light because browser pose jitters ±8°; fixed with pose smoothing;
- backlit resumes burned all attempts; fixed with the gate change, frame pooling and half-weight retries;
- a dim-room look-alike was labelled a match; fixed with the v2.1 reference-conditioned evidence;
- the face detector's yaw read one side larger than the other; fixed with the symmetric pose.

These are simulated webcam videos of 5 public identities with synthetic head turns, not production rates. See
`accuracy/end-to-end.md` §4–5 for the remaining gaps.

**Recogniser research** (`docs/accuracy/recognizer.md`, `tools/recognizer/`). SFace was fine-tuned for dim and
backlit webcams with label-free self-distillation on public-domain portraits, keeping the same architecture and
speed. Two ways of using it were evaluated against the shipped v2.1 pipeline on held-out identities:

* **Replacing SFace.** Poor-light verification error halved (EER 7.3 → 3.7 %). But look-alike family members passed
  checks more often (1.1 → 2.6 %), and clean ID-photo comparison got slightly worse.
* **Using it only for poor-light frames (hybrid).**
  - Poor-light EER 5.7 → 3.1 %.
  - First-attempt resume passes rose in dim (28 → 36 %) and backlit (36 → 46 %) light.
  - Family results and ID photos were unchanged.
  - But in dim light, with the reference enrolled in the same room, impostor false-match estimates leaned worse. With
    only 16 dim-enrolled test identities that could be neither confirmed nor ruled out.

A higher chance of accepting an impostor outweighs a usability gain, so **production keeps SFace** for now. The
tooling is in the repository. With consented real webcam captures (§4, item 1), the hybrid can be re-validated and
shipped.

## 4. Known limitations / before launch

1. **Accuracy on your population.** The v2 calibration was fitted on public photos rendered through a laptop-webcam
   simulator, and validated end to end on webcam-realistic video. It was **not** fitted on real candidates. Before
   relying on it, run a pilot:
   - Staff can use `/admin/tools/camera-test` on their own machines.
   - Run the protocol in `accuracy/README.md` on consented, demographically diverse webcam captures: at least 100
     people, each in good, dim and backlit light, on two different days.
   - Re-fit with `eval:identity -- --webcam --dataset <dir>`.
   The same data would let the recogniser fine-tuning in `tools/recognizer` be validated and shipped.
1b. **Dim and backlit rooms stay the weak spot.** Most genuine candidates now pass first time. A minority are asked
   to improve their light and retry, and after the configured attempts they are routed to a human (never labelled a
   different person). A swap in poor light is shown to staff as *suspect* / uncertain, but it is **confirmed** only
   once a clear frame is available. That is deliberate: poor light alone must never put an honest candidate on hold.
   Recommend candidates face a window or a lamp; the app tells them so.
1c. **Look-alike relatives.** Family members are the hardest impostors. v2 confirms most such swaps within 3 samples,
   but it is not perfect (about 1–3 % of family-member checks pass in the simulator). For high-stakes exams, enable the
   external second opinion or require an approved ID photo.
1d. **Capacity — size for about 11 candidates per vCPU, not 250.** Re-measured with identity v2 on a 4-vCPU
   instance (`PERFORMANCE.md` §6–§7).
   - **Why:** each face frame costs 1.9× (75.7 vs 39.8 ms: flip TTA +24 ms, mirrored detection +9–14 ms). Each
     candidate sends 15× more frames in the first 3 minutes after starting or resuming (a 3-frame burst every 6 s)
     and 6× more afterwards (every 15 s).
   - **Capacity:** one instance analyses ≈ 35 frames/s (≈ 29 with real client crops). That saturates at
     ≈ 70 candidates in the start-up window and ≈ 175 in steady state. Scheduled exams start everyone together, so
     the start-up window is the peak: plan ≈ 45 candidates per 4-vCPU instance, or stagger starts (§6).
   - **Beyond capacity:** identity bursts wait seconds, then frames are refused (503) and check-ins slow to
     minutes. Heartbeats, answers and events stay fast.
   - **Levers:**
     - accuracy-neutral: flip the packed detector tensor for the mirrored pass (−2…−6 % per frame);
       `VISION_THREADS=4` on a dedicated host (+23 % in isolation);
     - **per exam, the *Balanced* sampling intensity** (Exams → Policy → "Sampling intensity"): 2-frame routine
       samples every 12 s for 3 min, then every 30 s; trigger samples keep 3 frames.
       - Capacity, measured (`PERFORMANCE.md` §7.7): plan ≈ 80 candidates per 4-vCPU instance at a synchronised
         start (≈ 20 per vCPU, vs 45) and ≈ 280 in steady state (vs 110).
       - Accuracy, e2e (`accuracy/end-to-end.md`): swaps are held as fast (12/12, median 4.9 s, max 10.9 s, vs
         5.0 / 11.1 s); family members 6/6; no false alarm.
       - Accuracy, simulator (`accuracy/identity-v2.md` §6.4): a swap with no trigger is confirmed ≈ 8 s later
         at the median; other-day false alarms rise from 1.4 to 2.5 per 1,000 h.
       - The default stays *Maximum accuracy*;
     - other policy trade-offs: `burstSize`, `routineBurstSize`, `startupIntervalSec`, `periodicCheckIntervalSec`.
   - **Before sizing:** re-run `e2e/scripts/load-test.ts` on your hardware (`PROFILE=balanced` for Balanced
     exams). The review fixes (burst frames keep one image; no re-decryption of check frames) have landed. A
     re-run at N=150 showed no measurable change.
2. **Liveness scope.** The active challenge defeats photos and still images held to the camera and tampered clients that lie about head pose. It does not claim to defeat real-time deepfakes, 3-D masks or a live accomplice video feed; the virtual-camera and replay detectors reduce but do not eliminate substituted feeds.
3. **Browsers.** Automated tests run on Chromium. Firefox/Safari support MediaPipe WASM but were not tested here.
4. **Phone detection** is implemented (COCO "cell phone") but not validated with real phone footage (no licensed test media).
5. **Staff authentication**: email + password with strong hashing, per-account backoff and short sessions. No MFA/SSO yet — recommended before selling to institutions that require it.
6. **Legal**: `PRIVACY.md` and the candidate notice are written to support GDPR/BIPA-style obligations but must be reviewed by counsel for your jurisdictions; define your sub-processors and data-processing agreements.
7. **English only** (strings are centralised enough to localise).
8. Per-session answer conflict: if two devices edit the same answer, the later client sequence wins; superseded devices are blocked from writing.
9. **Docker image** — no Docker daemon was available in the build environment, so `docker build` itself was not executed. The image's runtime layout (`pnpm deploy --prod` node_modules + bundled `dist/` incl. the vision worker + migrations + models + web build) was reproduced by hand and booted with `NODE_ENV=production`: migrations, owner bootstrap, SPA/WASM/model serving, check-ins and identity samples through the worker pool all worked. Run `docker compose up --build` once in CI/staging before launch.
10. **Not exercised against real external services here**: a real SMTP provider (TLS/auth/SPF/DKIM), S3-compatible storage (retention and `rekey` were verified on local storage), webhook delivery to a public endpoint with the private-network guard on (e2e had to allow a local receiver). Multi-instance realtime and rate limits over Redis are covered by integration tests with a local Redis, not by a multi-host deployment.
11. **Staff MFA, SSO (SAML/OIDC), per-candidate accommodations beyond time extension and policy variants, and localisation** are the most likely next feature requests.

## 4b. Try it in five minutes

1. `pnpm install && createdb proctor && pnpm --filter @sp/server seed && pnpm dev`
2. Staff: open http://localhost:5173/admin → sign in `admin@example.com` / `ChangeMe123!` → Live dashboard.
3. Candidate: open one of the `/take/<token>` links printed by the seed in Chrome with a webcam (a second
   browser profile or another machine works best) → consent → camera check → turn your head left/right
   when asked → start → answer → pause → close the tab → reopen the link → resume.
4. Watch the dashboard update live; open the session to see the timeline, periods, identity checks, events
   with screenshots, and the final report. Try covering the camera, leaving the frame, a second person in
   view, or switching tabs.

## 5. Defaults decided on your behalf (all configurable)

* Identity: label thresholds match ≥ 0.45, mismatch < 0.30 (ID photo 0.42 / 0.24). Decisions use the calibrated evidence (calibration `webcam-v2.1`, prior 0.1 % different person, suspect at LLR 3, confirmed at 7, cleared at −6, window of 8 samples, poor-light evidence capped at 4). Sampling intensity *Maximum accuracy*: bursts of 3 frames at exam start and resume, every 6 s for 3 min, then every 15 s. The per-exam alternative *Balanced* (admin policy editor, "Sampling intensity") takes routine samples of 2 frames every 12 s, then every 30 s; triggered samples keep 3 frames. 5 attempts per check (quality-only failures count half).
* Policy defaults: liveness on (2 steps), pause allowed with clock stopped, mismatch ⇒ hold for review, fullscreen required, clipboard blocked, evidence retention 30 days, event metadata 365 days, abandoned sessions closed after 30 days.
* Detection durations: absence 8 s, multiple people 1 s, look-away 5 s (28° yaw / 20° down), repeated look-away 5 in 120 s, obstruction 6 s, objects 2 s, frozen 6 s, covered 4 s, lighting 10 s.
