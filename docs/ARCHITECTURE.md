# SmartProctoring — Architecture

Smart proctoring for online exams: live monitoring, identity continuity across pauses/absences/camera
changes, reviewable evidence, and an administrator dashboard. This document is the contract every
component is built against. **`packages/shared` is the source of truth for types and API shapes.**

## 1. Components

```
apps/web  (React + Vite)                     apps/server (Node 24 + Fastify 5 + Postgres)
 ├─ candidate app  /take/:token               ├─ REST API  /api/candidate/*  /api/admin/*  /api/auth/*
 │   ├─ MediaPipe FaceLandmarker (5 fps)      ├─ WebSocket /api/admin/live  (staff realtime)
 │   ├─ MediaPipe ObjectDetector (~1 fps)     ├─ vision/  YuNet (face detect) + SFace (face embedding) via onnxruntime-node
 │   ├─ @sp/detection engine (episodes)       │           in a worker-thread pool; liveness verification; quality gate
 │   ├─ browser signals (tab/focus/fs/clip)   ├─ identity engine (decisions, confirmations, holds)
 │   └─ IndexedDB outbox (offline-safe)       ├─ session state machine (clock, pauses, periods, holds)
 └─ admin app  /admin/*                       ├─ evidence store (AES-256-GCM encrypted blobs, local FS or S3)
     ├─ live dashboard (WS)                   ├─ retention job, audit log, reports
     ├─ session timeline / evidence / compare └─ eval/ offline identity accuracy harness
     └─ exams, candidates, settings, quality
packages/shared     types, zod schemas, event catalog, policy, clock math, privacy notice
packages/detection  pure-TS monitoring engine: FrameObservation stream -> episodes (+ synthetic eval harness)
apps/server/src/vision-worker   optional dedicated vision worker process: the vision/ pipeline behind an
                                authenticated HTTP API, scaled separately (VISION_DRIVER=remote, §4)
```

Why this split:
* **Behavioural detection runs in the browser** (cheap, real-time, no video upload, privacy-preserving).
* **Identity decisions run on the server** against a reference the client never sees, so a tampered
  client cannot fake "same person". The client only sends JPEG frames.
* **Continuous video is never stored.** Only event screenshots, identity probes that did not cleanly
  match, and the protected reference are stored — encrypted, access-logged, and purged by retention.

## 2. Licensing (commercial use)

All runtime dependencies are MIT / Apache-2.0 / BSD / ISC. ML models:

| Model | Where | License |
|---|---|---|
| YuNet `face_detection_yunet_2023mar.onnx` | server | MIT (OpenCV Zoo) |
| SFace `face_recognition_sface_2021dec.onnx` | server | Apache-2.0 (OpenCV Zoo) |
| MediaPipe Face Landmarker `face_landmarker.task` | browser | Apache-2.0 |
| EfficientDet-Lite0 `efficientdet_lite0.tflite` (COCO) | browser | Apache-2.0 |

No code copied from third parties. See `THIRD_PARTY_NOTICES.md`.

Single sign-on libraries (round 4, task #16; chosen after checking licence and maintenance):

| Library | Version | License | Why this one |
|---|---|---|---|
| `openid-client` (+ `oauth4webapi`, `jose`, same author) | 6.8 | MIT | OpenID Certified relying-party library, actively maintained, no native code, Node 24 supported; accepts a custom `fetch`, so every request to an identity provider goes through our SSRF guard |
| `@node-saml/node-saml` | 5.1 | MIT | the SAML core behind passport-saml (widely deployed); 5.1.0 contains the fix for CVE-2025-54419 (signature verification read the unsigned document) and reads only the signed assertion; XML signatures verified by `xml-crypto` 6.4 (MIT), XML parsed by `@xmldom/xmldom` 0.8 (MIT), `xml2js` (MIT, `sax` ISC), `xmlbuilder` (MIT), `xml-encryption` (MIT, unused: encrypted assertions are refused) |

Alternatives considered: `samlify` (MIT, very active, but a history of signature-wrapping advisories and a larger
surface), hand-written XML signature checks (never: canonicalisation and wrapping attacks are where SAML
implementations fail). `pnpm audit --prod` reported no advisory for any of these at the time of adding them. Test-only:
`jose` signs the fake provider's ID tokens and `xml-crypto` signs the test SAML assertions.

## 3. Session lifecycle

`invited → ready → active ⇄ paused → submitted`, plus `on_hold` and `terminated` (see `shared/src/session.ts`).

* **invited**: candidate opens `/take/:accessToken`, reads privacy notice, consents (recorded with version + time).
* **initial check** (`POST /api/candidate/checks` purpose=`initial`): camera readiness, one face, quality gate,
  active liveness challenge, then the server builds the **protected identity reference** (multiple
  frontal embeddings, encrypted). Optional comparison with approved ID photo. → **ready**.
* **start** → **active**, clock starts, `active` period opens. Admission: while the instance is at capacity
  (`services/capacity.ts`) the start is deferred (503 `start_deferred` + Retry-After; the session stays `ready`,
  `startDeferredSince` records the first deferral, the client retries) for at most `EXAM_START_MAX_DEFER_SEC`; the
  `session_started` event notes the delay (`details.startDeferredMs`). **Single display** (`policy.browser.requireSingleDisplay`,
  off by default): the start is refused (409 `single_display_required`) while the browser reports more than one display
  — `screen.isExtended` as sent with the start (`startExamRequestSchema`), else as this browser's last check recorded it
  (`device_records.screen`). A browser that cannot tell (Firefox, Safari) is not held back; `session_started.details.displays`
  records `single` / `unknown`, and `unknown` adds a report limitation.
* **pause**: per policy (reason? approval?). Monitoring stops, `paused` period (unobserved) opens; clock
  stops or continues per `policy.pause.timerBehavior`. Candidate may close the browser.
* **resume**: candidate reopens link → `requiredCheck='resume'` → same readiness + liveness + identity
  comparison **against the original reference**. `match` → active; `unable_to_verify` → guidance +
  retry (up to `maxVerificationAttempts`, then `on_hold` for human review); `mismatch` → `on_hold`
  (or flag only, per policy) with before/after evidence.
* **reconnect**: any new browser instance (reload, crash, other device) during `active` must pass a
  `reconnect` check before questions are served. Server tracks `verifiedInstanceId`; data from
  un-verified instances is rejected. A second instance supersedes the first (`multiple_instances` event).
* **on_hold**: clock stopped. Staff release (optionally requiring a fresh check, optionally authorising
  re-enrolment of the reference) or terminate.
* **additional display** (single-display rule): the browser's `additional_display_detected` event (a `change` of
  `screen.isExtended` to true, also reported when monitoring starts with two displays) received while the exam is
  `active` → `on_hold` with reason `additional_display` (`ingest.ts`, after the batch is stored). Without the rule the
  event stays a neutral observation. A display still connected when monitoring restarts after the release holds the
  exam again.
* **expiry**: server sweeper auto-submits when the clock hits zero.
* **scheduling window** (optional): the exam can be *started* only inside the session's window; the check-in may begin
  30 minutes earlier. Only the start is bounded — an exam in progress is never cut off when the window closes.
* **resume policy** (`policy.resume`): too many reconnections or too long disconnected during the exam → `on_hold`
  (reason `resume_limit`) or ended (`resume_limit`, submitted), per the exam's rules.
