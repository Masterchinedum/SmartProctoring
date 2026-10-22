# SmartProctoring end-to-end suite (`@sp/e2e`)

Real browser, real server, real models: Chromium with a **fake camera fed from Y4M videos**, the
server started from source with the built SPA on the same origin (production-like, `NODE_ENV=production`),
a fresh Postgres database, the server-side YuNet/SFace identity pipeline and the in-browser MediaPipe
monitoring engine. Nothing is mocked except the camera.

```bash
pnpm test:e2e                                   # from the repo root: the whole suite
pnpm --filter @sp/e2e exec playwright test tests/04-person-swap.spec.ts
pnpm --filter @sp/e2e exec playwright test -g "reconnect"
E2E_SKIP_BUILD=1 pnpm test:e2e                  # reuse apps/web/dist (faster when iterating on tests)
E2E_HEADED=1 E2E_WORKERS=1 pnpm test:e2e        # watch the candidate browsers (needs a display / xvfb-run)
pnpm --filter @sp/e2e fixtures                  # (re)build the fake-camera videos only
pnpm --filter @sp/e2e fetch-faces               # download the face photos (pinned commits, SHA-256 checked) to E2E_FACES_DIR
pnpm --filter @sp/e2e typecheck
E2E_NO_SKIP=1 pnpm test:e2e                     # a missing face image fails the run instead of skipping tests (CI)
```

CI (`.github/workflows/ci.yml`) runs scenarios 01–19 (including 11b–11e, 18b, 19b and 19c) on every pull request with `E2E_NO_SKIP=1`, so a green run
means every scenario ran; `nightly.yml` runs the whole suite, the realistic scenarios included.

Runtime (65 tests, 4-core machine): ~31 minutes with the default 2 workers — scenarios 01–18 (33 tests) take
~14 minutes; the realistic-webcam scenarios 20–24 (32 tests, incl. two 5-minute genuine-candidate runs) ~17 minutes.
The longest tests wait for real detections: a person swap, an absence, a 2-minute exam running out; scenarios 16–18
include their own server starts. Global setup adds ~15 s (plus ~1 minute the first time for the studio fixtures and
~10 minutes / ~5 GB for the realistic fixtures; `E2E_SKIP_REALISTIC=1` skips those).

## Prerequisites

* Node 24, `pnpm install` done, Chromium for Playwright 1.56.1 available (`PLAYWRIGHT_BROWSERS_PATH`;
  the suite never runs `playwright install`).
