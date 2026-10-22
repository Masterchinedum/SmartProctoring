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

## 3b. Round 3 — launch reliability (October 2026)

| Area | Change | Where |
|---|---|---|
| Runtime | **Node 24 only**: `engines >=24` with `engine-strict` (pnpm install refuses older Node), the server refuses to start on Node < 24, Docker `node:24-bookworm-slim`, CI Node 24 | `package.json`, `.npmrc`, `Dockerfile`, `apps/server/src/main.ts` |
| Privacy | onnxruntime's usage telemetry is switched off (`ORT_DISABLE_TELEMETRY=1` unless set) | `vision/engine.ts`, `Dockerfile` |
| Busy server | `Retry-After` = the queue's estimated drain time (was a fixed 2 s); the candidate app waits that long plus a random 0–50 % and says the server is busy, not "check your internet connection" | `vision/pool.ts`, `app.ts`, `candidate/check/sendRetry.ts`, `outbox.ts` |
| Health | `/api/health/live`, `/api/health/ready` (= `/api/health`; database within 2 s and a vision worker — vision was hard-coded "ok"), `/api/health/capacity` (whether to take more exam starts; never for load-balancer routing) | `routes/public.ts`, `services/capacity.ts` |
| Observability | Prometheus `/metrics` behind `METRICS_TOKEN` (vision queue and latency, capacity, identity decisions, jobs, retention, evidence-store errors, webhook / email backlogs, HTTP, Postgres pool, WebSockets, the running calibration); 18 alert rules; request ids on every response and log line; session / staff / API-key ids on authenticated log lines | `lib/metrics.ts`, `docs/prometheus-alerts.yml`, `lib/request-log.ts`, OPERATIONS §5 |
| Peak protection | **Admission at exam start** (starts deferred while at capacity, clock not running, ≤ 5 min) and **load-aware sampling** (routine samples spaced out, never beyond the Balanced intensity; triggered and evidence-building samples untouched) — measured: identity sample p95 12.0 → 3.7 s, check-in frame p95 8.6 → 3.0 s at a synchronised start of 136 on 4 vCPU (PERFORMANCE §7.8) | `services/candidate-actions.ts`, `services/identity-evidence.ts` |
| Tests | CI fetches the public face photos at pinned commits (SHA-256 checked, never committed) so the real-model tests run; `E2E_NO_SKIP` / `SP_REQUIRE_TEST_IMAGES` turn a missing image into a failure; core e2e (01–18) on every PR; the Docker image built and booted on every PR; the whole e2e suite nightly | `.github/workflows/`, `e2e/scripts/fetch-faces.ts` |

## 3c. Round 4 — exam operations, governance and enterprise readiness (October 2026)

