# Roadmap — what shipped, what is deferred and why

Status of the October 2026 roadmap carried by Masterchinedum/SmartProctoring#1 (branch
`claude/sweet-hamilton-46bh7e`). For the product as a whole see `HANDOVER.md`; for what to do before launch,
`HANDOVER.md` §4. Each item below has a row in `HANDOVER.md` §3b or §3c with what it does and where the code is.

## 1. Status

| # | Item | Status | Commit(s) | Described in |
|---|---|---|---|---|
| 1 | Node 24 only | Shipped | `2ae16fb` | HANDOVER §3b |
| 2 | Busy server: `Retry-After` from the queue's drain time, client spread, "server busy" wording; onnxruntime telemetry off | Shipped | `ee992aa`, `6440784` | HANDOVER §3b |
| 3 | Health probes that mean something (`live`, `ready`, `capacity`) | Shipped | `52281a8` | HANDOVER §3b, OPERATIONS §3 |
| 4 | Observability: Prometheus `/metrics`, alert rules, request ids | Shipped | `46067a9` | HANDOVER §3b, OPERATIONS §5 |
| 5 | Admission at exam start and load-aware sampling | Shipped, measured | `1ca0d00`, `42c6ebe` | HANDOVER §3b, PERFORMANCE §7.8 |
| 6 | CI that cannot go green by skipping (face images fetched, core e2e, Docker boot, nightly) | Shipped | `ef20067` | HANDOVER §3b |
| 7 | Exam versions, regrade, export / import | Shipped | `f945f34` | HANDOVER §3c |
| 8 | Accommodations | Shipped | `fdb02ab` | HANDOVER §3c |
| 9 | Staff two-step sign-in | Shipped | `7953a20` | HANDOVER §3c, SECURITY §2 |
| 10 | Reviewer workflow | Shipped | `7db31c2` | HANDOVER §3c |
| 11 | Model governance | Shipped | `f798846` | HANDOVER §3c |
| 12 | Privacy operations, incl. consent withdrawal in the exam app | Shipped | `70a67c8`, `fe3d72e` | HANDOVER §3c, PRIVACY §4–§5 |
| 13 | Scheduling windows, resume policy, reopen for recovery | Shipped | `80fcf2a` | HANDOVER §3c |
| 14 | Integration API maturity (scopes, expiry, idempotency, OpenAPI, contract tests) | Shipped | `e3ff7b4` | HANDOVER §3c, INTEGRATION_API |
| 15 | Sandbox organisations and per-tenant quotas | Shipped | `86ca253` | HANDOVER §3c, OPERATIONS |
| 16 | Single sign-on (OIDC + SAML 2.0) and SCIM 2.0 | Shipped | `2f3badc` | HANDOVER §3c, SECURITY §2, OPERATIONS §7 |
| 17 | Data residency (evidence storage locations, `storage:move`) | Shipped | `c2ffcfc` | HANDOVER §3c, OPERATIONS §2 |
| 18 | Dedicated vision worker | Shipped | `50dfea1` | HANDOVER §3c, PERFORMANCE §8 |
| 19 | Chaos tests, upgrade tests from every migration, schema drift check, metrics | Shipped | `8cc8d45` | HANDOVER §3c, OPERATIONS §5, §7 |
| 20 | Cross-browser e2e (Firefox, WebKit) | Shipped — Firefox (Linux) and WebKit (macOS) green in CI | `b00c7c0`, CI follow-ups `6191103`…`8dcc359` (app fixes `61c8eb7`, `e2afb6c`; Playwright 1.64.1 `f3125f2`) | HANDOVER §3c and §4 item 3, e2e README |
| 21 | This document, final verification, PR description | Done | (this commit) | §5 below |
| 22 | Optional exam recording (webcam, microphone, entire screen; off by default) | Shipped — Chromium e2e (19h); Firefox / Safari not tried | `035f2fd` (server), `d5d2646` (candidate), `5159c06` (staff playback, e2e), docs (the commit after) | HANDOVER §3c, PRIVACY §2a, OPERATIONS §2, ARCHITECTURE §6 |