* Postgres reachable at `postgres://postgres@127.0.0.1:5432` (trust auth, like the server's unit tests).
  The database **`proctor_e2e` is dropped and re-created on every run** (global setup refuses to reset a
  database whose name does not contain `e2e`).
* Face images (see below). Without them the camera tests are **skipped** (not failed); the reviewer-role
  test still runs.

## What global setup does (`global-setup.ts`)

1. Builds the fake-camera fixtures into `e2e/.fixtures/` (only when missing or their definition changed).
2. Drops/creates `proctor_e2e`.
3. Builds the web app (`vite build` → `apps/web/dist`; skipped with `E2E_SKIP_BUILD=1` when `dist` exists).
   Type errors are left to `pnpm typecheck` — the e2e run tests behaviour.
4. Starts the server from source (`apps/server`: `tsx src/main.ts`) on port 8098 with
   `WEB_DIST_DIR=apps/web/dist`, `PUBLIC_URL=http://localhost:8098`, `BOOTSTRAP_ADMIN_*` (owner
   `owner@example.com`), fixed test `EVIDENCE_KEY` / `SESSION_SECRET`, `STORAGE_DIR` in a temp dir,
   `SWEEPER_INTERVAL_MS=2000`, and waits for `/api/health`. Log: `e2e/.artifacts/server.log`. The storage
   directory is passed to the workers as `E2E_STORAGE_DIR` (the retention spec runs the server's CLI against it).
5. Teardown stops the server (process group) and deletes the evidence directory.

**Dedicated server instances.** Specs that need a different server environment start their own instance
(`lib/server.ts`, same code path as global setup) with its own port, database and storage directory, so the main
server and the other specs are unaffected; they stop it in `afterAll`:

| Spec | Port | Database | Why |
|---|---|---|---|
| `18-integrations` | `E2E_PORT`+1 (8099) | `proctor_e2e_integr` | SMTP pointed at an in-process SMTP sink; an https webhook receiver (self-signed certificate in `e2e/.artifacts/tls`, trusted by the server through `NODE_EXTRA_CA_CERTS`; `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` because it listens on 127.0.0.1) |
| `17-retention-rekey` (key rotation) | `E2E_PORT`+2 (8100) | `proctor_e2e_rekey` | restarted three times with different `EVIDENCE_KEY` / `EVIDENCE_KEYS_OLD` |
| `11b-staff-mfa` | `E2E_PORT`+3 (8101) | `proctor_e2e_mfa` | its organisation requires two-step sign-in for everyone (must not affect the other specs' organisation); SMTP pointed at an in-process SMTP sink for the security emails |
| `11d-model-governance` | `E2E_PORT`+4 (8102) | `proctor_e2e_governance` | its organisation activates other identity thresholds (must not affect identity decisions in the other specs) |
| `11e-privacy-operations` | `E2E_PORT`+5 (8103) | `proctor_e2e_privacy` | the privacy register, deletion schedule and operational checks are organisation-wide (the other specs' sessions and legal holds must not show up) |
| `11f-sso-scim` | `E2E_PORT`+9 (8107) | `proctor_e2e_sso` | identity providers, claimed email domains and "require single sign-on" are organisation-wide; a fake OpenID Connect provider started by the spec over https (the suite's self-signed certificate, trusted through `NODE_EXTRA_CA_CERTS`; `SSO_ALLOW_PRIVATE_NETWORKS=true` because it listens on 127.0.0.1) |
| `19b-data-residency` | `E2E_PORT`+10 (8108) | `proctor_e2e_residency` | two evidence storage locations (`STORAGE_DIR` and `STORAGE_LOCATION_EU_*`, both temp directories); its organisation switches where new images are stored (must not affect the other specs' evidence) |
| `19d-sandbox-quotas` | `E2E_PORT`+8 (8106) | `proctor_e2e_sandbox` | its organisation is created by the operator CLI as a sandbox with small quotas (banner, refused creations, usage); the other specs' organisation must stay production without limits |
| `19e-server-restart` | `E2E_PORT`+12 (8110) | `proctor_e2e_restart` | the server process is stopped and started again in the middle of an exam (the other specs must not see the restart) |

All use `PUBLIC_URL=http://127.0.0.1:<port>` (a different host than the main server's `localhost`, so staff
cookies never mix), `NODE_ENV=production` and `VISION_THREADS=2`. Their databases are re-created by the spec
(names must contain `e2e`); logs: `e2e/.artifacts/server-integrations.log`, `server-rekey-{1,2,3}.log`, `server-mfa.log`, `server-governance.log`, `server-privacy.log`, `server-residency.log`, `server-sso.log`, `server-sandbox.log`, `server-restart.log` (both runs of the restarted instance).

**Dedicated vision worker (`E2E_VISION=remote`).** Global setup first starts one vision worker from source
(`tsx src/vision-worker/main.ts`, like `pnpm --filter @sp/server vision-worker`) on 127.0.0.1:`E2E_VISION_WORKER_PORT`
with as many analysis threads as an in-process server would use (CPU count − 1), waits for its `/health/ready`, and
gives every server of the run — the main one and the dedicated instances — `VISION_DRIVER=remote`,
`VISION_WORKER_URLS` and a fixed test `VISION_WORKER_TOKEN`; teardown stops it after the server. Log:
`e2e/.artifacts/vision-worker.log`. It is not the default (CI runs the in-process driver); use it to check the camera
scenarios through the HTTP hop, e.g. `E2E_VISION=remote … playwright test tests/01 tests/04`.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `E2E_FACES_DIR` | `/tmp/claude-0/faces` | Folder with the source face images (`pnpm --filter @sp/e2e fetch-faces` fills it) |
| `E2E_NO_SKIP` | — | `1` = a test whose face images are missing fails instead of being skipped, and global setup stops when a fixture cannot be built |
| `E2E_PORT` | `8098` | Port of the server started by global setup |
| `E2E_BASE_URL` | — | Test an already running server instead (no DB reset, no build, no server start) |
| `E2E_DATABASE_URL` | `postgres://postgres@127.0.0.1:5432/proctor_e2e` | Throwaway database (name must contain `e2e`) |
| `E2E_SKIP_BUILD` | — | `1` = reuse `apps/web/dist` |
| `E2E_WORKERS` | `2` | Parallel workers (each camera test launches its own Chromium) |
| `E2E_HEADED` | — | `1` = headed candidate browsers |
| `E2E_ADMIN_EMAIL` / `E2E_ADMIN_PASSWORD` | `owner@example.com` / `e2e-owner-password-1` | Bootstrap owner used by the tests |
| `E2E_SERVER_LOG_LEVEL` | `info` | Server log level |
| `E2E_DEBUG` | — | `1` = verbose liveness diagnostics (per-frame server verdicts) |
| `E2E_FACESETS_DIR` | `/tmp/claude-0/facesets` (or `SP_FACESETS_DIR`) | Public multi-image identity sets for the realistic webcam fixtures (`pnpm --filter @sp/server eval:fetch-faces`); without them scenarios 20–24 are skipped |
| `E2E_SKIP_REALISTIC` | — | `1` = do not build the realistic fixtures in global setup |
| `E2E_RW_ONLY` | — | Comma-separated realistic fixtures to build (e.g. `rwSwapGap,rwA_typical`) |
| `E2E_RW_REPEAT` | `1` | Repetitions of every realistic case (the measurement run for `docs/accuracy/end-to-end.md` uses 3) |
| `E2E_RW_LONG_MIN` | `5` | Minutes of the genuine-candidate long runs (scenario 22) |
| `E2E_KEEP_LOGS` | — | `1` = attach the server-log slice and candidate API logs to every test, not only failed ones |
| `E2E_VISION` | `local` | `remote` = face analysis in a dedicated vision worker process (below) instead of in each server |
| `E2E_VISION_WORKER_PORT` | `E2E_PORT`+40 (8138) | Port of that vision worker |

## Face images and fixtures

The face images are **never copied into the repository**. `pnpm --filter @sp/e2e fetch-faces` downloads them from
pinned commits of ageitgey/face_recognition and serengil/deepface (MIT) and checks each file's SHA-256
(`scripts/fetch-faces.ts`); it also fetches `obama_small.jpg` and `biden.jpg`, which the server's real-model tests read
from `SP_TEST_FACES_DIR`. Global setup reads them from `E2E_FACES_DIR`
and writes derived stills and videos to `e2e/.fixtures/` (gitignored):

| File in `E2E_FACES_DIR` | Used as |
|---|---|
| `obama.jpg` | candidate **A** (head-and-shoulders crop), the empty room (a crop of the background), A in a dim room (×0.44) and a dark room (×0.25) |
| `deepface/img30.jpg` | person **B** — a clearly different, frontal face |
| `two_people.jpg` | two people in view |
| `obama2.jpg` | approved ID photos of A (another photo of the same person): `id-a.jpg` (head-and-shoulders crop) and `id-a-poor.jpg` (the same crop as a 90 px wide JPEG at quality 5, scaled back up — accepted at upload, compares as *inconclusive*, similarity ≈ 0.32) |
| `deepface/img13.jpg` | approved ID photo of someone else (`id-other.jpg`; similarity to A ≈ 0.10) |

`biden.jpg` is deliberately not used as person B: his head is turned 22–29° depending on the crop, right
at the server's 25° pose gate, so the honest outcome for it is "unable to verify" (which the product
correctly does), not the dependable different-person evidence the swap scenarios need.

Fixtures (`lib/fixtures.ts`; times are seconds since the camera started):

| Fixture | Timeline |
|---|---|
| `a`, `b` | A (resp. B), steady |
| `swap` | A 0–60, then B |
| `two` | A 0–50, A + second person 50–70, then A |
| `absence` | A 0–50, empty room 50–66, A 66–91, covered lens (black) 91–105, then A |
| `aDim` | A in a dim room (×0.44: brightness ~65, contrast ~17 — refused by identity v1, usable since webcam-v2.0) |
| `darkThenLight` | A in a dark room 0–30 (×0.25: below the server gate's minimum brightness), then lit |
| `darkPeriod` | A 0–50, dark room 50–90, then A |
| `headturn` | A frontal 0–10, then cycles of turning left / right (`scripts/synth-headturn.ts`: synthetic nose-vs-eyes parallax + head translation) for the *passing* active-liveness path |

**Using your own images:** point `E2E_FACES_DIR` at a folder with the same file names (or edit the
`STILLS` crops in `lib/fixtures.ts`). Requirements: A and B frontal (|yaw| < ~15°), well lit, one face each,
clearly different people (SFace similarity < 0.28); the two-people image with two ~frontal faces; the
room crop must contain no face. Fixtures rebuild automatically when a source image or definition changes
(`e2e/.fixtures/manifest.json`).

How the fake camera behaves (and how the tests rely on it):

* Chromium plays the Y4M from frame 0 **every time the camera is opened** and loops at the end. The
  candidate app opens it at the camera check and keeps it open through the exam; pausing, a hold, or
  closing the page stops it. Timelines above are therefore relative to the camera check, and tests assert
  e.g. "check-in finished before B appears".
* The file-backed device's label is Chrome's fake capture device, which the monitoring engine reports as a
  possible virtual camera (`camera_feed_suspect`, integrity). A still image also yields pixel-identical
  identity samples, which the server flags the same way. Both are **expected** in every session.
* A camera fixture is a Chromium launch argument, so every camera test launches its own browser
  (`lib/candidate.ts` → `launchCamera`); new contexts in that browser share the same camera.

## Realistic webcam fixtures (scenarios 20–24)

The studio fixtures above are sharp, well-lit 640×480 photos — the product owner's real laptop webcam produced
failures they never showed. `lib/realistic.ts` defines fake-camera videos made from what a laptop webcam actually
delivers, built by `scripts/make-realistic.ts` (global setup builds missing / outdated ones, ~10 min the first time,
~5 GB in `e2e/.fixtures/realistic`, gitignored):

1. Source photos come from the public identity sets (`E2E_FACESETS_DIR`, never copied into the repository).
   Candidate **A** = deepface `p03` (`img47` on exam day; `img8` "another day": hair down, smiling, other make-up);
   **B** = `rose_leslie img2` (a plausible look-alike: same gender and colouring, SFace 0.25–0.36 to A's photos);
   **family**: Azure Face `Family1-Son1` (candidate) and `Family1-Dad3` (his father).
2. The vision team's simulator (`apps/server/src/eval/webcam-sim.ts`) renders each person in a room under a
   condition — auto-exposure, sensor noise, optics / NR blur, colour cast, JPEG — at the camera's resolution. Scenes
   (`RW_SCENES`): `home` (laptop webcam 1280×720, inter-eye 75 px), `home480` (the same at 640×480) and `other` (another
   room + a USB webcam 640×480, inter-eye 39 px). Scene seeds were chosen so every simulator parameter sits near the
   middle of its range. Per condition (home scene): good = face luma 139, noise σ 2.3; typical = 106 / 4.7, blur 1.0 px,
   JPEG 84; **dim = face luma 54, noise σ 9.4, blur 1.5 px, JPEG 79** (the server measures brightness ≈ 50, contrast
   ≈ 8); backlit = 61 / 6.3 with a bright window; side-lit = 99 / 5.3 with a 0.18 dark/bright side ratio.
3. The builder composes a timeline from those renders: a head-and-shoulders person layer (webcam-sim's own mask
   geometry, located by YuNet) over the exposure-matched empty room, with continuous sway (a few px), short glances
   (±5–8° head turns), standing up and leaving, sitting down, 0.5 s cross-dissolves (lighting changes, no-gap swaps),
   sliding out / in, and synthetic head turns for active liveness (the nose-vs-eyes parallax warp of
   `synth-headturn.ts` applied to the SOURCE photo before simulation). Fresh noise on every frame; 5 fps.

Chromium's file camera delivers the Y4M's own size (a 1280×720 file gives the app a 720p track like a laptop
webcam; 640×480 a VGA track) — checked in every run (`camera` column of the metrics).

| Fixture(s) | Timeline |
|---|---|
| `rwA_{good,typical,dim,backlit,sidelit}`, `rwB_*`, `rwA_typical480`, `rwA_dim480`, `rwB_typical480`, `rwSON_typical`, `rwDAD_{typical,dim}` | one person, one condition, 6 s seamless loop with sway |
| `rwA_typical_later` | the same shot at another moment (other noise / jitter, sway phase) — resume without replaying the check-in frames |
| `rwA2_{typical,dim,backlit}`, `rwA2_other_{typical,dim,sidelit}` | A on another day (other photo) at home / in another room with another camera |
| `rwSwapGap` (720p), `rwSwapGap480` | A 0–35 s; stands up and leaves (0.8 s), empty room 1 s, B sits down (0.8 s, fully in view at 37.6 s); B for 45 s |
| `rwSwapBlend` (720p), `rwSwapSlide480`, `rwSwapDimBlend480` | no gap: 0.5 s cross-dissolve / A slides out while B slides in (both half in view) / cross-dissolve in a dim room |
| `rwFamilySwap` (720p), `rwFamilySwapBlend480` | the son (candidate) replaced by his father, with / without a gap |
| `rwGenuineLong` | A for 90 s (loops): typical → dim → typical → side lamp → typical, sway + glances |
| `rwGenuineDim` | A for 60 s (loops), mostly dim, desk lamp and window light in between |
| `rwTurnA_typical`, `rwTurnA_typical_later`, `rwTurnA_dim`, `rwTurnA2_other` | frontal 8 s, then 3 cycles of turning left / right (±~20°) |

Measurements: every realistic test appends one JSON line to `e2e/.artifacts/realistic-metrics.jsonl` (tagged with
the run id); `pnpm --filter @sp/e2e rw:report [-- --run <id> | --all]` prints the tables used in
`docs/accuracy/end-to-end.md`. Typical measurement run:
`E2E_RW_REPEAT=3 pnpm --filter @sp/e2e exec playwright test tests/2[0-4]-realistic-*`.

## Scenarios

| # | Spec | What is verified |
|---|---|---|
| 1 | `01-happy-path` | privacy notice + consent → readiness all green → reference → start → every question type → pause (clock stops) → page closed → reopened in a new context → resume check → answers, current question, remaining time preserved → submit → report: active/paused(unobserved)/active periods, identity checks, score 5/8; report page |
| 2 | `02-pause-rules` | reason required; approval required (request shown live on the dashboard, **denied** then **approved in the admin UI**), `timerBehavior: 'continue'` (clock runs during the pause) |
| 3 | `03-liveness-photo` | active liveness with a still photo: stuck at the head-turn step → attempt handed to the server → retry guidance → second attempt → held as *identity unverifiable* (never "different person"); failed attempts visible to staff. **3b:** a (synthetically) turning head passes active liveness at check-in and at resume. **3c:** a tampered client submitting the photo for every step and lying about its pose is rejected by the server's own pose measurement |
| 4 | `04-person-swap` | A→B mid-exam: `identity_mismatch` after confirmation, hold screen; flag arrives live on the dashboard; comparison view (reference vs later images); release with fresh check (camera restarts → A → passes); terminate in the UI |
| 5 | `05-resume-identity` | **a:** resume by B → held with before/after evidence, pause in context, evidence JPEGs; **b:** resume in a dim room (refused by identity v1) → passes at the first attempt, never a mismatch; **b2:** resume in a dark room → server guidance → retry screen → light on → passes, never a mismatch; **c:** dark room mid-exam → uncertain `lighting_unusable` + candidate guidance, identity matches again when lit |
| 6 | `06-multiple-people` | one `multiple_people` event (start/end) with a screenshot from that moment; evidence JPEG for staff (audit-logged), 401 without staff auth; identity re-check afterwards |
| 7 | `07-absence-covered` | one `candidate_absent` with start/end + `face_return` identity check (match); one `camera_covered` |
| 8 | `08-browser-events` | two tab switches → two `tab_hidden` events with start/end (the preceding blur is not a separate event); fullscreen exit → one `fullscreen_exited`, closed when the candidate returns via the overlay |
| 9 | `09-offline` | ~40 s offline: candidate banner; dashboard shows disconnected + "Reporting interrupted since"; afterwards the tab switch made offline arrives with its original timestamps, `deliveredLate`, exactly once; answers typed offline are saved |
| 10 | `10-reconnect` | reload → reconnect check → same question/answers; `disconnected` (unobserved) gap in the timeline; second browser supersedes the first ("continues in another window"); `?trace=1` evaluation trace download |
| 11 | `11-staff-ui` | UI login; dashboard groups + status tabs + monitoring labels; live flag without reload; event drawer with screenshot + lightbox; why the event was recorded (explanation), a structured decision (*Integrity concern*) with a note and its decision history, event note, a *False detection*; filters (category, only unreviewed, type); session note; CSV download; report sections, print button, print stylesheet, PDF; reviewer cannot see/open Settings, Users (UI and API 403) |
| 11b | `11b-staff-mfa` | dedicated instance with an SMTP sink. **a:** an administrator sets up two-step sign-in on *Account & security* (QR code and key; a code computed from the displayed key like an authenticator app; 10 recovery codes shown once, *Done* only after "I have saved my recovery codes"; security email) → signs out → signs in with a recovery code ("I don't have my phone"; 9 left) → signs out → a wrong code is refused with guidance, a code from the next 30-second step signs in. **b:** the owner (two-step sign-in on through the API) requires it for everyone: a reviewer signing in gets only the set-up page (API 403 `mfa_enrollment_required`) until set up, then the dashboard; the owner resets the reviewer's two-step sign-in on the Users page (confirmation, *On* → *Off*, email naming the owner) → the reviewer's open page is signed out and the next sign-in leads to set-up again |
| 11c | `11c-review-workflow` | a candidate takes the exam (fake camera, camera-integrity checks off); flags are reported through the candidate API at planned times (with the browser's own credentials and User-Agent), forming two incidents and a separate flag with a screenshot. **Reviewer:** the exam is in the review queue with its flag target → *Assign to me* → *Assigned to me* → session *Review* tab: one incident decided together (*Accurate, no concern*, note), the technical / low-severity flags in bulk (*Technical problem*), the separate flag in the drawer after its explanation ("Recorded when the object detector finds a book…", "Seen in 4 of 8 detector runs") and *Compare with the start of the exam*; any flags the live detectors raised are decided; *Escalate…* with a reason → "an administrator resolves it". **Owner:** the escalated queue lists it; changing the reviewer's phone decision needs a reason (button disabled until given) and the history shows the disagreement; resolves *No integrity concerns* → *Review completed* in the timeline, the outcome and incidents in the report, the disagreement on the Quality page, and `review.escalated` / `review.resolved` in the audit-log CSV |
| 11d | `11d-model-governance` | **dedicated server instance** (activated thresholds must not affect the other scenarios). Identity decisions seeded for one exam (Safari, 480p, several lighting levels): *Identity decisions by condition* by browser / resolution / version, *No drift detected*. **Owner:** v1 active (release defaults) → *Propose new thresholds…*: an inconsistent mismatch threshold is refused in the form, the change summary shows *Mismatch threshold 0.3 → 0.26*; the proposal shows the preview ("Of 5 identity samples … 1 (20.0 %) would be labelled differently: 1 different person → inconclusive"); approving their own proposal is refused (another administrator exists). **Second administrator:** approves with a note → *v2 active*, v1 retired; Settings shows *Version 2* read-only and `PUT /settings` with thresholds answers 409 `decision_config_required`. **Owner:** *Restore…* v1 with a reason → *v3 active, restores v1*; the audit log has proposed → approved → rolled back. Accessibility checked with the dialog and the proposal open |
| 11e | `11e-privacy-operations` | **dedicated server instance.** Two candidates check in (fake camera *a*). One withdraws consent during the exam from the privacy notice (*Withdraw my consent…* → confirmation disabled until "I understand" is ticked, reason given, accessibility checked): the candidate page ends with "You withdrew your consent", every image of the session answers 410, and the register shows *Consent withdrawn* "made in the exam app" with the reason. **Owner, Privacy page:** operational checks; *Record a request…* (access, linked to the other candidate found by search, received by letter) → the request opens → *Export the candidate's data (ZIP)* downloads `personal-data-Erin-Export-<date>.zip` with `README.txt`, `candidate.json`, the session folder and real JPEGs; `exportedAt` set; completed with a resolution. An erasure request: *Erase the candidate…* refused under legal hold (the deletion schedule lists the hold and the retention job's run at start); after the hold is lifted it erases the candidate (404), its images and its session; both requests stay without the candidate. Audit log: created, exported, completed, erased, consent withdrawn. Accessibility checked on the page and both dialogs |
| 11f | `11f-sso-scim` | **dedicated server instance** and a fake OpenID Connect provider (https) started by the spec. **a:** the owner adds the provider in *Settings → Single sign-on* (name, email domain, issuer, client id / secret, accounts created at first sign-in, enabled): the redirect URI is shown, *Test connection* → "Connection works.", the secret never comes back from the API; *Create SCIM token* shows the token once. **b:** a new staff member chooses *Sign in with your organisation*, enters their work email and is signed in through the provider (PKCE S256, login hint) without a local second step — created at first sign-in as a linked reviewer; the account page says they signed in with single sign-on; a sign-in refused at the provider (`access_denied`) and an address no provider claims each come back with a plain message. **c:** SCIM creates an administrator, who signs in with single sign-on (Settings link visible); a SCIM PATCH in Microsoft Entra ID style (`"op": "Replace", "path": "active", "value": "False"`) signs their open page out, single sign-on then says the account is disabled, and the Users page shows *Disabled* / *Linked* / *SCIM*; the audit log names *SCIM provisioning*. **d:** the owner requires single sign-on (confirmation dialog): an administrator's password sign-in is refused with guidance and switched to single sign-on; the owner still signs in with a password (break-glass). Accessibility checked on the provider dialog, Settings and the sign-in page's single sign-on step |
| 12 | `12-extend-expiry` | 1-minute exam + 1 minute added in the admin UI → candidate clock jumps without reload → expiry auto-submits (`time_expired`), answers graded |
| 13 | `13-degraded-and-context` | (folded in from the candidate app's drafts) vision models unavailable → the exam still runs, `monitoring_degraded`; resume from another seat on the same browser → match + neutral `environment_changed` only; manual staff hold → release without a new check → continues |
| 14 | `14-accessibility` | WCAG 2.1 AA checks with the in-repo checker `lib/a11y.ts` (Chromium's accessibility tree over CDP: accessible names, landmarks, `<h1>`, lang/title, id references, text contrast). **a:** keyboard-only candidate walkthrough — consent → camera check → start → every question type → question navigation → submit / privacy / pause dialogs (focus moves to each new heading, dialogs trap focus and return it, Escape, inert background, error tied to its field, countdown announced at the 10-minute mark only, 320 px reflow); staff: new flag announced (rate-limited), status tabs, session tabs, events row → drawer, reference image → viewer (arrows, Escape). **b:** phone-sized screen without a camera → friendly notice, consent still possible, reflow, reduced motion; staff sign-in page. **c:** every staff page passes the checker (titles, skip link). See `docs/ACCESSIBILITY.md` |
| 15 | `15-resume-continue` | **a:** `requireFullscreen`: pause → browser closed → reopened → resume check passes → 25 s on "Check complete" (longer than the heartbeat timeout and a paused-state poll): the session stays online (heartbeats, label "waiting for the candidate to continue"), no `reporting_interrupted`, and no `fullscreen_exited` before or after the click that enters fullscreen and starts monitoring. **b:** pause with approval: an answer typed after staff approved (heartbeats held back, the server refuses it with 409) is kept, re-sent after the resume in the same page and graded |
| 16 | `16-id-photo` | approved ID photo uploaded in the staff UI (an image without a face is refused with guidance and nothing stored) and compared at check-in. **Advisory:** same person → neutral `id_photo_compared` (match); a different person → `identity_mismatch` against the ID photo (high, with the compared photo and the check-in image as evidence) and the exam continues; comparison view shows the ID photo vs the check-in image with the ID-photo thresholds (0.24/0.42). **Required:** same person proceeds; a different person is held before the exam starts (`id_photo_mismatch`, candidate message, camera released); a poor photo of the same person compares inconclusive → held as `id_photo_unverifiable` ("not a finding that you are a different person"), never an `identity_mismatch` |
| 17 | `17-retention-rekey` | **a:** two submitted sessions (exam retention 1 day) moved 2 days into the past; one placed under legal hold in the UI → `pnpm --filter @sp/server retention:run --dry-run` deletes nothing → `retention:run` purges the other (every evidence URL incl. the compared ID-photo copy → 410 `evidence_purged`; Identity tab, event drawer and comparison view show "Deleted under the retention policy on …"; events kept; the candidate's ID photo on file kept; `retention.purge` audit entry) and keeps the held one; hold lifted → next run purges it. **b:** dedicated instance: data under key K1 (evidence, reference and check-frame templates, ID-photo templates, access links, webhook secret) → restart with `EVIDENCE_KEY=K2`, `EVIDENCE_KEYS_OLD=K1` → `rekey --dry-run` (exit 3, every target listed) → `rekey` (exit 0, "no longer needed") → restart with K2 only: evidence bytes unchanged, access links unchanged, webhook test signed with the original secret, resume check against the reference passes, a new check-in matches the ID photo |
| 18 | `18-integrations` | dedicated instance with SMTP + https webhook receiver. **a:** Integrations page: API key (shown once), webhook (secret shown once), "Send test" → ping verified with the function copied verbatim from `docs/INTEGRATION_API.md` (wrong secret, altered body, stale timestamp rejected), alert recipients saved, test email received. **b:** `/api/v1` with that key: 401 without it, candidate upsert by `externalId`, idempotent assignment, the candidate takes the exam (ID-photo mismatch, tab switch, staff hold/release, submit); webhooks `event.created`, `identity.mismatch`, `session.held`, `session.released`, `session.submitted` (score) signed, without images, details or similarity; a delivery answered HTTP 500 is retried after ~30 s with the same delivery id (attempt 2) and shows "Delivered 2/10" in the UI; first alert email at once, a later alert of the same session (the staff hold) waits for the 5-minute window and arrives in one combined email, another session's hold is emailed at once; emails without images or scores; session, report and events via `/api/v1` without evidence URLs or similarity scores |
| 18b | `18b-integration-api` | main server (the keys it creates are revoked at the end). **Integrations page:** a *Read only* key expiring in 30 days, and a key with chosen permissions (create candidates, read exams) expiring on a date in 10 days — validation ("Choose at least one permission", "Choose a date"), the Access / Expires columns, "Expires in 10 days" and the expiry banner, the `openapi.json` link; accessibility checked with the permissions form open. **`/api/v1`:** `openapi.json` without a key equals `docs/openapi.json` (apart from `servers`); the read-only key reads but `POST /candidates` is 403 `insufficient_scope` (`WWW-Authenticate`); the roster key's `POST /candidates` with an `Idempotency-Key` is replayed (`Idempotent-Replayed: true`, same candidate, created once) and refused with another body (422); it cannot list candidates or sessions (403). **Expiry:** the read-only key moved past its expiry in the database → 401 `api_key_expired`, shown as *Expired* with the banner, and Privacy → operational checks *API keys — Failing* ("expired while still in use"); both keys revoked (one through the UI) |
| 19 | `19-accommodations` | **a:** extra time (+50 %) and "identity verified by staff" added on the candidate page in the staff UI → the candidate sees both on the welcome screen with the longer duration; the check needs only a working camera (no face check) and ends on a `staff_verification` hold; a reviewer verifies the identity in the session page (method, note, confirmation) → the candidate starts; no identity picture is ever sent; the session lists the accommodations and the rule changes. **b:** "no camera": a browser without a camera — no camera step, no camera opened, monitoring label "No camera (approved arrangement)" — after staff verification |
| 19b | `19b-data-residency` | **dedicated server instance** with two storage locations (default directory and "EU (Frankfurt)"). A candidate checks in and submits: images in the default directory. **Owner, Settings → Where evidence images are stored:** what is and is not stored there (face templates stay in the database), "Stored now: N images in Default storage", switches to *EU (Frankfurt)* (change note, accessibility checked) and saves → "Saved…", the earlier images "are still stored in Default storage … until your server operator moves them"; `settings.updated` audit entry with `evidenceLocation` from/to. A second candidate checks in: its images are in the eu directory only; staff see the images of both. `pnpm --filter @sp/server storage:move --org <id> --to eu --dry-run --json` (exit 3, counts) → `storage:move` (exit 0, every earlier image moved, same bytes for staff, nothing of the organisation's sessions left in the default directory) → re-run moves nothing; `evidence.storage_moved` audit entry; Settings shows every image in EU (Frankfurt) |
| 19c | `19c-scheduling-recovery` | **a:** an exam assigned in the staff app with a scheduling window three hours ahead (an inconsistent window is refused in the form): the candidate's link shows "This exam is not open yet" with the opening, the check-in time and the time zone (no camera opened, accessibility checked); staff *Reschedule…* on the session page to open now (dialog checked, note on the timeline) → "Check again" → consent, check-in, start. **b:** the policy editor's *Interruptions and recovery* set to no reopening in a new browser window: after a reload the reconnect check is refused and the exam goes on hold (*Interrupted more often or longer than the exam rules allow*); staff end it → the candidate sees it ended; *Reopen for recovery…* (reason required, minutes, how it ended, accessibility checked) → recovery banner; the candidate reloads, sees "Your exam has been reopened", passes the identity check and continues with the answer kept; the timeline shows *Exam reopened for recovery*. Main server (exam-level rules only). |
| 19d | `19d-sandbox-quotas` | **dedicated server instance.** The operator creates a sandbox organisation with `pnpm --filter @sp/server org:create --kind sandbox --json` (temporary password for the first owner) and lowers its limits with `org:set` (3 candidates, 2 exam sessions a month). Its owner signs in: every page shows "Sandbox — data is deleted after 14 days; not for real candidates." (accessibility checked); a fourth candidate is refused in the dialog with the plain message (nothing created); assigning three candidates is refused ("This would create 3 exam sessions, but only 2 more can be created this month…", with the UTC reset date; nothing created), two are assigned; the candidate's welcome screen shows *Practice environment* (accessibility checked); Settings → *Usage and limits* shows 1 of 5 exams, 3 of 3 candidates and 2 of 2 sessions with *Limit reached* warnings; `org:list` shows the bootstrap organisation still production |
| 19e | `19e-server-restart` | dedicated instance, restarted mid-exam (disconnect policy `stop`): the candidate keeps answering while the server is down ("Live reporting is interrupted", answers saved on the device); after the restart the page carries on without a new check, the answers typed during the outage reach the server once; the timeline has exactly one `reporting_interrupted` from the last heartbeat before the stop to the browser's return (closed by `heartbeat_resumed`), and the exam clock did not run during it (time used = wall time − outage) |

| 20 | `20-realistic-resume` | Candidate A checks in at home (720p, typical light), pauses, closes the browser; resumes from a new profile in typical light (other frames), dim, backlit, side-lit, VGA dim, and on **another day** (another photo of A) at home and in another room with another camera — liveness off and on. Measured: attempts, time from "Resume" to the outcome, re-prompts, resume-check decisions. Asserted: never held / never `identity_mismatch` for A, passes within 5 attempts, first attempt in typical / dim (soft). Impostors resume (B in typical / dim / backlit; the son resumes his father's exam): never passes |
| 21 | `21-realistic-swap` | Quick swap 5 s after the exam starts: gap (leave → sit down within 2.6 s) and no gap (cross-dissolve / slide), 720p and 480p, dim, family (father replaces son). Measured: held as `identity_mismatch`, delay from "new person fully in view" to the hold screen, samples after the swap. Asserted: no finding before the swap, held before the video loops back (45 s); family: held, or at least `suspect` + non-matching checks visible to staff |
| 22 | `22-realistic-genuine` | A for `E2E_RW_LONG_MIN` (5) minutes with lighting changes (dim, side lamp, window), sway and glances; a mostly-dim variant. Asserted: zero `identity_mismatch`, no hold; recorded: samples, decisions, lowest similarity, `identity_unverifiable` |
| 23 | `23-realistic-liveness` | Active liveness (default 2 steps) with realistic head turns in typical, dim and another room / VGA camera: pass, attempts, time, re-prompts. A still photo (typical, dim) never passes: held as *could not verify*, never a mismatch |
| 24 | `24-realistic-camera-test` | Staff *Camera & identity test* page with the `rwSwapGap` camera: enrol A, live comparison of A (consistent), then B sits down (suspect → confirmed); states and timings recorded |

## Diagnosing failures

* A failed test gets `server.log` (the main server's log lines written during the test; with 2 workers the other
  worker's lines interleave — filter by session id) and `candidate-<n>.log` (every candidate page's identity API
  answers: check frames with quality / measured pose / progress, check completes with outcome / liveness reasons /
  guidance, identity samples with decision / similarity / evidence state) as test attachments in
  `e2e/test-results/<test>/`. `E2E_KEEP_LOGS=1` attaches them to passing tests too.
* Global setup keeps the previous runs' server logs as `e2e/.artifacts/server-<time>.log` (newest 8) instead of
  overwriting `server.log`.

## Known limits

* **Phone / object detection is not covered**: there is no suitably licensed image of a phone in the
  test image set. Looking-away and unusual-movement detectors are covered by the detection package's
  own scenario harness, not here (still images cannot look away convincingly).
* **Tab switching is simulated in the page** (`visibilitychange` with an overridden
  `document.visibilityState`, preceded by `blur`): Playwright's Chromium (headless and headed) keeps every
  page visible and focused when another tab or window is brought to the front. Fullscreen is real.
* **Active liveness passing path uses a synthetic video** (`scripts/synth-headturn.ts`), tuned to the
  server's parallax and anti-replay rules; it is a test of the pipeline, not of liveness accuracy (see
  `docs/accuracy/`). The realistic head turns (scenario 23) use the same warp before the webcam simulation.
* **Realistic ≠ real.** Scenarios 20–24 use simulated webcam frames of public photos (one source photo per person
  and day, so no real expression / pose change within a session), cut-out people over a synthetic room, and
  synthetic head turns. See `docs/accuracy/end-to-end.md` for what the numbers can and cannot tell.
* **Time is moved, not waited for**, in two places: the retention spec moves the sessions' end time 2 days back
  (evidence retention is at least 1 day), and the integrations spec moves the previous alert email's send time
  5 minutes back to see the combined email without waiting for the throttle window.
* Email alerts go to an in-process SMTP sink (plain SMTP, no TLS/AUTH) and webhooks to a local https receiver;
  deliverability through real providers (SPF/DKIM, TLS) is not covered.
* Single sign-on runs against a fake OpenID Connect provider started by scenario 11f, not a real Microsoft Entra ID /
  Okta / Google tenant; SAML 2.0 is covered by the server tests (a test identity provider signing assertions), not by a
  browser scenario.
* The login endpoint allows 10 attempts/min per IP, so the staff API client logs in once per worker and
  staff pages reuse its cookie; only the UI-login tests type a password.
* Test artifacts: `e2e/test-results/` (trace + screenshot on failure), server log in `e2e/.artifacts/`.
  Playwright traces cover the staff contexts only; candidate browsers are launched separately (the camera
  file is a launch argument), so their failures are diagnosed from the screenshot, the server log and the
  staff API state the tests assert on.
* Every candidate page records the camera tracks it opens (init script), and the tests assert that the
  camera is actually released while paused / on hold (`CandidatePage.liveCameraTracks()`).