| Area | Change | Where |
|---|---|---|
| Accommodations | Per-candidate approved exceptions (extra time, rest breaks, no head-turn challenge, assistive technology, detectors off, support person, **identity verified by staff**, **no camera**), granted / revoked on the candidate page with a broad basis and an encrypted admin-only note; applied to unstarted sessions, frozen at start with the list of exam rules they changed (shown on the session, in the report with attributed limitations, to the candidate on the welcome screen, in the privacy notice and the integration API). Staff verification: attest checks without pictures, a `staff_verification` hold released by recording how identity was verified, no identity sampling; no camera: the candidate app never opens a camera. Server + web + e2e (scenario 19) tests | `services/accommodations.ts`, `routes/admin/accommodations.ts`, `services/checks.ts` (attest), candidate `check/AttestStep.tsx` |
| Exam versions | Publishing, and every edit of a published exam, writes an immutable version; each attempt keeps the version it started with (questions served, answers accepted, grading, report). Content can therefore be edited freely while exams run. Version list with per-question diffs and attempt counts, version viewer with answer keys, export / import (`*.exam.json`, imported as a draft), audited **regrade** with preview (corrected key → finished attempts; timeline entry, score history, `session.regraded` webhook). Migration 0007 versions existing exams; `test/migrations.test.ts` upgrades a database holding old data | `services/exam-versions.ts`, `services/regrade.ts`, `routes/admin/exams.ts`, staff app → exam page → Versions |
| Reviewer workflow | Five categories (potential integrity issue, uncertain, technical, session change, **policy exception**); structured resolutions per flag (integrity concern / accurate, no concern / covered by an accommodation / technical / inconclusive / false detection) with history, reasons required to change another reviewer's decision, and disagreement tracking; **incidents** (flags close in time) decided together; bulk decisions for technical / low-severity flags; plain-language **explanations** (rule with the exam's settings, measurements, what weakens or explains it) and a one-click comparison with the check-in reference; **review queue** with assignment, escalation to administrators and service-level targets (overdue holds on the dashboard, Prometheus gauges and alerts); session outcomes (timeline, report, `session.reviewed` webhook, integration API); precision that leaves out "inconclusive"; audit-log CSV export. Server tests + e2e scenario 11c | `services/review.ts`, `routes/admin/review.ts`, `packages/shared/src/{review,incidents,explain}.ts`, staff app → Review queue, session → Review tab, event drawer |
| Staff two-step sign-in | RFC 6238 authenticator codes (any authenticator app; QR code drawn locally) with replay protection, 10 single-use recovery codes shown once, a second sign-in step that costs the same as a password attempt (account backoff), organisation requirement for administrators + owners or everyone (owner only; staff without it can only set it up), "move to a new phone", administrator reset (Users page), break-glass `staff-access` CLI for operators when the only owner is locked out, audit entries and security emails for every change. Server tests (RFC test vectors, sign-in, limits, replay, requirement, resets, CLI) + e2e scenario 11b | `lib/totp.ts`, `services/mfa.ts`, `routes/auth.ts`, `services/staff-recovery.ts`, staff app `pages/AccountPage.tsx`, `pages/MfaEnrollmentGate.tsx`, `docs/SECURITY.md` §2 |
| Model governance | Identity thresholds **versioned**: proposed with a reason and a preview on the last 30 days of samples, approved by a second administrator (self-approval only for a single administrator, recorded), restored at once by rollback; every identity decision stamped with the decision configuration, calibration and model versions, every browser event with the detector version (bump enforced by a fingerprint test); Quality page: identity decisions **by condition** (lighting, camera resolution, browser, OS, versions) and **drift** (last 7 days vs the 28 before, conservative two-proportion test, version changes listed). Settings no longer edits thresholds. Server tests (incl. migration 0011) + e2e scenario 11d | `services/decision-configs.ts`, `services/calibration.ts`, `routes/admin/governance.ts`, `packages/shared/src/governance.ts`, staff app → Detection quality |
| Privacy operations | **Request register** (access, erasure, rectification, restriction, objection, consent withdrawal, other) with the legal deadline (one month from receipt, extendable by up to 60 days with a reason), assignee, resolution and history; what was asked encrypted; overdue / due-soon counts. **Personal-data export** from an access request: one ZIP (candidate record, accommodations, per session the report, consent, devices, answers without keys, events, identity checks and the decrypted images; already-deleted images listed), streamed, never stored, recorded on the request. **Erasure** from an erasure request (refused while an exam runs or is under legal hold); requests outlive the candidate. **Consent withdrawal** endpoint for the candidate: the exam ends (`candidate_withdrew`, no score), its images and templates are deleted at once, late uploads refused, a register entry opened, `session.terminated` webhook with reason `consent_withdrawn`; in the exam app from the privacy notice (*Withdraw my consent…*: what happens, optional reason, explicit confirmation; images queued on the device are deleted unsent). **Deletion schedule** (due per day, overdue, legal holds, the retention job's recorded last run) and **operational checks** (retention job, overdue deletions, overdue requests, capacity, webhooks, alert emails). Server tests (incl. migration 0012, rekey) + e2e scenario 11e | `services/privacy-requests.ts`, `services/privacy-export.ts`, `services/privacy-ops.ts`, `services/job-status.ts`, `routes/admin/privacy.ts`, `packages/shared/src/privacy-ops.ts`, staff app → Privacy, `docs/PRIVACY.md` §4–§5 |
| Data residency | Operator-configured **evidence storage locations** (`STORAGE_LOCATIONS` + `STORAGE_LOCATION_<NAME>_*`, fs or S3 with region and label; the existing `STORAGE_*` is the `default` location, so nothing changes for existing deployments; refuses to start on inconsistent locations or on a location in use but missing). An owner chooses the location for **new** images (Settings → *Where evidence images are stored*, audited; the page says plainly that only images live there — the database with candidate records and face templates stays where it is — and how many images each location holds). Every evidence row records its location (`evidence.storage_location`, migration 0013) and is read and deleted there (staff view, ID-photo copies, purges, retention, `rekey`, export). **`storage:move`** moves an organisation's existing images: copy, verify (decrypt + SHA-256), compare-and-set, delete the old copy; dry run, resumable, idempotent, audited (`evidence.storage_moved`); rollback = move back. Storage errors per location (`sp_evidence_storage_errors_total{location}`). Server tests (incl. migration 0013) + e2e scenario 19b | `lib/storage.ts`, `services/evidence.ts`, `services/evidence-storage.ts`, `services/storage-move.ts`, `scripts/storage-move-cli.ts`, staff app `pages/EvidenceStorageSection.tsx`, `docs/OPERATIONS.md` §2 |
| Scheduling and recovery | **Scheduling windows**: a session may carry a window (set on assignment in the staff app or the integration API, changed on the session page / `PUT /api/v1/sessions/:id/window` until the exam starts; audited, timeline, `session.rescheduled` webhook). The exam can be started only inside it, the check-in from 30 minutes before; outside it the candidate's link shows "This exam opens on … / is closed" in their own time zone; an exam in progress is never cut off; abandonment counts from the end of the window. **Resume policy** per exam (*Interruptions and recovery* in the policy editor): maximum reopenings in a new browser window during the exam and maximum time disconnected; when reached the exam is held for staff (default; releasing gives the allowance again) or ended and submitted (`resume_limit`, explained to the candidate, `session.submitted` reason `too_many_reconnects` / `offline_too_long`). **Reopen for recovery** (session page, admin): an exam ended by time, staff, inactivity or the resume rules (never the candidate's own submission, a consent withdrawal or purged evidence; a resolved review must be reopened first) goes back on hold until the candidate passes a fresh identity check against the original reference, then continues with its answers and remaining time (+ minutes added); never-started sessions return to the check-in; audited, timeline, report, `session.reopened` webhook. Server tests (incl. migration 0014) + web unit tests + e2e scenario 19c | `services/scheduling.ts`, `services/recovery.ts`, `packages/shared/src/scheduling.ts`, `jobs/sweeper.ts`, staff app → exam page (assignment), session page (*Reschedule…*, *Reopen for recovery…*), candidate `screens/StatusScreens.tsx` (window screen) |
| Integration API maturity | API keys get **scopes** (`exams:read`, `candidates:read`, `candidates:write`, `assignments:write`, `sessions:read`, `reports:read`, `events:read`; full access / read only / chosen permissions in the staff app; 403 `insufficient_scope`; candidates' exam links only with `assignments:write`) and an optional **expiry** (401 `api_key_expired`; "Expires in N days" status and banner, an operational check, the `sp_cluster_api_keys_expiring_soon` gauge and alert); keys from before were migrated with full access. **`Idempotency-Key`** on every POST (24 h, organisation-scoped, stored responses encrypted and covered by `rekey`, replay with `Idempotent-Replayed`, 422 / 409 / 400 codes, hourly purge). **OpenAPI 3.1** document generated from the shared zod schemas (no new dependency: a focused converter), served at `GET /api/v1/openapi.json` and committed as `docs/openapi.json` (a test keeps it current); routes are registered from the endpoint catalogue. Contract tests validate every endpoint's responses strictly and every error code against the document; the documented webhook verifiers (Node.js and a new Python one) are run against the server's signatures. Migration 0015, server tests (contract, scopes / expiry, idempotency, documented verifiers, migration, rekey) + e2e scenario 18b | `packages/shared/src/integrations.ts`, `packages/shared/src/openapi.ts`, `routes/v1/index.ts`, `auth/api-key.ts`, `services/idempotency.ts`, staff app → Integrations, `docs/INTEGRATION_API.md`, `docs/openapi.json` |
| Dedicated vision worker | Face analysis can run in separate **vision worker** processes (same image, `node dist/vision-server.js`; `pnpm --filter @sp/server vision-worker` from source) behind a small HTTP API authenticated with a shared token (constant-time, checked before the body is read; rotation with two accepted tokens), scaled independently of the API servers. `VISION_DRIVER=remote` + `VISION_WORKER_URLS` (+ DNS expansion: `docker compose --scale vision=N`, Kubernetes headless Service) + `VISION_WORKER_TOKEN`; the in-process pool stays the default (dev, tests, single host). The driver load-balances by least expected wait (polled worker load + what it sent since), skips dead workers (circuit breaker, back-off), retries only frames a worker did not take, and maps every failure to the local pool's behaviour (503 `vision_busy` + `Retry-After`); readiness = at least one worker ready; capacity, admission at exam start, load-aware sampling and `/metrics` read the fleet's queue (+ `sp_vision_remote_*`). Analysis results identical bit for bit (real-model test). `docker-compose.vision.yml`, CI docker job boots a worker + a remote-driver server, e2e option `E2E_VISION=remote`. Measured overhead and throughput: PERFORMANCE §8 | `src/vision-worker/`, `vision/remote.ts`, `vision/wire.ts`, `test/vision-remote.test.ts`, `docs/OPERATIONS.md` §2 |
| Resilience and monitoring | **Chaos tests** on real Postgres: connections killed before / right after COMMIT of event batches, answer saves and heartbeats (5xx, nothing partial, the resend applies exactly once), a connection lost while a transaction waits for the evidence store, a database outage (`/api/health/ready` 503, automatic recovery), a server restart in the middle of an identity check and of an identity burst, a face-analysis worker crashing mid-request, Redis unavailable. **Fixed**: a Postgres connection lost while checked out (restart, failover, killed session) crashed the whole server (unhandled `error` event); evidence blobs written in a transaction that rolled back were left without a row (never deleted by retention); the outage of a server restart reached the timeline only if the new process's sweeper ran before the candidate's next heartbeat — otherwise nothing was recorded and, under disconnect policy *stop*, the candidate lost the outage from their exam time (now the late heartbeat records it as the sweeper would, including the resume policy's `maxOfflineMinutes` action). e2e scenario 19e restarts a dedicated server mid-exam. **Migration tests** from every earlier migration with a row in every table, and a **schema drift check** (schema.ts vs the latest snapshot, and the migrated database vs the snapshot). **Metrics**: Postgres connection wait and connection errors, evidence-store latency, check outcomes, cluster-wide retention job status, images past their deletion date, privacy requests open / overdue; matching alerts with runbooks; the rules file is validated by a test | `test/chaos.test.ts`, `test/migration-upgrades.test.ts`, `test/schema-drift.test.ts`, `test/alert-rules.test.ts`, `e2e/tests/19e-server-restart.spec.ts`, `db/index.ts`, `services/evidence.ts`, `services/candidate-actions.ts` (heartbeat), `lib/metrics.ts`, `docs/prometheus-alerts.yml`, `docs/OPERATIONS.md` §5, §7 |
| Single sign-on and SCIM | Staff sign in with their organisation's identity provider: **OpenID Connect** (authorization code + PKCE + state + nonce, discovery / JWKS cached, ID-token signature, issuer, audience, expiry and nonce checked; `openid-client`) and **SAML 2.0** (SP-initiated, HTTP-Redirect AuthnRequest, HTTP-POST ACS; signed assertion or response, audience, recipient, time window, InResponseTo, replay protection; `@node-saml/node-saml`, licences checked, ARCHITECTURE §2). Per-organisation **identity providers** (owner only; administrators view / test): claimed email domains (the sign-in page finds the organisation from the email domain; each provider also has its own sign-in link), claim / attribute mapping, just-in-time accounts with a default role and group → role mappings (never owner), encrypted client secret (rekey target), SP metadata, redirect URI, test connection. Sign-in attempts bound to the browser (one use, 10 min); accounts linked by provider + subject, matched by email only inside the provider's organisation and domains; disabled accounts never sign in. **After single sign-on the identity provider handles the second factor** (local two-step sign-in not asked); **require single sign-on** for everyone except owners, who keep password + two-step sign-in as **break-glass**; provider changes end their sessions; unlinking on the Users page. **SCIM 2.0** `/scim/v2` (Users CRUD, filters, PATCH incl. Microsoft Entra ID style, deactivation signs out everywhere, delete = disable + hidden, roles via `roles`, owners untouchable, ServiceProviderConfig / Schemas / ResourceTypes; token per organisation shown once, hash stored, rotatable, audited, rate-limited). Requests to identity providers through the SSRF guard. Server tests (fake OIDC provider, SAML test IdP with signed assertions, SCIM, migration 0013, rekey) + web helper tests + e2e scenario 11f | `services/sso/*`, `routes/sso.ts`, `routes/scim.ts`, `services/scim.ts`, `routes/admin/sso.ts`, `lib/net-guard.ts` (`guardedFetch`), `packages/shared/src/sso.ts`, staff app → Settings → Single sign-on, sign-in page, Users, `docs/SECURITY.md` §2, `docs/OPERATIONS.md` §7 |
| Sandbox organisations and quotas | Organisations are **production** (default; every existing one) or **sandbox** (trials and integration testing, not for real candidates), created and changed only by the server operator: `org:create` (the first owner's temporary password printed once), `org:set` (kind, quotas, clean-up period; production → sandbox needs `--confirm-purge`), `org:list`, all audited as actor *system*. A sandbox is marked everywhere: a permanent staff-app banner, *Practice environment* on the candidate's welcome screen, `[SmartProctoring sandbox]` alert emails, `"sandbox": true` in webhook envelopes. **Quotas** per organisation (none for production unless set; sandbox 5 exams, 50 candidates, 100 sessions a month): exams not archived, candidates, exam sessions created per calendar month in UTC (a counter, so deletions do not refund), enforced on every creation path of the staff app and `/api/v1` under a per-organisation lock (409 `quota_exceeded` with a plain-language message; parallel requests cannot exceed a limit); Settings → *Usage and limits* (warning from 80 %); gauge `sp_cluster_organizations_at_quota`. **Sandbox clean-up** (hourly `sandbox-purge`, `sandbox:purge` by hand): sessions, images (each in its storage location) and candidates not used for 14 days (default) are deleted; legal holds kept and reported; never production; `sandbox.purge` audit entry, `job_status`, operational check. Migration 0017, server tests (quotas incl. the UTC month boundary and concurrency, purge, CLI, migration, contract) + web unit tests + e2e scenario 19d | `services/quotas.ts`, `services/tenancy.ts`, `services/sandbox-purge.ts`, `scripts/org-cli.ts`, `packages/shared/src/quotas.ts`, staff app `components/Shell.tsx` (banner), `pages/SettingsPage.tsx` (usage), candidate `screens/Welcome.tsx`, `docs/OPERATIONS.md` §9 |
| Cross-browser e2e | Playwright projects for **Firefox and WebKit** (`E2E_BROWSERS`) running the scenarios tagged `@cross-browser`. Their candidate camera is a **canvas-backed `getUserMedia` shim** (`E2E_CAMERA=shim`, also available in Chromium): the test process serves the frames of the same Y4M fixtures to a `canvas.captureStream()` track (frame 0 at every open, the file's frame rate, one timeline per page shared by concurrent tracks, constraints → `OverconstrainedError`, `getSettings()`, stable fake device, a no-camera mode). Verified in Chromium against the fake capture device (every `@cross-browser` scenario green in both modes, identical server-side frame quality); the `headturn` fixture holds the head frontal 15 s instead of 10 (calibration ends 9–14 s after the camera opens on a loaded machine). Candidate app: Fullscreen API with the WebKit-prefixed fallback (web unit tests). CI job `e2e-browsers` (firefox, webkit) and nightly (also Chromium with the shim) — **not yet run** (§4 item 3) | `e2e/lib/camera.ts`, `e2e/lib/browsers.ts`, `e2e/playwright.config.ts`, `apps/web/src/candidate/fullscreen.ts`, `.github/workflows/{ci,nightly}.yml`, `e2e/README.md` "Browsers and camera modes" |

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
     minutes. Heartbeats, answers and events stay fast. Since round 3 (§3b) admission at exam start and load-aware
     sampling step in first: starts are held back (clock not running, at most 5 minutes) and identity samples keep
     waiting about 2 s (PERFORMANCE §7.8). That smooths a peak; it does not add capacity.
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
3. **Browsers.** Every e2e scenario runs on Chromium. Firefox and WebKit (Playwright's builds — Safari's engine, not Safari itself) run the core scenarios (tagged `@cross-browser`: happy path, liveness with a photo and with a turning head, person swap, tab / fullscreen events, offline, reconnect, staff sign-in, accommodations incl. no camera) in CI (`e2e-browsers`, and nightly) with a canvas-backed camera shim that plays the same fixtures; the shim was verified against Chromium's own fake camera in Chromium (`e2e/README.md` "Browsers and camera modes"). **Not yet verified:** the Firefox and WebKit jobs had not run when this was written (the development environment had Chromium only) — expect a first round of fixes there (likely areas: fullscreen in headless Firefox / WebKit, MediaPipe's WebGL on runners without a GPU, WebKit's playback of the canvas stream). Not covered at all: real Safari on macOS / iPadOS (its camera prompt, its autoplay rules for the hidden analysis video), real cameras in Firefox, accessibility checks outside Chromium (the checker uses Chromium's accessibility tree). The candidate app falls back to the WebKit-prefixed Fullscreen API (Safari 16.0–16.3); browsers without element fullscreen (iPhone) cannot satisfy a `requireFullscreen` exam (the system check says so on the welcome screen).
4. **Phone detection** is implemented (COCO "cell phone") but not validated with real phone footage (no licensed test media).
5. **Staff authentication**: email + password with strong hashing, per-account backoff, short sessions and two-step sign-in (authenticator app + recovery codes, can be required organisation-wide), and single sign-on (OpenID Connect, SAML 2.0) with SCIM provisioning (round 4). Tested against an in-process OpenID Connect provider and a test SAML identity provider, **not yet against a real Microsoft Entra ID / Okta / Google tenant**: do one pilot per provider type with the runbooks in `docs/OPERATIONS.md` §7 before relying on it. Not supported: IdP-initiated SAML, encrypted SAML assertions, signed AuthnRequests, SCIM Groups (roles come from the `roles` attribute), single logout.
6. **Legal**: `PRIVACY.md` and the candidate notice are written to support GDPR/BIPA-style obligations but must be reviewed by counsel for your jurisdictions; define your sub-processors and data-processing agreements. Candidates withdraw consent from the privacy notice in the exam app (*Withdraw my consent…*, with a confirmation step); have counsel review that wording and the notice's "Your choices" paragraph (notice version 2026-10-21) for your jurisdictions.
7. **English only** (strings are centralised enough to localise).
8. Per-session answer conflict: if two devices edit the same answer, the later client sequence wins; superseded devices are blocked from writing.
9. **Docker image** — built and booted on Node 24 (round 3): locally, and by CI on every pull request (`docker` job: migrations, vision workers, web app, health probes). `docker compose up --build` with Redis and S3 still deserves one staging run before launch.
10. **Not exercised against real external services here**: a real SMTP provider (TLS/auth/SPF/DKIM), S3-compatible storage (retention and `rekey` were verified on local storage), webhook delivery to a public endpoint with the private-network guard on (e2e had to allow a local receiver). Multi-instance realtime and rate limits over Redis are covered by integration tests with a local Redis, not by a multi-host deployment.
11. **Security keys (WebAuthn) as a second factor, SCIM Groups, single logout and localisation** are the most likely next feature requests (single sign-on and SCIM shipped in round 4).

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