* **reopen for recovery**: staff put an ended exam back (`on_hold`, reason `recovery`, `holdCanReverify`) so the
  candidate continues after a fresh identity check.

**Periods** partition the timeline: `check_in`, `active`, `resume_check` (observed) and `paused`,
`disconnected`, `on_hold` (unobserved). Unobserved periods produce an `unobserved_period` marker and
**no behavioural events are accepted for timestamps inside a paused/held period** (server drops them).

**Clock** (`ExamClock`): `{durationMs, usedMs, runningSince}`; arithmetic in `shared/session.ts`.
Runs only in `active` (and during `paused` if `timerBehavior='continue'`, and during an unannounced
disconnect if `disconnectTimerBehavior='continue'`).

### Exam versions (`services/exam-versions.ts`, `services/regrade.ts`)

The `questions` table is the working copy staff edit. Publishing an exam, and every later edit of a published exam that
changes its content, writes an immutable row in `exam_versions` (title, instructions, duration, the exam's own rules,
and the questions with options, answer keys and points; a sha256 of the canonical snapshot; a per-question diff against
the previous version), under the exam row lock so numbers never collide. **start** pins the session to the exam's
current version (`exam_sessions.exam_version_id`; lock-free for published exams, so a synchronised start does not queue
on the exam row — a draft started directly is versioned first). From then on the questions served, the answers
accepted, grading and the report all read the pinned snapshot (`sessionExamContent`; versions are cached in memory by
id, they never change). Edits therefore never reach an attempt that already started, and content can be edited
freely; a question whose type changes gets a new id so answers never mix kinds of question. A corrected answer key
reaches finished attempts only through an explicit, audited **regrade** (`POST /api/admin/exams/:id/regrade`: preview,
then apply; only attempts whose result changes are written, each with a neutral `score_regraded` timeline event, the
score history in `score.regrades`, an audit entry and the `session.regraded` webhook). Exams export to / import from a
portable JSON document (`smartproctoring.exam`, format version 1; an import is a new draft). Migration 0007 gave every
published, archived or started exam version 1 (`reason: migrated`) and pinned started attempts to it
(`test/migrations.test.ts` checks the upgrade on old data).

### Accommodations (`packages/shared/src/accommodations.ts`, `services/accommodations.ts`)

Approved per-candidate exceptions to exam rules, granted and revoked (never edited) by administrators, each
audit-logged without its encrypted note. Every kind only *relaxes* rules and is expressed as overrides of resolved
policy fields (`applyAccommodations`), so the server, the candidate client and the reports read one consistent
policy: extra time (added to `duration_ms`), rest breaks (never stricter than the exam), no head-turn challenge,
assistive technology (no fullscreen / blur recording / clipboard block / single-display rule), behaviour detectors off, a support person
(other people in view not observed), **identity verified by staff** and **no camera**. Those two are policy modes
(`identity.verification: 'staff'`, `camera.enabled: false`) whose invariants the policy schema enforces (staff mode:
no live-person or ID-photo check; no camera: every camera detector and screenshot off, staff verification forced).

A session carries a snapshot (`exam_sessions.accommodations`) that follows the records until the exam starts
(refreshed after each grant / revocation, at assignment and again at start) and is then frozen with the policy
snapshot, together with the exact list of exam rules it changed (`exceptions`). Start records a neutral
`accommodations_applied` event; the session page, the report (section + attributed limitations — the exam's own
rules are reconstructed by reverting the exceptions) and the integration API show what applies, never why.

Staff mode: checks are `attest` checks (`checks.mode`; no frames, no face processing — frames are refused). The
check-in ends on a `staff_verification` hold; releasing it requires the staff member to record how they verified
the candidate (`identity_verified_by_staff` event + audit). No face reference exists, so identity samples are never
requested or accepted, and the no-samples watchdog is off. After a pause or reconnection the exam continues, behind
another verification hold when `identity.staffReverifyOnContinue`. Without a camera the candidate client skips the
camera step and never opens a camera; its monitoring runtime observes the browser rules only.

### Scheduling windows, resume policy and recovery (`packages/shared/src/scheduling.ts`, `services/scheduling.ts`, `services/recovery.ts`)