## 2. Deferred, and why

Nothing on the roadmap was dropped. These are the parts of each item that were deliberately left out, with the reason.
The longer-standing limits (accuracy on your own population, dim rooms, look-alike relatives, capacity per vCPU,
liveness scope, phone detection) are in `HANDOVER.md` §4 and are unchanged by this roadmap.

| Item | Deferred | Why |
|---|---|---|
| 13 Scheduling | The check-in opening 30 minutes before the window is a constant (`CHECK_IN_LEAD_MS`), not a setting | No requirement for anything else yet; trivially made a per-exam setting later |
| 13 Scheduling | Assigning a candidate again with a window does not move their existing session | Rescheduling is its own audited action (session page, `PUT /api/v1/sessions/:id/window`); silently moving it on re-assignment would hide the change |
| 14 Integration API | Keys cannot be edited or extended | Rotation (create the new key, switch, revoke the old one) keeps every key's permissions and lifetime immutable and audited; the runbook describes it |
| 14 Integration API | Failed responses are not stored for `Idempotency-Key` (only successes are) | A retry after an error should be able to succeed; storing errors (Stripe's choice) makes a transient failure permanent for 24 h |
| 15 Sandbox | Self-service sandbox sign-up | Organisations are created by the operator (`org:create`); a public sign-up is a product and abuse-handling decision |
| 15 Sandbox | Monthly quotas reset per organisation's own time zone | Organisations have no time-zone setting yet; months are UTC months and the app says so |
| 15 Sandbox | An alert rule for organisations at their quota | Only the gauge (`sp_cluster_organizations_at_quota`) exists; whether that pages anyone is a business decision |
| 16 SSO | IdP-initiated SAML, encrypted assertions, signed AuthnRequests, single logout, SCIM Groups | Each widens the attack surface or the test matrix without a customer asking; SP-initiated SAML with signed assertions and SCIM `roles` cover Entra ID, Okta and Google Workspace |
| 16 SSO | DNS verification of claimed email domains | Needs an operator-facing verification flow; until then a domain is claimed first-come per server and public mailbox domains are refused (a residual risk on shared servers: SECURITY §2) |
| 16 SSO | A SAML scenario in the browser suite | SAML is covered end to end by server tests with a signing test identity provider; the browser suite covers OIDC (11f) |
| 16 SSO | Pilots against real Microsoft Entra ID / Okta / Google tenants | Needs the owner's tenants; runbooks are in OPERATIONS §7 (HANDOVER §4 item 5) |
| 16 SSO | The "Add user" form still asks for a password in organisations that use single sign-on | Small UI follow-up; SCIM or just-in-time accounts are the normal path there |
| 17 Data residency | Records and face templates stay in the one Postgres database; only images move | Full single-region residency needs one deployment per region (documented in OPERATIONS §2); moving rows between databases is a different product |
| 18 Vision worker | Multi-host scaling and absolute capacity measured on dedicated hardware | Measured on a shared 4-vCPU VM: the hop costs about 2–3 ms per frame; re-run `e2e/scripts/load-test.ts` on your hardware |
| 18 Vision worker | TLS between servers and workers built in | Plain HTTP by default with a shared token; put a TLS proxy in front of workers whenever traffic leaves a network you control (SECURITY) |
| 19 Resilience | Database failures answering 503 instead of 500 | The candidate app retries any 5xx; a 503 would make it tell candidates "many people are being checked" |
| 19 Resilience | Exactly-once heartbeat commands | A command lost with a response after commit is not resent; the session state in later heartbeats converges |
| 20 Cross-browser | The accessibility scan (14) and the PDF report check (11) in Firefox / WebKit | Both use Chromium-only Playwright features (the accessibility tree over CDP, `page.pdf()`); they test the app's markup and the server's PDF, not the browser |
| 20 Cross-browser | Dedicated-instance scenarios and the realistic accuracy scenarios (20–24) in Firefox / WebKit | They test server behaviour; the browser only drives it |
| 20 Cross-browser | Real Safari and Firefox with a real webcam (their camera prompts) | Playwright's WebKit is Safari's engine, not Safari; the CI camera is a canvas shim. One manual pass per browser before launch (HANDOVER §4 item 3) |
| 20 Cross-browser | WebKit on Linux (WebKitGTK) in CI | Playwright's WebKitGTK shows the camera shim's canvas in the app's video only for a while, then one frozen frame while the canvas keeps changing and the video keeps playing; change-driven and timer-driven capture both freeze, in WebKit 26.0 (4–6 of 10 passed) and 27.2 (3 of 10). The same app code passes on macOS, so it is the test camera's path, not the app; WebKit runs on macOS (§3) |
| 22 Recording | Recording e2e in Firefox / WebKit | Playwright cannot share a screen without the browser's picker there (Chromium has a launch flag); one manual pass per browser before an exam records on it (HANDOVER §4 item 3) |
| 22 Recording | One file per session (server-side joining or transcoding) | The server never decodes media (no ffmpeg, no CPU cost, nothing to exploit); the staff player plays the 30-second parts back to back and the export contains the parts with an index |
| 22 Recording | Watching while the exam runs | Parts arrive about 30 s late; the live dashboard shows the flags. The Recording tab already works on a running session (refresh for new parts) |
| 22 Recording | A download button for staff | Every viewing is audited per part; a downloaded file is not. Candidates' copies go through the privacy export (audited request) |
| 22 Recording | A storage quota per organisation | Only the per-session cap (`RECORDING_MAX_SESSION_MB`) and metrics; whether recording storage is billed or capped is a business decision |
| 22 Recording | Recording the identity check | Recording covers the exam only (start to end, not pauses or holds), which keeps what the notice promises simple |
| 20 Cross-browser | Fullscreen on iPhone | iPhone Safari has no element fullscreen, so an exam that requires fullscreen cannot be taken there; the welcome-screen system check says so |

## 3. Decisions made on your behalf

All are documented where the feature is, and all can be changed. These are the ones worth a conscious yes.

**Privacy (12)**
* Withdrawing consent ends the exam as `candidate_withdrew`: terminated, no score, images and templates deleted at once,
  `session.terminated` webhook with reason `consent_withdrawn`. The candidate-facing wording (notice version
  `2026-10-21`, "Your choices") needs counsel's review (HANDOVER §4 item 6).

**Scheduling and recovery (13)**
* An exam ended by the resume policy is **submitted and graded** (like a time expiry), not terminated; the default
  action is to hold it for staff instead.
* A reopened exam uses the re-verification check, not a reconnect check, so a resume limit of 0 cannot block it.
* `staff_submitted` exams can be reopened; a candidate's own submission never can.
* A recovery hold counts towards the held-exam review target, so the dashboard can show it overdue while the system is
  waiting for the candidate.

**Integration API (14)**
* Seven resource scopes with *Full access* / *Read only* presets; keys created without `scopes` get all of them, as before.
* `GET /api/v1/openapi.json` needs no API key (it holds no organisation data).
* Candidates' exam links (`accessLink`) need `assignments:write`.
* Idempotency is per organisation, not per key (a retry after a key rotation is still recognised).
* New keys default to full access and a one-year expiry in the staff app.

**Sandbox and quotas (15)**
* The exam quota counts drafts and published exams, not archived ones.
* The monthly session quota is a counter, not a count of rows: deleted sessions still count; counting starts at the
  upgrade.
* A refusal is `409 quota_exceeded`.
* The sandbox clean-up keeps exams, staff accounts, keys and webhooks, the privacy register and the audit log.
* Switching a sandbox back to production keeps explicit quota overrides (`--reset-quotas` clears them).

**Single sign-on and SCIM (16)**
* Owners may also sign in with single sign-on, so a compromised identity provider could sign in as an owner. Owners
  always keep password + two-step sign-in as break-glass, even when single sign-on is required.
* "Require two-step sign-in" applies to password sign-ins; after single sign-on the identity provider is responsible for
  the second factor.
* `email_verified` is required by default and can be switched off per provider (Entra ID needs that).
* Roles are set when an account is created at first sign-in and by SCIM; an existing account's role is not changed at
  sign-in.
* SCIM can create administrators, so only an owner can create the SCIM token.
* Transient SAML NameIDs are linked by email instead of by subject.

**Data residency (17)**
* The server refuses to start when a storage location that holds images is not configured. That fails fast at deploy
  time but takes every organisation down; the alternative is a warning and failing uploads for the one organisation.
* Storage locations are environment variables (`STORAGE_LOCATION_<NAME>_*`, one secret per variable); S3 locations
  need an explicit region and do not fall back to the default credentials.
* A new choice applies immediately on every instance: configure a location on every instance before an owner picks it.

**Vision worker (18)**
* Dedicated workers are opt-in (`docker-compose.vision.yml`); the default stays in-process.
* Worker threads default to every CPU (max 8) on a worker host.
* A worker's health probes need no token (they reveal readiness, thread count and an instance id).

**Resilience (19)**
* After a restart in which no sweeper ran, candidates get a technical `reporting_interrupted` event and, under the
  *stop* disconnect policy, the outage time back. Reviewers will see these after restarts; it is accurate, but new.
* A passed check's images are deleted before the row is marked purged (privacy first); a crash in between leaves a row
  without its image until retention runs.
* Alert thresholds are starting points.

**Cross-browser (20)**
* Firefox and WebKit run the ten core scenarios tagged `@cross-browser` on every pull request, not nightly only:
  Firefox on Linux (`e2e-browsers`), WebKit on macOS (`e2e-webkit-macos`, Safari's platform and Apple's media stack).
  The nightly run adds Chromium with the same camera shim, so a failure can be pinned on the shim or the browser.
* WebKit does not run on Linux in CI: Playwright's WebKitGTK stops showing the camera shim's frames in the app's video
  (§2). The scenarios still run in WebKit on every pull request, on macOS.
* Playwright 1.56.1 → **1.64.1** (Chromium 156, Firefox 157, WebKit 27.2). WebKit 26.0 of 1.56.1 crashed the staff page
  on a reload in 04: its Navigation API lost track of same-document entries, and `pushState`, `pushState`, back, reload
  crashed its web process on a bare page too (macOS and Linux). Safari 26.6.2 (checked on the CI runner through
  safaridriver) and WebKit 27.2 run the same sequences without a crash. `E2E_CHROMIUM_EXECUTABLE` lets a machine with
  another Chromium preinstalled (the Claude Code cloud sandbox: Chromium 141) run the suite; the core suite passes there.
* The `headturn` fixture holds the face frontal for 15 s instead of 10 s before turning (Chromium too): on a loaded
  machine the app sometimes finished calibrating after the turn had begun.
* In CI, Firefox runs headed under Xvfb (headless it has no WebGL on a runner without a GPU), WebKit headed on macOS,
  both one test at a time, and Firefox runs MediaPipe on its GPU delegate (`E2E_DELEGATE=gpu`; the app itself picks the CPU delegate
  on a software renderer, which starved headed Firefox).
* Two candidate-app changes came out of the first cross-browser runs: MediaPipe gets a regular canvas where an
  OffscreenCanvas cannot hold WebGL 2 (WebKitGTK browsers such as GNOME Web), and the hidden analysis video sits inside
  the viewport (2 px, transparent), because Safari on iOS (WebKit's autoplay policy) and Chrome on Android pause a muted video outside it.
* **Head-turn check (after the roadmap, `f850777`):** the browser takes a turn's pictures at 70 % of the server's target
  (14° of 20°) instead of the full target, with a live gauge on the preview (a dot moving into a green area). The server's
  liveness checks are unchanged (a turn passes when two frames reach 10° or one reaches 12°); a turn it does not accept
  is re-prompted 6° further, capped at 35°. This answered the former open question on the hardest realistic camera
  (`rwTurnA2_other`, a 16° turn that failed every attempt): it now passes at the first attempt, and the realistic still
  photos still fail. Measured on the three realistic turning-head cases, 6 runs each, capturing at 14° vs 20°: 18/18 vs
  12/18 passed, 16/18 vs 7/18 at the first attempt (the 480p camera in another room: 6/6 vs 0/6). The server's
  "Submitted frames are identical" rejection came up only at 20° (2 runs), so the smaller turn does not cause it.
* **Browser gates no stricter than the server (`8fcb344`):** the "look straight at the screen" step after the centre is
  known accepts the server's ±12° (it was 8°), and straight ahead may be up to the server gate's 30° (it was 25°, the
  earlier gate's limit) for the frontal pictures and the centre.
* `01-happy-path` now bounds the exam time used after a resume by the wall time since the server restarted the clock
  (its `session_resumed` event) instead of a fixed 6 s, which a slow browser reached without any clock error.

**Browser rules**
* **Single-display rule (after the roadmap):** per exam, off by default (the owner's decision). Decided on your behalf:
  a second display only *warns* on the welcome screen (consent and the check-in go ahead) and blocks the start on the
  ready screen and in the server; a browser that cannot tell (Firefox, Safari) is never blocked — the start, the report
  and the Devices tab record the unknown display count; the *Assistive technology* accommodation waives the rule (as it
  waives fullscreen); a display still connected when a released exam continues holds it again (no "allow for the rest
  of this exam" option); after a pause or reconnection the check-complete screen only warns before monitoring restarts.
  The candidate privacy notice is unchanged (it never listed the display count, recorded before as a neutral event);
  adding it needs a new notice version.

**Exam recording (22)**
* **Off by default**, per exam (exam rules → *Recording*: "Record the exam", "Record the microphone", "Record the
  screen"; the last two on once the first is). Exams that do not record are unchanged, wording included.
* **30-second parts.** Each part is a complete file (a new `MediaRecorder` starts before the previous one stops, so there
  is no gap and no part depends on another): a lost upload loses 30 s, not the recording, and a part is small enough to
  upload on a poor connection. Shorter parts mean more requests (two per candidate per 30 s already); longer ones mean
  more lost per failure.
* **Bitrates.** Webcam 640×480 at 15 fps, 350 kbps video + 32 kbps Opus sound (enough to see the room and the person
  and to understand speech; identity analysis keeps its own full-size frames). Screen at most 1280 px wide, at most
  5 fps, 300 kbps (text stays legible; a mostly still screen needs far less). Together about 300 MB per candidate per
  hour.
* **Codec order.** WebM VP8 + Opus first (cheapest to encode in software on older laptops, plays in every current
  browser), then VP9, then MP4 (Safari's recorder).
* **Webcam from a clone, microphone separately.** The recording scales a clone of the camera track, so face analysis is
  untouched, and opens the microphone with its own request, so exams that do not record never ask for it.
* **500 MB buffer on the device** (about 1.5 hours of both streams): a long connection loss loses nothing until then;
  beyond it the **oldest** parts are dropped and a `recording_interrupted` event (`device_storage_full`) says so, so the
  most recent part of the exam is kept.
* **24 hours for late parts** (`RECORDING_LATE_UPLOAD_HOURS`), only from the browser that was verified for the exam (its
  instance id, never another browser): a candidate who closes the laptop right after submitting can reopen the link the
  next day; after that the review is likely under way.
* **3,000 MB per session** (`RECORDING_MAX_SESSION_MB`, ≈ 10 hours of both streams), outside the image budget (1,500
  items / 300 MB), which recordings would otherwise exhaust in an hour.
* **Entire screen required where the browser says what was shared.** A window or a tab is refused (it would hide
  everything else). A browser that does not report it is accepted with a reminder: refusing it would lock those
  candidates out for a check the app cannot make.
* **Stopping the share covers the exam, the clock keeps running** (like "Return to fullscreen"), and records
  `screen_share_stopped` as a *potential integrity issue*, **low** severity, with the note that it can be accidental.
  It does not hold the exam.
* **Microphone check**: "heard" at ≥ 0.01 RMS (normal speech; the room's hum stays below); after 8 s of silence a
  warning ("We could not hear anything from your microphone yet…"), never a block; only no microphone or refused access blocks. A quiet room or a soft
  voice must not lock a candidate out, and a working microphone records sound either way.
* **No-camera arrangement**: no webcam and no microphone recording (the candidate was promised no camera); the screen
  is still recorded when the exam records it.
* **Its own notice version** (`2026-10-22-recording`): a consent to the notice without recording never covers a
  recording, so turning recording on after candidates agreed asks them again before they can start.
* **Recording stops at a pause and a hold** and starts again after the resume, like the camera.
* **Technical problems never block the exam**: they are `recording_interrupted` events (technical, low), retried three
  times; the candidate is told only when nothing at all can be recorded.
* **Audit per part opened from its start** (`recording.view`); the staff player fetches each part once, so a viewing
  is one entry per part, not one per seek.
* **Integrations get nothing**: no recordings, links or recording summary in webhooks or the integration API.
* **ZIP64** in the export writer, because an export with recordings can pass 4 GiB.

## 4. Open questions for the owner

1. **Dark rooms: the same guidance twice.** In a dark room the candidate can see the darkness guidance and "We couldn't
   confirm your identity…", which embeds the same guidance (`apps/web/src/candidate/monitoring/runtime.ts`). Show only
   the combined prompt?
2. **Domain claims on a shared server.** Is first-come domain claiming acceptable until DNS verification exists, or
   should claiming a domain need an operator's approval?
3. **Refuse to start vs degrade** when a storage location in use is missing (17, above).
4. **Owners and single sign-on** (16, above): allow, or password + two-step sign-in only for owners?
5. **Counsel review** of the privacy notice and the consent-withdrawal wording (HANDOVER §4 item 6).
6. **Counsel review of the recording notice** (version `2026-10-22-recording`) before any exam records (HANDOVER §4
   item 6).
7. **Recording choices** (22, above): is 24 hours right for late parts; should a no-camera candidate's screen be
   recorded; should a share that stays stopped for long hold the exam instead of only covering it?

## 5. Verification at the end of the roadmap

At the end of the roadmap (unit and browser suites on `fbf2e28`; the later commits change only the cross-browser test harness, the Playwright version, CI, documentation and one code comment; the core Chromium suite, 52 tests, passed again locally on Playwright 1.64.1):

* `pnpm run typecheck` (shared, detection, server, web) and the e2e typecheck: clean.
* `pnpm test`: **1,509 tests** — shared 64, detection 169, server 881, web 395 — all pass, with the face images present
  (`SP_REQUIRE_TEST_IMAGES=1`, nothing skipped).
* Browser suite in Chromium, **everything** (84 tests: the core scenarios 01–19 and the 32 realistic-webcam scenarios
  20–24), run locally on the integrated roadmap (`b00c7c0`): **82 pass**. The 2 failures were the realistic liveness case
  `rwTurnA2_other` (it failed the same way at `d4be596`); the head-turn change `f850777` fixed it (scenarios 03 and 23
  pass, 8 of 8).
* CI: `test` (typecheck + all unit tests), `docker` (image built and booted; a dedicated vision worker and a
  remote-driver server probed), `e2e` (core scenarios 01–19 in Chromium) and `e2e-browsers (firefox)` (the ten
  `@cross-browser` scenarios) and `e2e-webkit-macos` (the same ten in WebKit on macOS) **green** on Playwright 1.64.1.
  WebKit on the 3-vCPU macOS runners is not yet flake-free: of four runs on 1.64.1, three passed all ten; in one, 01 and
  10 failed while the candidate page's main thread stalled for up to 12.8 s (a click had no effect, a test timed out;
  MediaPipe also logged one WASM "out of bounds memory access" in WebKit).
* Not run here: the nightly workflow (it runs only from the default branch), real SMTP / S3 / identity-provider tenants
  (HANDOVER §4 items 5 and 10).
