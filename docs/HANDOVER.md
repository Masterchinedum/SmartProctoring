# Handover — state of the product

This document is the "what exists, what was verified, what is left" summary for the owner.

## 1. What was built

A complete, self-hostable proctoring product (monorepo, TypeScript end to end):

| Area | Where | Highlights |
|---|---|---|
| Candidate app | `apps/web/src/candidate` | Consent + privacy notice → camera readiness checklist → live-person challenge (randomised head turns) → protected identity reference → exam (5 question types, autosave, countdown) → pause / resume (even after closing the browser, days later, other room/camera) → reconnect / re-verify / hold / submit screens. In-browser monitoring (MediaPipe face mesh + object detector), offline-safe IndexedDB outbox, heartbeat, "reporting interrupted" banner, WCAG 2.1 AA work. |
| Monitoring engine | `packages/detection` | Pure-TS, debounced detectors: absence, multiple people, look-away (sustained / repeated / same-direction), unusual movement, obstruction, phone & other objects, covered lens, frozen feed, lighting, replay/virtual camera, camera disconnect/permission, browser signals (tab, focus, fullscreen, clipboard, extra display). One event per ongoing issue, relative to the candidate's own baseline. |
| Identity (server) | `apps/server/src/vision` | YuNet + SFace (ONNX) face verification against an encrypted, never-auto-replaced reference; quality gate → *unable to verify* (never *different person*) with guidance; confirmation before raising a swap; server-verified liveness (landmark parallax — a rotated photo fails). |
| Server | `apps/server` | Fastify + Postgres. Session state machine (clock stop/continue per rules, pause reason/approval/limits, periods incl. unobserved, holds, reconnect & instance takeover, expiry), idempotent event ingestion with original timestamps, encrypted evidence store, retention + legal hold, audit log, realtime WebSocket, reports, identity comparison, detection-quality metrics, abandoned-session cleanup, key rotation (`rekey`), rate limits (Redis-shared when configured). |
| Staff app | `apps/web/src/admin` | Live dashboard (active / paused / on hold / disconnected / completed, live flags, pause approvals), session timeline with observed/unobserved periods, event drawer with screenshots, review / dismiss / notes, side-by-side swap comparison with surrounding timeline, printable final report, CSV export, exams + policy editor, candidates + ID photos, invite links, time extension, holds/releases/terminate, settings, users & roles, audit log, quality page, integrations. |
| Integrations | `/api/v1`, webhooks, SMTP | API keys, integration API (candidates, assignments, sessions, reports, events), signed webhook outbox with retries, email alerts with throttling. See `INTEGRATION_API.md`. |
| Ops | `Dockerfile`, `docker-compose.yml`, `.env.example`, `.github/workflows/ci.yml` | Single container serving API + SPA; Postgres; optional Redis. |

Requirement-by-requirement mapping: the requirements audit (90 atomic requirements) is summarised in §3.

## 2. How to run

* Dev: `pnpm install && createdb proctor && pnpm --filter @sp/server seed && pnpm dev` → http://localhost:5173/admin (`admin@example.com` / `ChangeMe123!`, dev only). Candidate links are printed by the seed.
* Production: `docker compose up -d --build` behind TLS — see `OPERATIONS.md` (secrets, TRUST_PROXY, backups, key rotation, sizing).

## 3. Verification performed

* **Unit + integration tests**: `pnpm test` — 735 tests across shared (5), detection engine (109), server (382, real Postgres, real ONNX models where relevant) and web (239). All green at handover; `pnpm typecheck` clean.
* **End-to-end**: `pnpm test:e2e` — real Chromium with a fake camera (Y4M videos generated from still photos + a synthetic head-turn video), real server, real models: 32 tests covering all core scenarios — happy path with pause/close/resume, pause rules, liveness (still photo fails, turning head passes, tampered client rejected), person swap mid-exam (held ~12 s after the second person appears, compared, released/terminated), different person on resume (held with before/after evidence), dim room (unable to verify → guidance → pass), multiple people, absence + face-return check, covered lens, browser events, 40 s offline (both sides see the interruption; events delivered late exactly once), reload/second browser, staff UI, time extension/expiry, degraded models, environment change as context only, accessibility walkthroughs, the resume confirmation screen, answers typed right after an approved pause, approved ID-photo comparison (advisory/required), retention purge + legal hold, key rotation with `rekey`, webhooks (signature, retries), email alerts (throttled digests) and the `/api/v1` integration flow.
* **Requirements audits (two rounds)**: independent read-throughs of the spec against the code with empirical verification against a running server using the real models; every P0/P1/P2 finding of both rounds fixed with regression tests (incl. a stale re-enrolment authorisation, an offline-queue blockage, answers typed in the seconds after an approved pause, false fullscreen/outage flags on the resume confirmation screen, and reports treating an unreturned browser as observed).
* **Security review** (+ follow-ups): IDOR/role checks on every route, CSRF, rate limits, decompression bombs, crypto, headers, SSRF, token leakage, dependency audit (`pnpm audit --prod`: clean). See `SECURITY.md`.
* **Load test** (`e2e/scripts/load-test.ts`) and profiling — on a 4-vCPU VM (Postgres and the load generator
  on the same box): 500 concurrent candidates with heartbeat p95 8 ms, answers/events p95 ≤ 14 ms, identity
  sample p95 96 ms, check-in frame p95 98 ms, zero errors; one instance sustains ~1,000 candidates
  (≈ 52 identity samples/s). Plan ≈ 250 candidates per vCPU; scale horizontally with Redis. Details and
  before/after profiles in `PERFORMANCE.md`.
* **Accuracy**: identity harness and behavioural-detector harness with committed baselines — see `accuracy/`.

## 4. Known limitations / before launch

1. **Accuracy on your population.** Baselines are a small public smoke set (identity) and synthetic traces (behaviour). Run the protocol in `accuracy/README.md` on consented, demographically diverse webcam data before relying on thresholds; tune per exam from the Quality page.
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

* Identity thresholds: match ≥ 0.45, mismatch < 0.28 (ID photo 0.42 / 0.24), 2 confirmations; calibrated on the smoke set (`accuracy/identity.md`).
* Policy defaults: liveness on (2 steps), periodic identity sample every 30 s, pause allowed with clock stopped, mismatch ⇒ hold for review, fullscreen required, clipboard blocked, evidence retention 30 days, event metadata 365 days, abandoned sessions closed after 30 days.
* Detection durations: absence 8 s, multiple people 1 s, look-away 5 s (28° yaw / 20° down), repeated look-away 5 in 120 s, obstruction 6 s, objects 2 s, frozen 6 s, covered 4 s, lighting 10 s.