* **Windows.** `exam_sessions.window_starts_at` / `window_ends_at` (either may be null = open-ended). Set on assignment
  (staff `POST /exams/:id/assignments {window}`, integration `POST /api/v1/exams/:id/assignments {window}`; a
  candidate's existing unfinished session keeps its own) and changed until the exam starts (`POST
  /sessions/:id/reschedule`, `PUT /api/v1/sessions/:id/window`; 409 `already_started`): audited, a neutral
  `session_rescheduled` event (→ `session.rescheduled` webhook, without the staff note). `windowPhase(window, now)`:
  `before_check_in` (more than `CHECK_IN_LEAD_MS` = 30 min before the opening) → `check_in` → `open` → `closed`. The
  initial check is refused in `before_check_in` and `closed`, the start (`candidate-actions.ts startSession`) outside
  `open`: 409 `exam_window_not_open` / `exam_window_closed` with `details.window` (a start deferred by the busy-server
  admission counts from its first request). Consent and reconnect checks before the start are not restricted, and
  nothing after the start looks at the window: **an exam in progress is never cut off**, it runs until its clock runs
  out. `CandidateSessionState.session.window` lets the candidate app show "This exam opens on … / is closed" in the
  candidate's own time zone instead of the check-in, and keep Start disabled until the opening after an early check-in
  (it re-renders at the window boundaries and reloads every minute in case staff reschedule). Abandonment counts
  inactivity from the end of the window at the earliest (`abandonment.ts lastActivityAt`).
* **Resume policy** (`policy.resume`, defaults = no limits): `maxReconnects` counts reconnect checks *passed during the
  exam* (`exam_sessions.reconnect_count`; a reload before the start does not count); when the count has reached the
  limit the next reconnect check is not started — `enforceReconnectLimits` applies the limit and `startCheck` answers
  409 `resume_limit_reached` (the candidate app reloads its state and shows the hold / ended screen).
  `maxOfflineMinutes`: no heartbeat from any browser for longer than this, counted from the last heartbeat or from
  when the exam last continued (the open active period's start), whichever is later; applied by the sweeper
  (`enforceOfflineLimits`, after clock expiry; the pre-filter reads the start-time policy snapshot, older snapshots
  have no limit) and again when the candidate comes back (`enforceReconnectLimits`). Only `active` exams: a formal
  pause has its own limit, a held exam waits for staff. `onLimit` `hold` (default): `holdNow` reason `resume_limit`
  (releasing it resets the reconnect count); `end`: `finalizeSession(m, 'resume_limit')` — status `submitted`, graded
  like a time expiry, the candidate is told why (`CandidateEndReason`), webhook `session.submitted` with `reason`
  `too_many_reconnects` / `offline_too_long`.
* **Reopen for recovery** (`POST /sessions/:id/reopen {reason, addMinutes}`, admin). `reopenEligibility` (shared; the
  session page shows it as `SessionDetailDTO.reopen`): only an ended exam whose end reason is in
  `REOPENABLE_END_REASONS` (`time_expired`, `staff_submitted`, `staff_terminated`, `abandoned`, `resume_limit` — never
  the candidate's own submission nor a consent withdrawal), whose evidence was not purged by retention, whose review is
  not resolved (reopen the review first) and — if it started with automatic identity — that still has its identity
  reference; and (`no_time_left`) the remaining time plus the added minutes must be at least a minute. A started exam
  becomes `on_hold` with `holdReason 'recovery'`, `holdCanReverify` and `holdPrevStatus 'active'`: the candidate passes
  the **reverify** check (readiness, live-person, identity against the ORIGINAL reference — a reconnect check would be
  tied to replacing a browser window and count against `maxReconnects`), then `continueAfterPass` resumes the exam
  with its answers and remaining time. The interval from the old end to the check is an `on_hold` period (reason
  `recovery`, unobserved). `endReason`, `endedAt` and `score` are cleared (the event keeps the previous score; grading
  runs again at the next end), the reconnect count resets, retention stops applying (no end time). An exam that never
  started returns to `invited`. Recorded as a neutral `session_reopened` event (→ `session.reopened` webhook with the
  previous end reason, never the staff reason), a `session.reopened` audit entry and a report observation. Like a hold
  released with a required check, the recovery hold counts towards the held-exam review target (`reviewSla`) until
  the candidate passes the check.

## 4. Identity pipeline (server)

**Where it runs.** Steps 1–3 (decode, detection, quality, alignment, embedding: `vision/engine.ts`) are the
expensive part — ≈ 85 ms of CPU per frame, the limit of a deployment (PERFORMANCE §6). Everything else (references,
scores, evidence, decisions, storage) runs in the API server. Two drivers implement the same `VisionService`
(`vision/types.ts`: `analyze`, `processIdPhoto`, and `load`, the queue snapshot that readiness, capacity, admission at
exam start, load-aware sampling and `/metrics` read):

```
VISION_DRIVER=local (default; dev, tests, single host)       VISION_DRIVER=remote (scale face analysis on its own)
 API server                                                    API server(s)                     vision workers (N)
  └─ vision/service.ts                                          └─ vision/remote.ts   HTTP+token   ├─ src/vision-worker
      └─ pool.ts: worker threads, 2 priority queues    ===>        least expected wait ─────────► │   (Fastify, no DB,
          (interactive before background, 503 +                    load polls, circuit breaker     │    no keys)
           Retry-After when full)                                  bounded retry, aggregated load  └─ the same pool.ts
```

* **Local** (`vision/service.ts`, `pool.ts`): a worker-thread pool in the server process (`VISION_THREADS`), two FIFO
  queues (interactive = check frames, exam-start and requested samples, ID photos; background = routine samples;
  overdue background work alternates), a per-priority queue limit (256) and `VisionBusyError` → HTTP 503 `vision_busy`
  with `Retry-After` = the estimated time the work ahead needs.
* **Remote** (`vision/remote.ts` → `src/vision-worker/server.ts`, wire format `vision/wire.ts`): the same pool runs in
  dedicated worker processes (same image, command `node dist/vision-server.js`), which hold no database connection,
  key or storage. The driver sends each JPEG (`POST /v1/analyze`, options in `X-Vision-Options`, `Authorization: Bearer
  VISION_WORKER_TOKEN`) to the worker with the least expected wait for the request's priority (its last reported
  `VisionLoad`, from a poll every second or the previous answer, plus what was sent to it since); answers are JSON
  with base64 Float32 embeddings and the face crop, plus the worker's queue wait and analysis time per image (fed to
  the same `sp_vision_*` metrics). An ID photo is one request (`/v1/id-photo`: the worker analyses the photo and its
  perturbed copies). `VISION_WORKER_URLS` lists base URLs; a DNS name stands for all its addresses (re-resolved every
  10 s: `docker compose --scale`, a Kubernetes headless Service), and two addresses of one worker process (same
  instance id) count once. The workers keep the priorities, queue limits and Retry-After (a full worker answers 503
  `vision_busy`), so behaviour under load is the local one, per worker.
  - *Failures.* A worker that refuses connections or the token, or fails 3 requests / polls in a row, is skipped
    (circuit open) until a poll succeeds (back-off 1 → 30 s). A request the worker did not take (connection failed,
    a stale keep-alive socket, 503 busy / no ready thread) is retried once on another worker; a request it took is
    never retried (no doubled load). No worker available, every worker full, or an accepted request past
    `VISION_WORKER_TIMEOUT_MS` (30 s, below the candidate app's 45 s upload timeout) ⇒ `VisionBusyError` ⇒ 503
    `vision_busy` + `Retry-After`, exactly what a saturated local pool answers: identity samples come back later,
    check frames tell the candidate the server is busy. A timed-out request closes its connection and the worker
    drops the frame if it is still queued (`AbortSignal` into `pool.ts`), so frames nobody waits for cost nothing;
    timeouts do not open the circuit (a long queue is not a dead worker; a hung worker fails its 2-s load polls).
  - *Load.* `load` sums the workers in use (threads, queues, in flight, queue limits), takes the longest oldest-wait
    and the best worker's expected wait; 0 workers when none is ready, so `/api/health/ready` (ready = at least one
    worker ready) and capacity (`vision_unavailable`) follow the fleet.
  - *Cost.* The HTTP hop adds ≈ 2–3 ms of latency and of CPU per frame on one host (PERFORMANCE §8); analysis
    results are identical bit for bit (tested with the real models).

1. Decode JPEG (sharp), letterbox to 640×640, YuNet → faces with 5 landmarks + score (NMS).
2. Quality gate on primary face → `FaceQuality` (`shared/identity.ts`): face count, detector score,
   inter-eye px ≥ 28, face brightness 40..220, contrast, Laplacian sharpness, yaw/pitch proxy from
   landmarks (|yaw| ≤ 25°), cut-off. Failing ⇒ `unable_to_verify` + guidance strings.
3. Similarity-transform align to 112×112 (ArcFace 5-point template) → SFace → L2-normalised 128-d.
4. **Reference and score (identity v2).** Enrolment (initial check, staff-authorised re-enrolment) keeps a
   gallery of up to 8 diverse, mutually consistent embeddings from the check's frontal frames plus its near-frontal
   liveness frames (|Δyaw| ≤ 20° from the candidate's own frontal pose), and a per-session **baseline** (mean / sd
   of the leave-one-out scores of those frames, and the gallery quality bucket). A probe (one frame, or the mean of a burst) is scored with
   `scoreAgainst` = cosine to the gallery template (vision/identity.ts). Per-sample labels still use the org
   thresholds (`≥0.45 match`, `<0.28 mismatch`, else `inconclusive`; ID photo `≥0.42` / `<0.24`), but escalation
   uses calibrated evidence: `sampleLLR(score, qualityBucket)` (vision/calibration.ts), after a per-session
   normalisation of the score against the baseline (services/identity-evidence.ts) — a drop from the person's own
   level counts even above the global mismatch threshold. The drift is the vision module's measured `GENUINE_DRIFT`:
   'continuous' (same session) against the enrolment baseline until the first resume / reconnect / reverify;
   'relaxed' (another day, room or camera) at those checks. A passed check starts a new period with **its own
   baseline** (`periodBaseline`: the check's usable frames scored against the reference, the reference's bucket):
   the period's samples are normalised 'continuous' against it again; with fewer than 3 usable check frames, a level
   below the band the continuous model is calibrated for, or after a flagged mismatch, 'relaxed' against the
   enrolment baseline (continuous normalisation against the ENROLMENT baseline across days caused 9–27 false alarms
   per 1,000 h). A reconnect while the exam has not started (e.g. a page reload before Start) changes nothing.
   Poor frames are never labelled mismatch; at checks their positive evidence is capped too (a dim-room check ends
   uncertain with lighting guidance, never "likely different person"). Unusable frames carry no evidence.
5. **Decisions.** *Checks* (resume / reconnect / reverify) are adaptive: every frame returns
   `CheckFrameResponse.progress` (frames wanted, liveness step status, canComplete — never the running identity
   assessment, which only decides how many frames to ask for); the
   decision sums the (correlation-discounted) LLRs of all identity frames: likely same ⇒ pass, likely different ⇒
   `identity_mismatch` + hold / flag (also with some fair / poor frames), otherwise retry with guidance;
   `unable_to_verify` only when no usable frame came after the adaptive collection. Image quality is not identity:
   while frames are being rejected for quality (backlight, a dim room) but the usable ones agree with the reference,
   the attempt is extended (10 → up to 24 frontal frames); usable frames of earlier failed attempts of the same check
   (same reference, ≤ 5 min) that passed liveness (or failed purely on image quality) are pooled when the current
   attempt has ≥ 3 usable frames of its own with clear evidence of the same person and none pointing elsewhere (at
   most as many pooled frames as its own); and a retry caused only by image quality counts half against
   `maxVerificationAttempts` (lighting guidance, more tries, then human review). A check that ends without /complete
   (expired, or superseded by a new check) is judged on the frames it received: trending "different person" ⇒ a full
   failed attempt with its identity check row (`context.abandoned`), held for review when no attempts remain;
   otherwise no penalty. Frame caps and the storage budget are enforced with the check row locked; identity samples
   may use at most 90 % of a session's evidence budget, so check frames always find room, and a check that passes with
   nothing to review keeps none of its frame images (the reference images and a probe shown to staff are separate
   copies). The candidate's check result carries the outcome, guidance and live-person steps — never the identity
   decision, similarity or confidence (reference or ID photo). *During the exam*, samples are
   bursts (1–5 frames within ~0.6 s, decided as ONE sample — the burst template, or the frames' median when their
   scores spread > 0.15; incomplete bursts after ~3 s on the frames received)
   feeding a per-session SPRT accumulator (`CALIBRATION.sprt`, `windowEvidence`: positive evidence from poor-light
   frames is capped below the confirm threshold): `suspect` ⇒ faster sampling (2.5 s, trigger `server_request`) —
   when only poor-light frames point away, also an uncertain `identity_unverifiable` (details.reason
   `poor_light_suspect`) and lighting guidance, and confirmation waits for a fair / good frame;
   `confirmed_mismatch` ⇒ `identity_mismatch` (integrity, high; confidence = posterior;
   details: per-sample scores / LLRs / triggers, baseline, calibration version) and hold or flag per policy; strong
   genuine evidence clears the window. A track break / face return / camera reconnect / exam start drops earlier
   genuine evidence from the window (only when the sample is newer than everything in it; a sample captured before the
   current period began, or more than 2 min before it arrived, is recorded only). 3 unusable samples in a row ⇒
   `identity_unverifiable` (uncertain) and guidance — **never** labelled as a different person. A decided burst keeps
   the images of its representative frame only. The candidate is told only whether an image was usable (and guidance
   about it), never a decision, score or evidence state. Cadence is server-driven (`nextSampleInMs`: start-up
   interval for `startupWindowSec` after a (re)start, else `periodicCheckIntervalSec`, faster while monitoring /
   suspect — 5 s / 2.5 s whatever the policy). Load-aware: while the instance's face-analysis queue is long, the
   routine interval of a 'consistent' session is spaced out in proportion, at most to the Balanced intensity's
   (`loadAwareDelayMs`); the faster intervals and client-triggered samples never are, and the watchdog waits at least
   the interval last told (`identityState.cadenceMs`). Routine (periodic) samples take `routineBurstSize` frames; every
   triggered sample (exam start / resume, track break, appearance change, face return, camera reconnect, after
   multiple people / obstruction, follow-ups and server requests) takes `burstSize` (`burstSizeFor`). The per-exam
   *sampling intensity* (`samplingProfile`, a label the admin UI fills the numbers from; the numbers are the source of
   truth) is **Maximum accuracy** (default: 3 frames every 6 s for 180 s, then every 15 s — 0.5 then 0.2 frames/s)
   or **Balanced** (2-frame routine samples every 12 s, then every 30 s — 0.17 then 0.067 frames/s; measured ≈ 2× the
   candidates per instance at a synchronised start and ≈ 2.5× in steady state, PERFORMANCE §7.7; a swap without a
   trigger is confirmed ≈ 8 s later, one at a trigger as fast, accuracy/identity-v2.md §6.4).
   `CandidateSessionState.session.identitySample` / `HeartbeatResponse.identitySample` ask for an `exam_start` burst
   right after /start and after every passed resume / reconnect / reverify check, and — watchdog — a `server_request`
   when no sample came for 3 expected intervals of the exam's policy (the client then takes the burst even without a
   qualifying frame); still none after 6 intervals (≥ 1 min) with the browser connected ⇒ `identity_unverifiable`
   (details.reason `no_samples`), closed by the next sample. Vision priority for samples comes from server state (a
   pending request or follow-up, evidence building up, samples overdue), not from the client's trigger label; routine
   samples, including those of the start-up window, queue behind check-in frames.
6. **The reference is immutable.** It is never updated from later samples. Only staff can authorise a
   re-enrolment (`release` with `reEnroll=true`), which creates a new reference version, keeps the old
   one, and is audit-logged.

Liveness (active, server-verified): server issues a random sequence (e.g. `turn_right, turn_left`,
always containing both horizontal directions, plus optional `look_up/look_down`) with a nonce and
expiry. Client guides the candidate (live MediaPipe pose) and uploads frames at each step. Server
measures yaw/pitch from YuNet landmarks per frame (nose offset relative to eye midpoint normalised by
inter-eye distance — a flat photo rotated in front of the camera does **not** produce this parallax),
requires each step's direction/magnitude relative to the frontal frames, same identity across all
frames (similarity ≥ match), non-identical frames, and completion inside the expiry window. Never more than one face
in any frame and exactly one in every head-movement frame; the frontal frames (up to 24 in poor light) are judged on
the usable ones, so one dark or empty frontal frame does not fail the challenge (with none usable, on the single-face
ones as before, so a dark room ends on image quality rather than as a failed live-person check).

ID photo (check-in): a score below the ID-photo mismatch threshold on poor-quality frames stays "inconclusive" (poor
light is not "a different person") but is flagged `needsHumanReview`: an uncertain `identity_unverifiable`
(details.reason `id_photo_low_similarity_poor_quality`, with both images) in advisory mode, and a hold
(`id_photo_unverifiable`) in required mode — never passed unseen; an external "same person" does not resolve it.

Optional external second opinion (off by default; `docs/EXTERNAL_VERIFIER.md`): at check-in, resume and suspected
swaps an organisation may also ask a provider (AWS Rekognition CompareFaces, or another `ExternalVerifier`) and
combine its answer with the internal decision (`verifiers/fusion.ts`: it can settle an inconclusive result or flag a
disagreement for review, never raise a mismatch alone; failures fall back to the internal decision). Wired in
`services/identity-external.ts`, outside the session lock: a suspected swap waits for the answer (at least the
configured provider timeout + 10 s) before `identity_mismatch` is raised. The internal strength of a mismatch made on
accumulated evidence (the SPRT, a resume check's frames) comes from that evidence, not the raw similarity: a
confirmed_mismatch is clear — a provider's "same person" flags it `needsHumanReview` but never overrules it
(EXTERNAL_VERIFIER.md §5–6).

## 5. Monitoring engine (browser, `@sp/detection`)

Input: `FrameObservation` per tick (~5 Hz faces, ~1 Hz objects, frame metrics each tick).
Output: `EpisodeUpdate`s (open/update/close with stable UUID) + `EngineSignal`s (identity sample
requests, candidate prompts) + `MonitoringStatus`.

Rules: onset requires the condition to persist (duration + fraction of frames + confidence); closing
requires it to be absent for `clearSec` (hysteresis); a new episode of the same type within
`mergeGapSec` re-opens the previous one. Thresholds are **relative to the per-period baseline**
(normal head pose / position captured at check-in and after every resume). Single bad frames never
create events. Detectors: absence, multiple people (faces + COCO person boxes), sustained look-away,
repeated look-away, same-direction attention pattern, unusual movement (repeated exits / far from
baseline), obstruction (cut off / low visibility / person without face), phone & other objects,
camera covered, frozen, lighting, replay/loop (dHash sequence repetition with motion), virtual camera
label, camera disconnect/permission.

Identity samples (browser side). The camera runs at 1280×720 (ideal; whatever the device gives); MediaPipe
analyses a ≤ 640 px copy, and identity evidence (check frames, samples) is a face-centred square crop
(~2.4× the face box, ≤ 720 px, JPEG 0.92) of the NATIVE frame (full frame without a face box); event
screenshots stay ≤ 640×480 full frames. A sample is a **burst** of `policy.identity.burstSize` distinct
analysed frames ~200 ms apart with exactly one usable face, sent concurrently as separate requests sharing
`burstId`. "Usable" is deliberately lenient (one face, not cut off, not badly obstructed, roughly frontal):
lighting and image quality are the server's call, so a dim room never silences sampling. Triggers, highest
priority first: `track_break` (the single-face track was interrupted: face missing 0.25–3 s, a brief second
face, or a face-box jump / scale change between consecutive analysed frames), `appearance_change` (a 16×16
face-aligned grey patch + landmark ratios moved away from a rolling baseline of the recent stable track for
≥ 300 ms; pose-aware threshold), `exam_start` (at every start / resume / reconnect / hold release, and
whenever the server asks via `identitySample`), `server_request` / `follow_up`, `camera_reconnect`,
`after_multiple_people`, `face_return`, `after_obstruction`, `periodic` (every `startupIntervalSec` during
`startupWindowSec`, then `periodicCheckIntervalSec`, unless the server's `nextSampleInMs` says otherwise).
The two quick-swap triggers are rate-limited to one per 4 s (a trigger inside the window is deferred, not
lost). Tuning evidence: packages/detection/src/engine/detectors/continuity.ts.

Browser support. Nothing in the candidate app is Chromium-only: the camera uses `getUserMedia` with `ideal`
constraints (an HD refusal retries in SD), the Permissions API for the camera is optional, MediaPipe loads its
self-hosted WASM (SIMD or not) with the GPU delegate and falls back to CPU (CPU first on a software renderer),
the outbox stores ArrayBuffers in IndexedDB, and fullscreen goes through `candidate/fullscreen.ts` (standard API,
WebKit-prefixed fallback for Safari 16.0–16.3; "not supported" where neither exists, e.g. iPhone). Connected displays
come from the Window Management API (`screen.isExtended` and its `change` event, `candidate/displays.ts`), which only
Chrome and Edge implement: elsewhere the display count is `unknown` and the single-display rule blocks nothing. The e2e
suite runs every scenario in Chromium and the core ones in Firefox and WebKit with a camera shim (`e2e/README.md`).

## 6. Events, evidence, delivery

* `EventUpsert` (client) is idempotent: primary key = episode UUID; server applies only if
  `version > stored version`. Category/severity/title come from `EVENT_CATALOG`, not the client.
* Evidence: `PUT /api/candidate/evidence/:uuid` (JPEG, idempotent). Stored encrypted
  (AES-256-GCM, per-blob IV, key from `EVIDENCE_KEY`), metadata in `evidence` table.
* Data residency (`lib/storage.ts` `StorageLocations` / `storageAt`, `services/evidence.ts`,
  `services/evidence-storage.ts`, `services/storage-move.ts`): the operator configures storage locations (`default` =
  `STORAGE_*`, others from `STORAGE_LOCATIONS`; `ctx.storageLocations`, `ctx.storage` = default); an owner picks one
  for new images (`settings.evidenceLocation`). `storeEvidence` writes to the organisation's location (looked up only
  when more than one is configured) and records it in `evidence.storage_location` (null = default); every read and
  delete — staff route, ID-photo copies, purges, retention, `rekey`, export — goes through `storageFor(row)`.
  `readEvidence` follows a row moved after it was read; `purgeEvidenceRows` deletes at the place `RETURNING` reports
  after the tombstone; `rekey`'s compare-and-set includes the location. Start-up refuses locations in use but not
  configured (`assertStorageLocationsConfigured`: organisation settings + a loose index scan of
  `evidence_location_idx`). `storage:move` (advisory lock 727274012) walks an organisation's rows per source location in
  id order (`evidence_org_location_idx`): copy under a derived key (`.m<hash>.bin`, so a re-run overwrites a stray copy),
  verify (decrypt with the AAD, SHA-256), compare-and-set (key, location, not purged), delete the old copy. Only blobs
  move; the database, with face templates, stays where it is.
* Offline: the client keeps an IndexedDB **outbox** (events latest-version-wins, evidence blobs,
  answers, identity samples) and flushes with backoff. Original timestamps are preserved; server sets
  `deliveredLate` when received > 30 s after the event's last change. Heartbeat every 5 s; server
  marks `offline` after `heartbeatTimeoutSec` and opens `reporting_interrupted` (closed on return). When no sweeper
  saw the silence (every instance was down or restarting), the browser's next heartbeat records the outage exactly as
  the sweeper would have (from the last heartbeat; under disconnect policy `stop` the clock stopped there; then the
  resume policy's `maxOfflineMinutes`, `recovery.ts` `applyOfflineLimit`), so a server restart shows in the timeline
  once, does not cost the candidate time, and meets the same resume rules whichever comes first
  (`session-state.ts` `recordReportingTimeout`).
  Candidate UI shows a banner while the outbox cannot be delivered; admin UI shows
  "reporting interrupted since …".
* Clock skew: client computes `offset = serverTime − midpoint(rtt)` from heartbeats and stamps
  observations with `Date.now() + offset`.
* Failures in the middle of a request (tested in `apps/server/test/chaos.test.ts`): every write of a candidate request
  is one transaction, so a request that fails — its Postgres connection lost before COMMIT, the process stopped —
  leaves nothing behind, and the client's resend applies once; when the connection is lost right after COMMIT (the
  client cannot know it was stored) the resend is recognised (events by id + version, answers by `clientSeq`,
  identity samples by `sampleId`, evidence by id). An evidence blob is written before its row: `storeEvidence` deletes
  it again when the row insert fails, and `transactionWithEvidence` (used by `withSession`, check frames, ID photos)
  when the transaction rolls back — when COMMIT itself failed, only blobs whose rows did not commit. A connection that
  breaks while checked out is reported and discarded by the pool (`db/index.ts`; without a client error listener
  node-postgres would end the process). Checks, pending identity bursts and second-opinion requests live in Postgres:
  another instance (after a restart) continues a check on the frames received, or settles it when it expired, and
  its sweeper decides bursts left incomplete. The frame images of a passed check are purged after COMMIT
  (delete blob, then tombstone the row): a crash in between leaves the row without its blob until retention purges
  the session (`readEvidence` returns null).

## 7. Staff side

Roles: `owner`, `admin` (manage exams/candidates/settings/users), `reviewer` (sessions, evidence,
notes, review). Every evidence view is written to `audit_log`. Realtime via WebSocket
`/api/admin/live` (in-process bus; Redis pub/sub when `REDIS_URL` is set for multi-instance).

Review language is observational. Reports list every active period, pause, resume, disconnection and
hold, identity-check outcomes, event counts per category, notable events, reviewer notes and the
system's limitations.

### Staff sign-in: passwords, two-step sign-in, single sign-on, SCIM (`routes/auth.ts`, `routes/sso.ts`, `routes/scim.ts`, `services/sso/*`, `services/scim.ts`)

* **Password + two-step sign-in** (`docs/SECURITY.md` §2) creates a staff session (`staff_sessions.auth_method =
  'password'`).
* **Single sign-on.** An organisation's owners configure identity providers (`identity_providers`: OIDC issuer /
  client / encrypted secret / scopes, or SAML entity ID / SSO URL / signing certificates; claim mapping; just-in-time
  accounts with a default role and group → role mappings, never owner). Each provider claims email domains
  (`sso_domains`, one provider per domain on the whole server): **the sign-in page identifies the organisation from
  the email domain** (`POST /api/auth/sso/discover`); each provider also has its own sign-in link
  (`/api/auth/sso/<id>/start`, shown in Settings). Every URL carries the provider id (per-provider redirect URI, ACS
  and SP entity ID, so responses cannot be mixed up between providers).
  * Start: an `sso_login_attempts` row (10 minutes, one use) bound to the browser by the signed, httpOnly `sp_sso`
    cookie (sha256 stored). OIDC: authorization code + PKCE (S256) + state + nonce through `openid-client`; discovery
    and JWKS cached per provider for an hour; ID-token signature (JWKS, asymmetric algorithms only), `iss`, `aud` /
    `azp`, `exp` / `iat` (60 s tolerance) and nonce validated by the library; all requests through
    `lib/net-guard.ts` `guardedFetch` (`SSO_ALLOW_PRIVATE_NETWORKS`, https in production). SAML: an AuthnRequest by
    HTTP-Redirect; the HTTP-POST ACS verifies the signature (`@node-saml/node-saml`: Response or Assertion signed by a
    configured certificate), conditions, audience, then here the issuer, a bearer subject confirmation for our ACS
    answering our request (InResponseTo; unsolicited responses refused) and the assertion ID once
    (`sso_saml_assertions`). The ACS cannot set cookies cross-site (SameSite=Lax), so it stores the validated
    identity on the attempt and redirects to `/api/auth/sso/complete`, which finishes the sign-in only with the
    browser-binding cookie (no login CSRF).
  * Account resolution (`services/sso/login.ts`): the asserted email must be in the provider's domains (OIDC: and
    `email_verified`, unless the owner turned that off); an identity already linked (`staff_sso_identities`:
    provider + subject) signs in its account; otherwise the account with that email in the provider's organisation is
    linked (refused when it is linked to another subject at that provider — a re-used address — until an administrator
    unlinks it), or a just-in-time account is created (no password). Disabled accounts never sign in; other
    organisations' accounts are never touched.
  * The session is a normal staff session with `auth_method = 'sso'` and `sso_provider_id`. The identity provider is
    responsible for the second factor: `requireMfa` applies to password sessions only. Disabling a provider, pointing
    it at another issuer / entity ID or deleting it ends its sessions (a new issuer also drops its links).
  * `settings.requireSso` (owner): password sign-in of everyone but owners is refused after the right password
    (403 `sso_required`) and their password sessions end (also refused by `authenticateStaffToken`). **Owners keep
    password + two-step sign-in as break-glass access**; the `staff-access` CLI remains the operator's last resort.
* **SCIM 2.0** (`/scim/v2`): one bearer token per organisation (`scim_tokens`, sha256 only, owner creates / rotates /
  revokes); `Users` list (filters `userName` / `externalId` / `id` / `emails.value eq`), get, create, replace, patch
  and delete (= disable + hidden from SCIM: `staff_users.scim_deleted_at`); `active: false` disables and ends every
  session; roles via the core `roles` attribute (reviewer / admin); owners are never changed by SCIM; no Groups
  resource. Audit actor type `scim`. Accounts created by SCIM or just in time have no password
  (`NO_PASSWORD_HASH`) and `staff_users.provisioned_via` says how they were created.

### Reviewer workflow (`packages/shared/src/{review,incidents,explain}.ts`, `services/review.ts`, `routes/admin/review.ts`)

Five event categories keep the distinction reviewers need: potential integrity issue, uncertain observation,
technical problem, session change, and policy exception (an approved accommodation — context, never a flag).
Reviewers decide each flag with a structured resolution that answers two separate questions — was the detection
right (precision), and is there an integrity concern — and implies the stored status, so older readers keep
working. Every decision is kept in `event_reviews` (who, what, why; `overrides` when it changed another reviewer's
decision, which requires a reason). Flags close in time form **incidents** (`groupIncidents`: within 30 s, a
long-running condition extends its incident by at most 60 s); an incident's events can be decided together, and
technical / low-severity flags in bulk — the server recomputes incidents and enforces eligibility. **Explanations**
(`explainEvent`) say which rule recorded an event with the session's frozen settings, what was measured, and what
weakens or explains it (coinciding poor light or degraded monitoring, a second opinion, an accommodation); built
from the event, its session's rules and other events, so the drawer and the report agree.
`session_reviews` holds a session's review: assignee, escalation (resolved by an administrator) and the outcome
(`no_concerns | concerns | inconclusive | technical_issues`), which needs the exam to have ended and every flag
decided; resolving adds a neutral `review_completed` timeline event (→ `session.reviewed` webhook, outcome only).
Service-level targets (`settings.reviewSla`: held exams in minutes, flags in hours) give each session a due time
(summary `review.due`) that orders the review queue, marks overdue holds on the dashboard and feeds the
`sp_cluster_review_*` gauges. The audit log can be exported as CSV.

### Sandbox organisations and quotas (`packages/shared/src/quotas.ts`, `services/quotas.ts`, `services/tenancy.ts`, `services/sandbox-purge.ts`)

* **Kind.** `organizations.kind` is `production` (default; every organisation from before migration 0017) or `sandbox`
  (CHECK constraint), with operator-set `quotas` (jsonb overrides: a missing key = the kind's default, `null` = no
  limit) and `sandbox_purge_days` (null = 14). Only the operator CLI changes them (`org:create` / `org:set`,
  `services/tenancy.ts`, audited as actor `system`); `PUT /settings` ignores them. A sandbox is marked for staff
  (`GET /api/auth/me` `org: StaffOrgDTO` → a permanent banner), for the candidate (`CandidateSessionState.sandbox` →
  *Practice environment* on the welcome screen), in alert emails (subject and first line) and webhooks (`sandbox: true`
  in the envelope, set when the delivery is enqueued).
* **Quotas** (`effectiveQuotas`): exams not archived, candidate records, exam sessions created per calendar month in
  UTC (`quotaMonth`; the `org_usage (org_id, month)` counter, incremented as the last write of the creating
  transaction — a counter rather than a count of rows, so deleting candidates or the sandbox clean-up never gives
  sessions back). `assertExamQuota` / `assertCandidateQuota` / `assertSessionQuota` are called by every creation path
  (staff exams create / import / publish-from-archive, staff and `/api/v1` candidate creation, staff and `/api/v1`
  assignments); with a finite limit they take a per-organisation, per-quota advisory transaction lock, count, and
  refuse with 409 `quota_exceeded` (`QuotaExceededDetails`, `quotaExceededMessage`) before anything is created —
  parallel requests cannot exceed a limit. Without a limit no lock is taken. `GET /api/admin/usage` (`OrgUsageDTO`,
  warning from 80 %) feeds Settings → *Usage and limits*; `quotaPressure` feeds the cluster gauge
  `sp_cluster_organizations_at_quota{quota,level}` (a count of organisations, not a series per organisation).
* **Clean-up** (`sandbox-purge` job, hourly, advisory lock 727274013 shared with `sandbox:purge`): per sandbox
  organisation, sessions whose last use (end, else the latest activity as in `abandonment.ts`) is older than the
  period and candidates left without sessions are deleted — images first through the evidence helpers
  (`purgeSessionEvidence`, `purgeCandidateIdPhoto`, `purgeEvidenceRows`, each blob in its row's storage location),
  then the rows, in one transaction per session / candidate that re-checks the kind under a share lock on the
  organisation row and the legal hold under the row lock. Legal holds are kept and reported; exams, staff, keys, the
  privacy register and the audit log are kept. `sandbox.purge` audit entry per organisation and run, `job_status`
  row `sandbox-purge`, operational check `sandbox_purge` for sandbox organisations.

## 8. Privacy & retention

Consent recorded before any camera analysis. Identity references and screenshots encrypted at rest,
accessible only to authenticated staff, audit-logged. Retention job (hourly) purges evidence blobs
`evidenceRetentionDays` after the session ends (org default, per-exam override) unless staff placed
the session under `legalHold`; purges leave a metadata tombstone. Event metadata is deleted after
`eventRetentionDays`. A sandbox organisation's data is deleted much earlier: sessions, images and candidates not used
for its clean-up period (default 14 days; §7 *Sandbox organisations*). No
continuous video. Candidate references are per-session and never reused across exams.

### Privacy operations (`packages/shared/src/privacy-ops.ts`, `services/privacy-requests.ts`, `services/privacy-export.ts`, `services/privacy-ops.ts`, `routes/admin/privacy.ts`)

* **Register** (`privacy_requests`): one row per data-subject request with its deadline (received + 30 days +
  extension ≤ 60 days with a reason), assignee and resolution; what was asked is encrypted (AAD
  `privacy-request:<id>`). The candidate link is `ON DELETE SET NULL`, so the record of an answered request survives
  the erasure it led to. Administrators and owners only.
* **Export**: `buildCandidateExport` reads the records up front (candidate, accommodations with notes, per session the
  report without the access link, answers without keys, events and identity checks with image file names) and returns
  an async iterable of ZIP entries; images are decrypted one at a time while `lib/zip.ts` streams the archive. Only from
  a request (`exportedAt`, audit before the first byte).
* **Erasure**: `eraseCandidate` (shared with `DELETE /candidates/:id`) refuses open sessions and legal holds, deletes
  blobs and templates first (not transactional), then the rows in one transaction (the candidate cascades).
* **Consent withdrawal**: `withdrawConsent` ends the session in one `withSession` transaction
  (`finalizeSession(m, 'candidate_withdrew')`: terminated, no grading, `session_terminated` with reason
  `consent_withdrawn`) and inserts the register row; after commit it purges the session's evidence under the row lock
  (skipped under legal hold). `uploadEventEvidence` refuses images for a withdrawn or purged session, and purges one
  stored while the withdrawal raced it.
* **Deletion evidence**: `runRetention` records each real run in `job_status` (`services/job-status.ts`);
  `retentionPreview` groups due evidence by UTC day with the job's own day SQL (`evidenceDaysSql`); `opsChecks` turns the
  job, overdue deletions, overdue requests, capacity, webhooks and alert emails into ok / warning / failing.

## 9. Accuracy measurement

* `apps/server/src/eval` — identity harness: dataset folder `subject/condition__*.jpg`, computes
  genuine/impostor distributions, FMR / FNMR / unable-to-verify rates at the configured thresholds,
  broken down per condition (lighting, glasses, hairstyle, clothing, background, camera, pause length)
  plus synthetic perturbations (brightness, gamma, blur, JPEG, downscale, noise, colour cast).
* `packages/detection/src/eval` — scenario harness: labelled `FrameObservation` traces (synthetic
  generators + recorded traces) replayed through the engine; per-detector precision / recall /
  false alerts per hour / onset latency.
* Production: reviewer decisions (reviewed vs dismissed) give per-detector precision on the
  "Detection quality" page.

### Model governance (`packages/shared/src/governance.ts`, `services/decision-configs.ts`, `services/calibration.ts`, `routes/admin/governance.ts`)

What decides, and who may change it:

* **Decision configurations** — an organisation's identity thresholds (match / mismatch, ID-photo match / mismatch,
  confirmations) are versioned (`decision_configs`). A change is *proposed* with a reason (≥ 10 characters), previewed
  on the last 30 days of the organisation's identity samples (how many per-sample labels would change, and how), and
  *approved* by a second administrator or owner (four eyes); the proposer may approve alone only when the
  organisation has no other active administrator, recorded as `selfApproved`. Approval activates it at once: the
  previous version is retired, and the thresholds and version are mirrored into the organisation settings that every
  decision path already reads, so the next decision — including in exams in progress — uses it. One open proposal
  and one active version per organisation (partial unique indexes; every transition locks the organisation row).
  **Rollback** restores a retired version as a new version immediately (it was approved before), withdrawing an open
  proposal. Version 1 is created on first use from what the organisation had (its stored thresholds, else the
  release defaults); a version without its own thresholds follows the running server's defaults, so organisations
  that never customised them keep getting improved defaults. `PUT /settings` no longer changes thresholds (409
  `decision_config_required` for a different value).
* **What the organisation cannot change**: the recogniser model and its calibration ship with the server (face
  templates are tied to the model that made them, so a model is never rolled back on its own — see OPERATIONS.md §1).
* **Stamps** — every identity decision records `decision_config_version`, `calibration_version` (`CALIBRATION.version`)
  and `model_version` (`EMBEDDING_MODEL_VERSION`) from the same organisation row as its thresholds; every event raised
  by the browser records `engine_version` (`DETECTION_ENGINE_VERSION`, sent with each event batch; a fingerprint test
  fails when detector parameters change without a bump). Staff see the version on each identity check and in the
  session report ("Decided under"); the integration API does not return them.
* **Calibration by condition** (`GET /metrics/calibration`) — identity decisions broken down by face lighting
  (brightness bands of the quality gate), camera resolution and browser / operating system (the session's latest
  device record), and by decision configuration, calibration and model. Grouped in SQL, User-Agents folded into
  families in code. No demographic attribute is collected or inferred; fairness across people is measured in consented
  pilots (`docs/accuracy/`).
* **Drift** (`GET /metrics/drift`) — the last 7 days against the 28 days before, per segment: identity
  could-not-verify and mismatch rates (overall, lighting, resolution, browser), the share of started exams with each
  kind of flag, and the share of decided flags reviewers found to be false detections. A signal is flagged only with
  |z| ≥ 3 in a two-proportion z-test, a change of at least 2 percentage points and at least 50 trials on each side
  (30 for the false-detection share) — conservative, so dozens of segments do not cry wolf. Version changes inside the
  windows (a configuration activated, a calibration / model / detector version first seen) are listed with the
  signals: they are the first suspects.

## 10. Configuration (env)

`DATABASE_URL`, `PORT` (8080), `PUBLIC_URL`, `EVIDENCE_KEY` (base64 32 bytes), `SESSION_SECRET`,
`STORAGE_DRIVER` (`fs`|`s3`), `STORAGE_DIR`, `S3_*`, `STORAGE_LABEL`, `STORAGE_LOCATIONS` + `STORAGE_LOCATION_<NAME>_*`
(further evidence storage locations; OPERATIONS §2), `REDIS_URL` (optional), `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD`, `WEB_DIST_DIR`. Capacity (docs/PERFORMANCE.md): `VISION_THREADS` (CPU threads
for face analysis, default CPU count − 1), `VISION_WORKERS`, `VISION_NICE`, `PG_POOL_MAX` (20),
`PG_STATEMENT_TIMEOUT_MS` (60 000), `VISION_DRIVER` (`local` | `remote`; with `remote`: `VISION_WORKER_URLS`,
`VISION_WORKER_TOKEN`, `VISION_WORKER_TIMEOUT_MS`, §4; the worker process itself reads `VISION_WORKER_TOKEN`,
`VISION_WORKER_PORT` (8090), `VISION_WORKER_HOST`, `VISION_THREADS` (default: every CPU), `MODELS_DIR`),
`CAPACITY_MAX_VISION_WAIT_MS` / `CAPACITY_MAX_EVENT_LOOP_MS` / `CAPACITY_MAX_DB_WAITING`
(when `/api/health/capacity` stops accepting exam starts; OPERATIONS §5), `METRICS_TOKEN` (serves Prometheus
`/metrics` to a scraper holding it; unset = not served). Integrations (optional):
`SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` (email alerts),
`WEBHOOK_ALLOW_PRIVATE_NETWORKS` (dev only), `WEBHOOK_DISABLE_AFTER_FAILURES`, `API_RATE_LIMIT_PER_MINUTE`. Single sign-on
and SCIM: `SSO_ALLOW_PRIVATE_NETWORKS` (default: the webhook setting; dev only), `SSO_TIMEOUT_MS` (10 000),
`SCIM_RATE_LIMIT_PER_MINUTE` (600).

## 11. Integrations

* **Integration API** `/api/v1/*` (`routes/v1`), authenticated with organisation API keys
  (`Authorization: Bearer sp_live_…`, only sha256 stored, audit actor `api_key`, per-key rate limit):
  exams, candidate upsert by `externalId`, assignments (access links), session summaries, the staff
  report and event list **without evidence URLs**. Customer documentation: `docs/INTEGRATION_API.md`.
  * **The contract is code**: `packages/shared/src/integrations.ts` holds zod schemas for every request, query and
    response, and the endpoint catalogue (`INTEGRATION_ENDPOINTS`: method, path, required scope, idempotency, error
    codes). The DTO types are inferred from the schemas; the server registers each route from the catalogue (its
    preHandlers — API key, scope, idempotency — come from there); `packages/shared/src/openapi.ts` converts the
    schemas (a focused zod → JSON Schema 2020-12 converter for the features used; anything else throws) into the
    OpenAPI 3.1 document served at `GET /api/v1/openapi.json` (public) and committed as `docs/openapi.json`
    (`pnpm --filter @sp/server openapi`). `test/integrations/contract.test.ts` checks that no route exists outside
    the catalogue, exercises every endpoint and validates each response strictly (undescribed fields fail) and
    each error code against the document.
  * **Scopes and expiry** (`auth/api-key.ts`): `api_keys.scopes` (jsonb, canonical order; migration 0015 gave
    existing keys all of them) and `expires_at`; `requireScope(scope)` → 403 `insufficient_scope`; expired → 401
    `api_key_expired`. `accessLink` in `GET /sessions/:id` only with `assignments:write`. Expiring keys: the
    Integrations page, the `api_keys` operational check (`services/privacy-ops.ts`) and the
    `sp_cluster_api_keys_expiring_soon` gauge.
  * **Idempotency** (`services/idempotency.ts`): `Idempotency-Key` on every POST. `api_idempotency_keys` (unique
    `(org_id, key)` — the insert is the lock), request hash over method, path, query and canonical JSON body; 2xx
    responses stored encrypted (AAD `api-idempotency:<id>`, `rekey` target) by a route `onSend` hook and replayed
    with `Idempotent-Replayed: true`; other statuses release the key; 422 for another request, 409 while running
    (in-progress rows older than 60 s are taken over); the hourly `api-idempotency` job deletes rows after 24 h.
* **Webhooks**: a durable outbox. `withSession()` calls `services/integration-events.ts` inside the
  session transaction (savepoint), so every event touched by any mutation — candidate ingest, identity
  engine, staff actions, sweeper expiry/timeouts, abandonment — becomes `webhook_deliveries` rows
  exactly once (unique `(webhook, dedupeKey)`). The `webhooks` job signs
  (`X-SmartProctoring-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`) and POSTs them through an SSRF
  guard (DNS pinned at connect time; private ranges refused in production), retries with backoff up to
  10 attempts and disables endpoints that keep failing. Payloads never contain images or face data. A sandbox
  organisation's envelopes carry `sandbox: true`.
* **Email alerts** (optional SMTP): the same hook queues `email_alerts` rows (holds, pause requests,
  high-severity events per org toggles); the `email-alerts` job sends at most one email per session per
  5 minutes (digest), plain text + simple HTML with a link to the staff app, never images.
* **Abandoned sessions**: the hourly `abandoned-sessions` job closes sessions that can never end on
  their own (invited / ready / paused / on hold, or active with the clock stopped) after the org's
  `abandonAfterDays` without activity (a scheduling window counts as activity until it closes): status `terminated`, endReason `abandoned` (staff-facing
  `SessionEndReason`), no score, a neutral `session_terminated` event, audit `session.abandoned`;
  retention then applies from the end time.
