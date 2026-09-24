# SmartProctoring

Smart proctoring for online exams. It monitors an exam as it happens, keeps the candidate's session
intact when they pause (even across browser restarts, rooms and cameras), checks that the **same
person** continues after every pause, absence and camera interruption, and turns observations into
timely, reviewable alerts with screenshots — while keeping integrity signals separate from ordinary
session changes, uncertain observations and technical problems.

> Observations, not verdicts: the system reports what it saw (“a different face may have appeared
> after resume”, confidence, evidence, context). People decide.

## What it does

**Before the exam** — webcam preview and readiness check (camera delivering frames, exactly one face,
face size/position, lighting, sharpness, virtual-camera warning) → randomized **live-person challenge**
(head turns verified on the server from facial-landmark parallax, so a photo held up to the camera
fails) → a **protected identity reference** (face templates + images, encrypted, never replaced
automatically) → optional comparison with the candidate's **approved ID photo**.

**During the exam** (in-browser analysis, no video upload) — candidate missing, more than one person,
possible person swap (server-side face verification at intervals and whenever the face returns, the
camera reconnects, or after another person was in view), sustained or repeated looking away / down,
repeated attention to one off-screen direction, unusual movement, obstructed/cut-off/unclear face,
visible phone or other devices/books, covered lens, frozen image, unusable lighting, virtual or
replayed camera feeds, camera disconnect / permission loss — plus exam-page events (tab hidden,
window focus lost, fullscreen exited, copy/paste attempts, additional display connected). Each issue
is **one event with a start and end**, debounced by duration, repetition, confidence and the
candidate's own normal position. Brief glances and single bad frames never flag.

**Pause & resume** — per-exam rules (timer stops or continues, reason required, approval required,
limits). Answers, progress, remaining time and history are preserved. Paused and disconnected
periods are marked **unobserved** and never produce behavioural flags. Resuming (hours or days later,
any room, any camera) repeats readiness + live-person checks and compares against the original
reference: *match* → continue; *unable to verify* → guidance and retry, then human review; *strong
evidence of a different person* → hold for review with before/after evidence. Clothing, hair,
background, angle and brightness changes are recorded as context only.

**Reliability** — events and screenshots are queued on the candidate's device when the connection
fails and delivered later with original timestamps, without duplicates. Both the candidate and the
administrator see when live reporting is interrupted.

**Staff** — live dashboard (active, paused, on hold, disconnected, completed; latest monitoring
status; flags as they arrive; pause approvals), chronological session timeline (periods, pauses,
resumes, identity checks, camera issues, behaviour), screenshots, side-by-side swap comparison with
surrounding timeline, filters, notes, mark reviewed / dismiss false positives, holds, releases,
time extensions, printable final report covering every active period, pause and resume.
Exams, questions, per-exam proctoring policy, candidates, ID photos, invite links, users & roles,
retention settings, audit log, detection-quality metrics.

**Integrations** — organisation API keys and a REST integration API (`/api/v1`) to create candidates,
issue invite links and pull reports from an LMS/HR system; signed webhooks (HMAC-SHA256, durable
outbox with retries) for flags, holds, pause requests and submissions; optional SMTP email alerts
with per-session throttling. See [docs/INTEGRATION_API.md](docs/INTEGRATION_API.md).

**Privacy** — explicit notice + consent, no continuous video, encrypted evidence, role-based access
with audit logging, automatic retention purge with legal hold. See [docs/PRIVACY.md](docs/PRIVACY.md).

**Accuracy** — per-detection evaluation harnesses (identity: false-mismatch / missed-swap /
unable-to-verify rates across lighting, blur, low-res cameras, occlusion, etc.; behaviour: precision,
recall, false alerts per hour, onset latency, duplicate events) plus production precision from
reviewer decisions. See [docs/accuracy/](docs/accuracy/README.md).

## Architecture

```
Candidate browser                         Server (Node 22, Fastify, Postgres)
 MediaPipe face mesh + object detector     Candidate API ─ session state machine, exam clock, periods
 @sp/detection engine → episodes           Identity engine ─ YuNet + SFace (ONNX) verification vs protected reference
 IndexedDB outbox (offline-safe)  ──────▶  Evidence store (AES-256-GCM) · retention · audit log
 JPEG frames for identity checks           Staff API + WebSocket live feed ─▶ Admin dashboard
```
Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Repository layout:

| Path | Contents |
|---|---|
| `packages/shared` | Contract: event catalog, policy schema, API DTOs, clock math, pose, privacy notice |
| `packages/detection` | In-browser monitoring engine (pure TS) + behavioural accuracy harness |
| `apps/server` | API, state machine, identity/vision, evidence, jobs, identity accuracy harness |
| `apps/web` | Candidate app (`/take/:token`) and staff app (`/admin`) |
| `e2e` | Playwright end-to-end tests with a fake camera |

## Quick start (development)

Requirements: Node 22, pnpm 10, Postgres 14+.

```bash
pnpm install
createdb proctor                                   # or: psql -c 'create database proctor'
pnpm --filter @sp/server seed                      # demo org, staff logins, sample exam, candidate links
pnpm dev                                           # server :8080 + web :5173
```
Open http://localhost:5173/admin and sign in with the seeded account printed by the seed script
(dev default `admin@example.com` / `ChangeMe123!`). Candidate links (`/take/<token>`) are printed by
the seed script and can be created from Exams → Assign.

## Production

`docker compose up -d --build` (see [docs/OPERATIONS.md](docs/OPERATIONS.md)) — single container
serving API + web app, Postgres, optional Redis for multi-instance realtime. Configuration:
[.env.example](.env.example). HTTPS is required for camera access.

## Testing

```bash
pnpm test              # unit + integration tests (server tests need Postgres)
pnpm typecheck
pnpm --filter @sp/detection eval                          # behavioural detector accuracy
pnpm --filter @sp/server eval:identity --dataset <dir>    # identity accuracy on your data
pnpm test:e2e                                              # end-to-end with fake camera
```

## Licensing

Proprietary. All dependencies and bundled models are under commercial-friendly licenses (MIT,
Apache-2.0, BSD, ISC; libvips LGPL dynamically linked). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
