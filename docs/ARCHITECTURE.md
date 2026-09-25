# SmartProctoring — Architecture

Smart proctoring for online exams: live monitoring, identity continuity across pauses/absences/camera
changes, reviewable evidence, and an administrator dashboard. This document is the contract every
component is built against. **`packages/shared` is the source of truth for types and API shapes.**

## 1. Components

```
apps/web  (React + Vite)                     apps/server (Node 22 + Fastify 5 + Postgres)
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

## 3. Session lifecycle

`invited → ready → active ⇄ paused → submitted`, plus `on_hold` and `terminated` (see `shared/src/session.ts`).

* **invited**: candidate opens `/take/:accessToken`, reads privacy notice, consents (recorded with version + time).
* **initial check** (`POST /api/candidate/checks` purpose=`initial`): camera readiness, one face, quality gate,
  active liveness challenge, then the server builds the **protected identity reference** (multiple
  frontal embeddings, encrypted). Optional comparison with approved ID photo. → **ready**.
* **start** → **active**, clock starts, `active` period opens.
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
* **expiry**: server sweeper auto-submits when the clock hits zero.

**Periods** partition the timeline: `check_in`, `active`, `resume_check` (observed) and `paused`,
`disconnected`, `on_hold` (unobserved). Unobserved periods produce an `unobserved_period` marker and
**no behavioural events are accepted for timestamps inside a paused/held period** (server drops them).

**Clock** (`ExamClock`): `{durationMs, usedMs, runningSince}`; arithmetic in `shared/session.ts`.
Runs only in `active` (and during `paused` if `timerBehavior='continue'`, and during an unannounced
disconnect if `disconnectTimerBehavior='continue'`).

## 4. Identity pipeline (server)

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
   suspect — 5 s / 2.5 s whatever the policy). Routine (periodic) samples take `routineBurstSize` frames; every
   triggered sample (exam start / resume, track break, appearance change, face return, camera reconnect, after
   multiple people / obstruction, follow-ups and server requests) takes `burstSize` (`burstSizeFor`). The per-exam
   *sampling intensity* (`samplingProfile`, a label the admin UI fills the numbers from; the numbers are the source of
   truth) is **Maximum accuracy** (default: 3 frames every 6 s for 180 s, then every 15 s — 0.5 then 0.2 frames/s)
   or **Balanced** (2-frame routine samples every 12 s, then every 30 s — about 3× the capacity; swap detection
   relies more on the triggered samples). `CandidateSessionState.session.identitySample` / `HeartbeatResponse.identitySample` ask for an
   `exam_start` burst right after /start and after every passed resume / reconnect / reverify check, and — watchdog —
   a `server_request` when no sample came for 3 expected intervals of the exam's policy (the client then takes the
   burst even without a qualifying frame); still none after 6 intervals (≥ 1 min) with the browser connected ⇒ `identity_unverifiable`
   (details.reason `no_samples`), closed by the next sample. Vision priority for samples comes from server state
   (a pending request, evidence building up, the start-up window), not from the client's trigger label.
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

## 6. Events, evidence, delivery

* `EventUpsert` (client) is idempotent: primary key = episode UUID; server applies only if
  `version > stored version`. Category/severity/title come from `EVENT_CATALOG`, not the client.
* Evidence: `PUT /api/candidate/evidence/:uuid` (JPEG, idempotent). Stored encrypted
  (AES-256-GCM, per-blob IV, key from `EVIDENCE_KEY`), metadata in `evidence` table.
* Offline: the client keeps an IndexedDB **outbox** (events latest-version-wins, evidence blobs,
  answers, identity samples) and flushes with backoff. Original timestamps are preserved; server sets
  `deliveredLate` when received > 30 s after the event's last change. Heartbeat every 5 s; server
  marks `offline` after `heartbeatTimeoutSec` and opens `reporting_interrupted` (closed on return).
  Candidate UI shows a banner while the outbox cannot be delivered; admin UI shows
  "reporting interrupted since …".
* Clock skew: client computes `offset = serverTime − midpoint(rtt)` from heartbeats and stamps
  observations with `Date.now() + offset`.

## 7. Staff side

Roles: `owner`, `admin` (manage exams/candidates/settings/users), `reviewer` (sessions, evidence,
notes, review). Every evidence view is written to `audit_log`. Realtime via WebSocket
`/api/admin/live` (in-process bus; Redis pub/sub when `REDIS_URL` is set for multi-instance).

Review language is observational. Reports list every active period, pause, resume, disconnection and
hold, identity-check outcomes, event counts per category, notable events, reviewer notes and the
system's limitations.

## 8. Privacy & retention

Consent recorded before any camera analysis. Identity references and screenshots encrypted at rest,
accessible only to authenticated staff, audit-logged. Retention job (hourly) purges evidence blobs
`evidenceRetentionDays` after the session ends (org default, per-exam override) unless staff placed
the session under `legalHold`; purges leave a metadata tombstone. Event metadata is deleted after
`eventRetentionDays`. No
continuous video. Candidate references are per-session and never reused across exams.

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

## 10. Configuration (env)

`DATABASE_URL`, `PORT` (8080), `PUBLIC_URL`, `EVIDENCE_KEY` (base64 32 bytes), `SESSION_SECRET`,
`STORAGE_DRIVER` (`fs`|`s3`), `STORAGE_DIR`, `S3_*`, `REDIS_URL` (optional), `BOOTSTRAP_ADMIN_EMAIL` /
`BOOTSTRAP_ADMIN_PASSWORD`, `WEB_DIST_DIR`. Capacity (docs/PERFORMANCE.md): `VISION_THREADS` (CPU threads
for face analysis, default CPU count − 1), `VISION_WORKERS`, `VISION_NICE`, `PG_POOL_MAX` (20),
`PG_STATEMENT_TIMEOUT_MS` (60 000). Integrations (optional):
`SMTP_HOST` / `SMTP_PORT` / `SMTP_SECURE` / `SMTP_USER` / `SMTP_PASSWORD` / `SMTP_FROM` (email alerts),
`WEBHOOK_ALLOW_PRIVATE_NETWORKS` (dev only), `WEBHOOK_DISABLE_AFTER_FAILURES`, `API_RATE_LIMIT_PER_MINUTE`.

## 11. Integrations

* **Integration API** `/api/v1/*` (`routes/v1`), authenticated with organisation API keys
  (`Authorization: Bearer sp_live_…`, only sha256 stored, audit actor `api_key`, per-key rate limit):
  exams, candidate upsert by `externalId`, assignments (access links), session summaries, the staff
  report and event list **without evidence URLs**. Customer documentation: `docs/INTEGRATION_API.md`.
* **Webhooks**: a durable outbox. `withSession()` calls `services/integration-events.ts` inside the
  session transaction (savepoint), so every event touched by any mutation — candidate ingest, identity
  engine, staff actions, sweeper expiry/timeouts, abandonment — becomes `webhook_deliveries` rows
  exactly once (unique `(webhook, dedupeKey)`). The `webhooks` job signs
  (`X-SmartProctoring-Signature: t=…,v1=HMAC-SHA256(secret, t.body)`) and POSTs them through an SSRF
  guard (DNS pinned at connect time; private ranges refused in production), retries with backoff up to
  10 attempts and disables endpoints that keep failing. Payloads never contain images or face data.
* **Email alerts** (optional SMTP): the same hook queues `email_alerts` rows (holds, pause requests,
  high-severity events per org toggles); the `email-alerts` job sends at most one email per session per
  5 minutes (digest), plain text + simple HTML with a link to the staff app, never images.
* **Abandoned sessions**: the hourly `abandoned-sessions` job closes sessions that can never end on
  their own (invited / ready / paused / on hold, or active with the clock stopped) after the org's
  `abandonAfterDays` without activity: status `terminated`, endReason `abandoned` (staff-facing
  `SessionEndReason`), no score, a neutral `session_terminated` event, audit `session.abandoned`;
  retention then applies from the end time.
