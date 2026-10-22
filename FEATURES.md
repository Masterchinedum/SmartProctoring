# SmartProctoring — features and test guide

This file has three parts:

1. **Part 1 — What the app does.** Every feature, in plain language.
2. **Part 2 — Test checklist.** Steps to try each feature yourself and what you should see. Tick the boxes as you go.
3. **Part 3 — What needs extra setup.** Features that need an outside service before they can be tested.

Labels in quotes ("Start exam") are the exact words on the screen.

---

## Before you start

### Where to test

| What | Address |
|---|---|
| Staff app (your side) | http://localhost:8080/admin |
| Candidate exam links | http://localhost:8080/take/… (created when you assign an exam) |
| Health check | http://localhost:8080/api/health |

This is your Docker copy (`docker compose up -d --build`). It runs in production mode. Screenshots and face images are
saved, encrypted, in your Cloudflare R2 bucket.

**Your owner login:** the email is `BOOTSTRAP_ADMIN_EMAIL` in `.env` (currently `owner@example.com`), and the password is
`BOOTSTRAP_ADMIN_PASSWORD` in the same file.

### What you need

- **Chrome with a webcam** for the candidate side. Allow the camera when asked. On macOS, also allow Chrome under
  System Settings → Privacy & Security → Camera.
- **A second browser for the staff side** (this guide assumes **Edge**; Safari or Firefox work too), so the staff and
  candidate sides never share a window or a sign-in. An *InPrivate window* in Edge (⇧⌘N) is handy when you need a
  second staff account at the same time.
- **An authenticator app on your phone** (Google Authenticator, Microsoft Authenticator, 1Password…) for two-step
  sign-in.
- **A photo of your face** on your phone screen or printed, for the "photo held up to the camera" test.
- **A second person** (a friend or family member) for the "another person" and "different person" tests.
- **A lamp you can switch off** or a dim room, for the lighting tests.

### One thing to expect

The candidate side records what happens on the exam page. Each time you switch from the candidate window to the staff
window, the candidate side records "Exam window lost focus" (after 2 seconds). If fullscreen is required, it also
records "Left fullscreen" and covers the exam with "Return to fullscreen". **This is correct behaviour, not a bug.**
That's why the checklist uses a second exam with fullscreen off for tests where you want to watch both sides at once.

### Staff roles

| Role | Can do |
|---|---|
| **Owner** | Everything, including managing administrators, the two-step sign-in requirement, evidence storage location and single sign-on. |
| **Administrator** | Manage exams, candidates, settings and reviewers; end, extend, reschedule and reopen exams; review sessions. |
| **Reviewer** | View sessions and evidence, review events, add notes, approve or deny pauses, put on hold and release. Cannot open Settings, Users, Integrations, Privacy or the Audit log. |

---

# Part 1 — What the app does

## A. Candidate exam app (`/take/<link>`)

**Before the exam**

- **Personal exam link.** Each candidate gets their own link. No account or password is needed.
- **Welcome and consent.** Shows the exam title, duration, number of questions, pause rules and fullscreen rule.
  It also shows approved arrangements (accommodations) and a full privacy notice: what is monitored, what is stored,
  what is not stored, and for how long. The candidate must tick a box and press "Agree and continue". Choosing "I do
  not agree" records nothing.
- **System check.** Checks for a secure connection, camera support, WebAssembly, local storage (for offline safety),
  a supported browser, a connected camera, fullscreen support and a single display.
- **Camera check.** Shows a live preview and lets the candidate pick a camera. A checklist confirms: camera
  delivering video, exactly one face visible, face close enough and centred, good lighting, sharp image, and a
  physical (not virtual) camera.
- **Calibration.** "Hold still and look at the screen": learns the candidate's normal sitting position, so their
  own posture is never flagged.
- **Live-person check.** "Slowly turn your head to your LEFT / RIGHT", in a random order (optionally also up and
  down). The server verifies real 3-D movement, so a photo held up to the camera fails.
- **Identity reference.** A few pictures of the face become a protected, encrypted reference. It is never replaced
  automatically, so a substitute can't become the new reference.
- **ID-photo comparison** (optional). If staff uploaded an approved ID photo, the live face is compared with it.
  This is either advisory (recorded only) or required (the exam is held if it does not match).
- **Ready screen.** "You are ready to start". The clock only starts when the candidate presses "Start exam".
- **Busy-server protection.** When many candidates start at once, starts are queued for up to 5 minutes and the
  clock does not run while waiting.

**During the exam**

- **5 question types.** Single choice, multiple choice, short text, long text (graded by hand), and numeric (a comma
  is accepted as the decimal sign).
- **Autosave.** Each answer is saved 0.6 s after typing stops. Answers are also kept on the device if the connection
  drops.
- **Navigation.** Numbered question buttons, "← Previous", "Next →", and "Review and submit".
- **Countdown.** Turns red under 5 minutes. When time is up, answers are submitted automatically.
- **Self-view and monitoring status.** "Monitoring active", "please check the camera view", "Monitoring limited".
- **Camera monitoring in the browser** (no video is uploaded). One event per issue, with a start and an end:

  | What | Event after (default) | Message to the candidate |
  |---|---|---|
  | No face visible | 8 s | after 3 s: "We can't see your face…" |
  | More than one person | 1 s | "More than one face is visible…" |
  | Looking away (sideways 28°, down 20°) | 5 s (looking up: 15 s) | "Please keep facing the exam screen." |
  | Repeated looking away | 5 glances in 2 min | — |
  | Repeated attention to one off-screen spot | 4 glances in 2 min | — |
  | Unusual movement (leaving view 3× in 5 min, or far from usual position 15 s) | — | — |
  | Phone visible | 2 s | "A phone may be visible…" |
  | Other device / book / laptop visible | 2 s | — |
  | Camera covered | 4 s | "Your camera view seems to be blocked…" |
  | Frozen image | 6 s | "Your camera image seems to have stopped updating…" |
  | Lighting too poor | 10 s | "Your face is too dark…" / "The image is too bright…" |
  | Face covered or cut off | 6 s | "Part of your face is hidden…" |
  | Camera disconnected / permission lost | 1–2 s | camera problem banner |
  | Virtual or replayed camera feed | — | — |

  Brief glances (under 1.2 s) and single bad frames never create an event.
- **Exam-page events.** Left the exam tab, window lost focus (2 s or longer), left fullscreen (with a "Return to
  fullscreen" overlay), copy/paste attempts (blocked, right-click disabled), extra display connected (Chrome only),
  and the exam opened in another browser.
- **Continuous identity checks.** Small bursts of face pictures are checked on the server: at the start, every 6 s for
  the first 3 minutes, then every 15 s. Extra checks happen when the face leaves and returns, the camera reconnects,
  another person was visible, or the face changes suddenly. If a different person takes over, the exam is put on hold
  (default). The candidate never sees a "match / no match" verdict.
- **Pause.** "Pause the exam". Per exam: allowed or not, reason required, staff approval required, clock stops or keeps
  running, maximum number of pauses, maximum pause length. The candidate can close the browser while paused.
- **Resume, hours or days later, from any room or camera.** Repeats the camera check and the live-person check, and
  compares the face with the original reference. A change of clothes, hair or background is context only.
- **Poor light ≠ different person.** In poor light the result is "could not verify", with guidance and a retry, and
  then a human decides. It never says "different person".
- **Reconnect.** After a reload, browser restart or another device, the candidate does a quick check. The old window
  shows "This exam continues in another window".
- **Offline safety.** If the connection drops, a banner says "Live reporting is interrupted…". Answers and events are
  kept on the device and sent later with their original times, without duplicates.
- **Hold screen.** "Your exam is on hold", with "Verify again" when staff allow it.
- **Withdraw consent.** From "what is monitored?" → "Withdraw my consent…". The exam ends and the images are deleted.
- **Submit.** "Submit your exam?" shows how many questions are unanswered, then the "Your exam has been submitted"
  screen.
- **Scheduling window.** "This exam is not open yet" / "This exam is closed", shown in the candidate's own time zone.
  Check-in opens 30 minutes before the start.
- **Practice banner** for sandbox (trial) organisations.
- **Accessibility.** Works with the keyboard alone and with a screen reader. Focus moves to each new screen, there is
  a skip link, and it respects reduced motion and 320 px narrow screens.
- **Hidden helpers.** Add `?debug=1` to a candidate link for a debug panel. Add `?trace=1` to download a monitoring
  trace.

## B. Staff app — watching and reviewing

- **Sign-in.** Email and password, with an increasing lock-out after repeated wrong passwords. Optional two-step
  sign-in with an authenticator app and 10 one-time recovery codes. Optional single sign-on with your organisation.
- **Account & security.** Set up two-step sign-in, "Move to a new phone…", "New recovery codes…", "Turn off…", and
  change your password.
- **Live dashboard ("Live").** Counts of active, paused, on hold, disconnected, not started and completed (24 h)
  exams, and unreviewed flags. "Needs attention" lists pause requests (Approve / Deny) and holds. A card per exam
  shows connection, monitoring status, identity status, countdown and flag counts. A live flag feed can be filtered
  by Integrity / Uncertain / Technical. Everything updates in real time.
- **Sessions list.** Every attempt, with filters (status, exam, connection, search), a live countdown, flag counts
  and the review state.
- **Session page.**
  - Header with status, banners and facts (time left, scheduling window, score, consent, last heartbeat).
  - **Timeline** of observed and unobserved periods with every event and identity check.
  - **Events** table (sortable, filterable).
  - **Identity** tab: reference images, live-person check results, ID-photo result and every identity check.
  - **Review** tab, **Periods**, **Devices** (camera or browser changes as context), and **Notes**.
- **Event details drawer.** Screenshots, duration, confidence, source, "Why this was recorded" (the rule and the
  measured values), "Compare with the start of the exam", incident grouping, a decision and notes.
- **Compare images.** For a possible different person: the original reference next to the later images, a
  similarity scale, and "What happened around this time" (paused? face left? camera changed? another person?).
- **Staff actions on an exam.** "Release hold…" / "Verify identity…", "Put on hold…", "Extend time…", "Submit on
  behalf…", "Reschedule…", "Reopen for recovery…", "Terminate…", "Copy access link", "Regenerate link…", "Legal
  hold…", "Export CSV", "Open report".
- **Review workflow.**
  - **Decisions per flag:** Integrity concern / Accurate, no concern / Covered by an accommodation / Technical
    problem / Inconclusive / False detection. Changing another reviewer's decision requires a reason.
  - **Incidents:** flags close in time are decided together.
  - **Bulk decision** for technical and low-severity flags.
  - **Outcome of the whole exam:** No integrity concerns / Integrity concerns — refer / Inconclusive / Technical
    issues affected the exam.
  - Escalate, reopen, and review-time targets.
- **Review queue.** Assigned to me / Unassigned / Escalated / Overdue / All waiting / Resolved, plus "Assign to me".
- **Printable report.** Summary, observed and unobserved time, every period, identity summary, events by category and
  type, notable events with images, reviewer notes and limitations. "Print / Save as PDF".

## C. Staff app — setting things up

- **Exams.**
  - Create, edit, import (`.exam.json`), export, publish and archive.
  - Questions editor for the 5 types, with answer keys and points.
  - **Proctoring policy editor** with about 67 settings: identity and live-person check, ID photo, sampling intensity
    (Maximum accuracy / Balanced), pausing rules, connection, interruption limits, browser rules, each detector on or
    off, detection thresholds, screenshots and retention.
- **Exam versions.** Every publish, and every edit of a published exam, creates a version. Each attempt keeps the
  version it started with. You can view versions, see what changed, export them, and **Regrade** finished attempts
  with a corrected answer key (with a preview).
- **Assigning candidates.** Select candidates, set an optional scheduling window, then press "Assign N selected".
  This creates the personal links ("Copy all (name + link)").
- **Candidates.** Add, edit and delete candidates; approved ID photo (upload, replace, remove); list of sessions.
- **Accommodations** per candidate:
  - Extra time
  - Rest breaks
  - No head-turn challenge
  - Assistive technology
  - Behaviour detectors off
  - Support person present
  - Identity verified by staff
  - No camera

  Each applies to all exams or to one exam, with an optional end date, a basis and an encrypted note.
- **Users.** Add staff, set the role, reset a password, disable or enable, reset two-step sign-in, unlink single
  sign-on.
- **Settings.**
  - Usage and limits.
  - Organisation name and privacy contact.
  - Retention (images 30 days, event records 365 days, unfinished sessions closed after 30 days).
  - Identity thresholds (read-only here).
  - Default proctoring policy.
  - Review targets (hold decided within 15 min, flags within 72 h).
  - Two-step sign-in requirement (owner).
  - Where evidence images are stored (owner).
  - Single sign-on (OpenID Connect or SAML) and SCIM provisioning (owner).
- **Integrations.**
  - **API keys:** full access, read only, or chosen permissions, with an expiry.
  - **REST API** (`/api/v1`) with an OpenAPI document and safe retries (Idempotency-Key).
  - **Signed webhooks** for 12 kinds of notification, with retries and a delivery log.
  - **Email alerts.**
  - **Optional second opinion from Amazon Rekognition.**
- **Privacy.**
  - **Operational checks** (is the retention job running, deletions on time, …).
  - **Request register:** access, erasure, rectification, restriction, objection and other requests, with legal
    deadlines and extensions.
  - **Personal-data export (ZIP).**
  - **Erasure.**
  - **Deletion schedule and legal holds.**
- **Detection quality ("Quality").** How reliable each detector is, based on reviewer decisions; identity decisions
  by lighting, camera, browser and operating system; drift between recent and earlier weeks; versioned identity
  thresholds with **four-eyes approval** and **rollback**; upload of an offline evaluation report.
- **Audit log.** Every evidence view, decision, hold, setting change and more, with a filter and CSV download.
- **Camera & identity test** (Tools). Try the real identity check on your own webcam. Enrol yourself, then let
  someone else sit down and watch it say "Confirmed — a different person".

## D. Behind the scenes (no screen)

- **Health endpoints:** `/api/health`, `/api/health/live`, `/api/health/ready`, `/api/health/capacity`.
- **Prometheus metrics** at `/metrics` (only when `METRICS_TOKEN` is set) and 18 alert rules.
- **Background jobs:** retention purge, closing abandoned sessions, webhook and email delivery, sandbox clean-up.
- **Operator commands** (run inside the container):
  - `org` — create, list or change organisations, sandbox mode and quotas.
  - `staff-access` — break-glass account recovery.
  - `retention` — run the retention purge once.
  - `rekey` — re-encrypt after a key change.
  - `storage-move` — move images between storage locations.
  - `openapi` — write or check the API document.
  - `migrate` — database migrations.
- **Security:** encrypted evidence (AES-256-GCM), rate limits, CSRF protection, SSRF guard for outgoing requests,
  audit of every evidence view.
- **Scaling:** optional separate vision workers and Redis for several servers.

---

# Part 2 — Test checklist

Work through the stages in order. Later stages reuse what earlier ones created. Each test lists **Do** and
**Expect**. If what you see differs from **Expect**, note the test number (e.g. "T5.4") and we'll look at it.

## Stage 0 — Is the app up?

- [ ] **T0.1 Health check.**
  **Do:** open http://localhost:8080/api/health.
  **Expect:** `{"ok":true,"db":"ok","vision":"ok",…}`.
- [ ] **T0.2 API document.**
  **Do:** open http://localhost:8080/api/v1/openapi.json.
  **Expect:** a long JSON document (the integration API description).

## Stage 1 — Staff sign-in and your account (Edge)

- [ ] **T1.1 Sign in.**
  **Do:** open http://localhost:8080/admin and sign in with your owner email and password.
  **Expect:** the "Live" dashboard. The left menu shows Live, Sessions, Review queue, Exams, Candidates, Quality,
  Audit log, Privacy, Settings, Integrations, Users, and under Tools "Camera & identity test".
- [ ] **T1.2 Wrong password.**
  **Do:** sign out. Sign in as `nobody@example.com` with any password.
  **Expect:** "Incorrect email or password."
- [ ] **T1.3 Lock-out.**
  **Do:** repeat T1.2 five or six times quickly.
  **Expect:** "Too many failed sign-in attempts for this account. Try again in 30 seconds" (the wait doubles each time).
  Your real account is not affected.
- [ ] **T1.4 Return to the page you wanted.**
  **Do:** while signed out, open http://localhost:8080/admin/exams.
  **Expect:** the sign-in page. After signing in you land on Exams, not Live.
- [ ] **T1.5 Turn on two-step sign-in.**
  **Do:** click "Account & security" (bottom left) → "Set up two-step sign-in" → scan the QR code with your
  authenticator app → type the 6-digit code → "Turn on two-step sign-in".
  **Expect:** 10 recovery codes with "Save these recovery codes now — they are shown only once." Click "Download as a
  file" (keep it safe), tick "I have saved my recovery codes", then "Done". The status shows "On".
- [ ] **T1.6 Sign in with the code.**
  **Do:** sign out, then sign in with your password.
  **Expect:** a "Two-step sign-in" step asking for the 6-digit code. A wrong code gives "That code is not right…". The
  right code signs you in.
- [ ] **T1.7 Sign in with a recovery code.**
  **Do:** sign out, enter your password, click "I don't have my phone — use a recovery code", and enter one code.
  **Expect:** you are signed in. Account & security now says "9 unused recovery codes left". Using the same code
  again fails with "…or it was already used."
- [ ] **T1.8 New recovery codes.**
  **Do:** "New recovery codes…" → app code → "Create new codes".
  **Expect:** 10 fresh codes. The old ones stop working.
- [ ] **T1.9 Change password.**
  **Do:** under "Password", enter the current password and a new one (at least 10 characters) twice → "Change password".
  **Expect:** "Password changed. Other browsers signed in to your account were signed out." Put the new password in
  `.env` or your password manager. (The `.env` value is only used on the very first start.)

## Stage 2 — Staff team (Users)

- [ ] **T2.1 Add an administrator.**
  **Do:** Users → "Add user" → Name "Test Admin", email `admin2@example.com`, Role Administrator, an initial password →
  "Create user".
  **Expect:** a new row with Role Administrator, Status Active, Two-step sign-in Off.
- [ ] **T2.2 Add a reviewer.**
  **Do:** do the same with "Test Reviewer", `reviewer@example.com`, Role Reviewer.
  **Expect:** a new row.
- [ ] **T2.3 Reviewer restrictions.**
  **Do:** in an Edge InPrivate window, sign in as the reviewer.
  **Expect:** the menu has no Audit log, Privacy, Settings, Integrations or Users. Typing
  http://localhost:8080/admin/settings shows "Administrators only — Your role (reviewer) cannot open this page." Exams
  has no "New exam" or "Import…" button.
- [ ] **T2.4 Administrator limits.**
  **Do:** sign in as Test Admin (private window) → Users.
  **Expect:** they can manage the reviewer but not the owner, and the Role choice for new users is Reviewer only.
- [ ] **T2.5 Disable and enable.**
  **Do:** keep the reviewer signed in (private window). As owner, click "Disable" on Test Reviewer → confirm, then try
  to sign in as the reviewer again.
  **Expect:**
  - The reviewer's open window drops back to the sign-in page.
  - Signing in shows "Incorrect email or password.", even with the right password. That's on purpose: the app never
    tells a stranger whether an account exists or is disabled.
  - The Audit log records the attempt as `auth.login_failed` with reason `disabled`.
  - Click "Enable" to restore; the reviewer can sign in again.
- [ ] **T2.6 Reset a password.**
  **Do:** "Reset password" on Test Reviewer → new password → "Set password".
  **Expect:** "Password updated. Share it with Test Reviewer through a secure channel." If the reviewer was signed in,
  they are signed out. The old password no longer works; the new one does.

## Stage 3 — Exams (as owner)

You will make **three exams** from the ready-made file [test-exams/practice-exam.exam.json](test-exams/practice-exam.exam.json).
It has 6 questions covering all 5 types (20 minutes).

- [ ] **T3.1 Import.**
  **Do:** Exams → "Import…" → choose `test-exams/practice-exam.exam.json` → "Import as draft".
  **Expect:** a new **Draft** exam "Feature test — practice exam" with 6 questions and 11 points.
- [ ] **T3.2 Import a wrong file.**
  **Do:** "Import…" → choose any other file (e.g. `package.json`).
  **Expect:** "Cannot import this file" — "This file is not a SmartProctoring exam export."
- [ ] **T3.3 Publish exam A.**
  **Do:** open the imported exam → "Publish…" → "Publish".
  **Expect:** status Published, "version 1". The Versions panel says "Candidates who start now get version 1."
  *This is **Exam A** (default rules, fullscreen required).*
- [ ] **T3.4 Exam B — windowed, pauses need approval.**
  **Do:** import the file again → "Edit" → Title "Feature test — windowed". In "Proctoring policy":
  - Browser rules → **Require fullscreen: Off**
  - Pausing → **Require a reason: On**, **Require staff approval: On**, **Maximum number of pauses: 2**
  - Interruptions and recovery → **Times the exam may be reopened in a new browser window: 2**

  Then "Save changes" → "Publish…".
  **Expect:** each changed setting shows a dot and an "N changed" badge. After saving, the exam page lists those
  settings under "N settings differ from the product defaults".
- [ ] **T3.5 Exam C — two-minute exam.**
  **Do:** import again → "Edit" → Title "Feature test — 2 minutes", Duration **2** → "Save changes" → "Publish…".
  **Expect:** duration 2 min.
- [ ] **T3.6 Question editor checks.**
  **Do:** "New exam" → leave the title empty → "+ Add question" → leave the prompt empty → "Create exam".
  **Expect:** "Fix the highlighted fields before saving.", "Title is required", "Enter the question text". Click
  "Cancel" (nothing is created).
- [ ] **T3.7 Export.**
  **Do:** on Exam A → "Export".
  **Expect:** a file `feature-test-practice-exam.exam.json` downloads, with the answer keys.

## Stage 4 — Candidates and invitations

- [ ] **T4.1 Add candidates.**
  **Do:** Candidates → "Add candidate" six times: "Tester 1" … "Tester 6" (email optional; External ID e.g. T-1 … T-6).
  **Expect:** six rows, ID photo "None".
- [ ] **T4.2 Duplicate external ID.**
  **Do:** add another candidate with External ID T-1.
  **Expect:** "Another candidate already has this external ID."
- [ ] **T4.3 ID photo.**
  **Do:** open Tester 1 → "Upload photo…" → a clear, front-facing photo of **you** (JPEG/PNG).
  **Expect:** "Photo accepted." and "Approved <date>". A blurry or face-less image gives "Photo not accepted…" with
  guidance.
- [ ] **T4.4 Assign.**
  **Do:** open Exam A → "Assign candidates" → tick Tester 1, 3 and 4 → "Assign 3 selected". Open Exam B → assign
  Tester 2. Open Exam C → assign Tester 5. (Tester 6 is assigned later, in Stage 13.)
  **Expect:** "N access links created." with a link for each person and "Copy all (name + link)". The exam's
  "Sessions" table shows them as Invited. **Keep these links** (you can copy them again later from the exam page or
  the session page).
- [ ] **T4.5 Draft exams can't be assigned.**
  **Do:** "New exam" → Title "Draft test" → "Create exam" → look at "Assign candidates".
  **Expect:** "Publish the exam before assigning candidates."
- [ ] **T4.6 Archive.**
  **Do:** on "Draft test" → "Archive…" → "Archive".
  **Expect:** status Archived, the banner "This exam is archived and accepts no new assignments.", and no "Edit"
  button.

## Stage 5 — Candidate check-in (Chrome, Tester 1 on Exam A)

- [ ] **T5.1 Welcome.**
  **Do:** open Tester 1's link in Chrome.
  **Expect:** the exam title, "Welcome, Tester 1.", Duration 20 min, Questions 6, Pauses "Allowed (clock stops)",
  Fullscreen "Required", the instructions, the "System check" (✓ items), and "Privacy notice: camera monitoring".
- [ ] **T5.2 Consent is required.**
  **Do:** try "Agree and continue" without ticking the box; then click "I do not agree".
  **Expect:** the button stays disabled. "I do not agree" explains that you cannot take the exam without agreeing and
  that nothing has been recorded.
- [ ] **T5.3 Camera check.**
  **Do:** tick the box → "Agree and continue" → allow the camera.
  **Expect:** "Camera check" with your mirrored preview and the checklist. Try covering half your face or moving
  away: "Exactly one face is visible" or "Face is close enough and centred" turn to ✕ or ! with guidance. Sit
  normally: "All checks passed. Select Continue."
- [ ] **T5.4 Calibration.**
  **Do:** "Continue".
  **Expect:** "Hold still and look at the screen" with a progress bar. It moves on by itself after a few seconds.
- [ ] **T5.5 Live-person check (real you).**
  **Do:** follow "Look straight at the screen and hold still", then "Slowly turn your head to your LEFT / RIGHT".
  **Expect:** "Pictures of your face: X of 5", arrows and progress bars, "Hold it there…", then "Checking…". You land
  on "You are ready to start" with "Your camera and identity checks are complete."
- [ ] **T5.6 Ready screen rules.**
  **Expect:** bullets saying the clock starts with "Start exam", answers save automatically, fullscreen is required,
  copy and paste are disabled, and the pause rule. "What is monitored?" opens the privacy notice.
- [ ] **T5.7 Debug panel** (optional).
  **Do:** add `?debug=1` to the end of the link and reload.
  **Expect:** a "Debug" panel with camera, check and identity-sample details.

## Stage 6 — Taking the exam (Tester 1, continued)

- [ ] **T6.1 Start.**
  **Do:** "Start exam".
  **Expect:** fullscreen, a countdown from 20:00, your self-view, the status "Monitoring active", Question 1 of 6.
- [ ] **T6.2 Question types.** Answer every question:

  | Question | How you answer it |
  |---|---|
  | Q1 | radio buttons, plus "Clear answer" |
  | Q2 | checkboxes, "Select all that apply." |
  | Q3, Q4 | numbers; try `3,75` with a comma, and try `abc`, which shows "Enter a number, for example 42 or 3.5" |
  | Q5 | short text |
  | Q6 | long text |

  **Expect:** "Answer saved automatically" under each answered question. The left panel shows "N of 6 answered" and
  marks the answered numbers.
- [ ] **T6.3 Answers survive a reload.**
  **Do:** press ⌘R.
  **Expect:** "Continue your exam" (a quick reconnect check). After it, "Check complete" → "Continue exam". All answers
  are still there and you're on the same question.
- [ ] **T6.4 Copy/paste is blocked.**
  **Do:** select question text and press ⌘C; right-click.
  **Expect:** nothing is copied and no right-click menu appears. (Recorded as "Copy/paste attempt".)
- [ ] **T6.5 Leaving fullscreen.**
  **Do:** press Esc.
  **Expect:** a full-page "Return to fullscreen" overlay. Esc does not close it; the button does. (Recorded as "Left
  fullscreen".)
- [ ] **T6.6 Leaving the tab.**
  **Do:** press ⌘T (new tab), wait 3 s, then return.
  **Expect:** no message to you. (Recorded as "Left the exam tab" and "Exam window lost focus".)

## Stage 7 — Camera monitoring (Tester 1, continued — about 1 minute per test)

Do each, wait for the time shown, then return to normal.

- [ ] **T7.1 Leave the camera.**
  **Do:** step away for 15 s.
  **Expect:** after ~3 s "We can't see your face…"; when you return the message clears. (Recorded as "Candidate not
  visible", and an extra identity check runs when your face returns.)
- [ ] **T7.2 Look away.**
  **Do:** turn your head well to the side for 8 s.
  **Expect:** "Please keep facing the exam screen." (Recorded as "Sustained looking away".) A quick 1 s glance does
  nothing.
- [ ] **T7.3 Phone.**
  **Do:** hold your phone up to the camera for 5 s.
  **Expect:** "A phone may be visible in the camera view…". (Recorded as "Phone visible". Phone detection is the
  least proven detector, so it may not always fire.)
- [ ] **T7.4 Cover the camera.**
  **Do:** put a finger or sticky note over the lens for 8 s.
  **Expect:** after ~1.5 s "Your camera view seems to be blocked…". (Recorded as "Camera view blocked".)
- [ ] **T7.5 Cover part of your face.**
  **Do:** hold a hand over your mouth and nose for 10 s.
  **Expect:** "Part of your face is hidden…". (Recorded as "Face obstructed or unclear".)
- [ ] **T7.6 Lights off.**
  **Do:** turn off the lamp or room light for 15 s.
  **Expect:** "Your face is too dark…", and the status may show "Monitoring limited". (Recorded as "Lighting too poor
  to assess" — an *uncertain* observation, never "different person".)
- [ ] **T7.7 Another person.**
  **Do:** ask your helper to lean into view for 5 s.
  **Expect:** "More than one face is visible…". (Recorded as "More than one person in view", with a screenshot showing
  both people.)

## Stage 8 — Pause and resume (Tester 1, continued)

- [ ] **T8.1 Pause.**
  **Do:** "Pause" → the dialog "Pause the exam" (reason optional here) → "Pause exam".
  **Expect:** "Your exam is paused", with the clock "Stopped during the pause", and a note that you can close the
  window.
- [ ] **T8.2 Close the browser.**
  **Do:** quit Chrome completely (⌘Q). Wait a minute or more (hours or days also work).
- [ ] **T8.3 Resume.**
  **Do:** open the same link → "Resume exam" → "Start the check".
  **Expect:** the camera check and the head-turn check again, then "Check complete — Your answers and remaining time are
  exactly as you left them." → "Resume exam". The countdown continues from where it stopped.
- [ ] **T8.4 Resume somewhere else** (optional).
  **Do:** pause again, change room, lighting, clothes or camera, then resume.
  **Expect:** it passes. Staff see "Surroundings changed" or "Camera changed" as *context*, not as a problem.
- [ ] **T8.5 Submit.**
  **Do:** "Review and submit" → "Submit your exam?" → "Submit exam".
  **Expect:** "Your exam has been submitted — You submitted your exam. … You can close this window." The camera turns
  off.

## Stage 9 — The staff side of Tester 1's exam (Edge)

- [ ] **T9.1 Dashboard.**
  **Do:** open Live.
  **Expect:** Tester 1 under Completed (24 h) and the flags from Stages 6–7 in the flag feed, each with a thumbnail,
  category, time, duration and confidence.
- [ ] **T9.2 Timeline.**
  **Do:** click Tester 1's card → Timeline.
  **Expect:** sections "Readiness check", "Active — observed", "Paused — unobserved" ("no observations are made about
  this period"), "Resume check" and "Active". Every event and identity check is in time order.
- [ ] **T9.3 Event details.**
  **Do:** click "Camera view blocked" (or any flag).
  **Expect:** the drawer "Event details" with Started, Ended, Duration, Confidence, Source, screenshots (click → full
  view with ‹ ›), "Why this was recorded", and "Compare with the start of the exam".
- [ ] **T9.4 Filters.**
  **Do:** Events tab → category "Technical", Severity "High only", "Only unreviewed" → "Clear filters".
  **Expect:** the list narrows ("X of N shown"), then comes back.
- [ ] **T9.5 Identity tab.**
  **Expect:** "Identity reference(s)" with your reference images, "Live-person check: Passed" with the step table,
  "ID-photo comparison" (Tester 1 has a photo, so you should see "Same person" and a similarity), and "Identity
  checks", one row per check.
- [ ] **T9.6 Periods / Devices / Notes.**
  **Expect:** Periods lists each observed and unobserved period with durations. Devices lists your camera and browser.
  Add a note → it appears with your name.
- [ ] **T9.7 CSV.**
  **Do:** "Export CSV".
  **Expect:** `session-<id>-events.csv` downloads with one row per event.

## Stage 10 — Reviewing (Tester 1's exam)

- [ ] **T10.1 Decide a flag.**
  **Do:** open "Left fullscreen" → choose "Accurate, no concern" → "Record decision".
  **Expect:** a review badge on the event everywhere (timeline, events, feed).
- [ ] **T10.2 False detection.**
  **Do:** pick a flag that didn't really happen (or any one) → "False detection" → "Record decision".
  **Expect:** status "Dismissed".
- [ ] **T10.3 Incidents.**
  **Do:** Review tab → "Incidents".
  **Expect:** flags within 30 s of each other grouped together. Use "Decide together" with a conclusion → "Decide" →
  "N decided."
- [ ] **T10.4 Bulk decision.**
  **Do:** the "Technical and low-severity flags" card → Conclusion "Technical problem" → "Decide N".
  **Expect:** those flags are decided in one go.
- [ ] **T10.5 Changing someone else's decision.**
  **Do:** as Test Reviewer (private window), open a flag the owner decided and choose a different conclusion.
  **Expect:** the note becomes "Reason for changing <name>'s decision (required)". After saving, "Decision history"
  shows "Reviewers disagreed".
- [ ] **T10.6 Resolve the review.**
  **Do:** once every flag is decided → "Outcome of the review" → "No integrity concerns" → "Resolve the review".
  **Expect:** state Resolved. The timeline has "Review completed".
- [ ] **T10.7 Reopen the review.**
  **Do:** "Reopen the review…" → a reason → "Reopen".
  **Expect:** back to "In review"; the timeline has "Review reopened". Resolve it again.
- [ ] **T10.8 Report.**
  **Do:** "Open report" → "Print / Save as PDF".
  **Expect:** "Exam session report" with Summary (observed vs unobserved time), Review, Periods, Identity, Events by
  category and type, Notable events with images, and Reviewer notes. Save it as a PDF.

## Stage 11 — Live watching, pause approval and staff actions (Tester 2, Exam B, windowed)

Put Chrome (candidate) and Edge (staff) **side by side**. Exam B has no fullscreen, so you can watch both. Clicking
the Edge window records "Exam window lost focus" on the candidate side — expected.

- [ ] **T11.1 Live card.**
  **Do:** check in and start Tester 2 in Chrome.
  **Expect:** on Live, the card moves Not started → Active, shows "Online", "Monitoring active · 1 face", "Identity:
  Same person…", and a ticking countdown. No refresh needed.
- [ ] **T11.2 Live flag.**
  **Do:** cover the camera for 6 s.
  **Expect:** a new entry in the flag feed within seconds, briefly highlighted, plus a count on the card.
- [ ] **T11.3 Pause needs a reason.**
  **Do:** candidate → "Pause" → leave the reason empty → "Request pause".
  **Expect:** "Please give a reason for the pause."
- [ ] **T11.4 Pause approval — deny.**
  **Do:** enter a reason → "Request pause".
  **Expect:**
  - Candidate: "Waiting for approval", and they can keep working.
  - Staff: "Needs attention" shows "Pause request" with the reason.
  - Type a note → "Deny". The candidate sees "Your pause request was not approved: <your note>".
- [ ] **T11.5 Pause approval — approve.**
  **Do:** request again → staff "Approve".
  **Expect:** the candidate sees "Your pause was approved. The exam is now paused." The card shows "Monitoring stopped
  — paused (unobserved)". Resume as in T8.3.
- [ ] **T11.6 Pause limit.**
  **Do:** after two pauses in total, look for the "Pause" button.
  **Expect:** it is gone (maximum 2).
- [ ] **T11.7 Put on hold.**
  **Do:** staff → open the session → "Put on hold…" → note → "Put on hold".
  **Expect:** the candidate sees "Your exam is on hold" — "An administrator has put your exam on hold…". Staff see
  "On hold: Placed on hold by staff" and it appears in "Needs attention".
- [ ] **T11.8 Release without a check.**
  **Do:** "Release hold…" → **untick** "Require a fresh identity check…" → "Release hold".
  **Expect:** the candidate returns to the exam straight away (within ~5 s).
- [ ] **T11.9 Release with a check.**
  **Do:** hold again → "Release hold…" with the box **ticked**.
  **Expect:** the candidate sees "Verify again". After a fresh check, the exam continues.
- [ ] **T11.10 Extend time.**
  **Do:** "Extend time…" → 10 → reason → "Add 10 min".
  **Expect:** the candidate's countdown jumps up by 10 minutes. The timeline has "Time extended".
- [ ] **T11.11 Reopen limit** (Exam B allows 2).
  **Do:** in the candidate's Chrome, open the link in 3 new tabs, one after the other, doing the check each time.
  (A page reload also counts as reopening, so the hold may come sooner if you reloaded earlier.)
  **Expect:**
  - The old tab shows "This exam continues in another window".
  - After the limit, the exam is held with "Interrupted more often or longer than the exam rules allow".
  - Release the hold to continue.
- [ ] **T11.12 Terminate.**
  **Do:** "Terminate…" → reason → "Terminate exam".
  **Expect:** the candidate sees "Your exam has ended". Status Terminated, "Terminated by staff".
- [ ] **T11.13 Reopen for recovery.**
  **Do:** "Reopen for recovery…" → reason "Testing recovery" → minutes 5 → "Reopen exam". Then reload the
  candidate's page.
  **Expect:**
  - Candidate: "Your exam has been reopened" → "Continue to the identity check".
  - After the check, the exam continues with the old answers and the added time.
  - Timeline: "Exam reopened for recovery".
- [ ] **T11.14 Submit on behalf.**
  **Do:** "Submit on behalf…" → "Submit exam".
  **Expect:** the candidate sees the submitted screen. Status "Submitted by staff".

## Stage 12 — Identity protection (Tester 3, Exam A, with your helper)

- [ ] **T12.1 Photo cannot pass.**
  **Do:** open Tester 3's link → camera check → at the head-turn check, hold **your photo** in front of the camera
  instead of your face.
  **Expect:** it doesn't pass: "Let's try that again — We could not confirm the live head movements…" with "Attempts
  remaining: N". Do this twice, then use your real face to pass.
  *If all 5 attempts are used up, the exam is held with "Identity could not be verified after repeated attempts".
  That is also correct; release it from the staff side.*
- [ ] **T12.2 Person swap mid-exam.**
  **Do:** start the exam. Within the first minute, stand up and let your helper sit down and face the camera.
  **Expect:**
  - Within roughly 5–20 s the candidate side shows "Your exam is on hold" (message about a possible different person).
  - Staff: Live → "Needs attention": "Possible different person — awaiting review". The flag feed shows "Possible
    different person".
- [ ] **T12.3 Compare images.**
  **Do:** staff → session → Identity tab → "Compare images".
  **Expect:**
  - "Original reference" (you) next to "Later images" (your helper), with a similarity scale.
  - "What happened around this time" answers: "Did the face leave the camera view? Yes — …".
  - Record a decision ("Integrity concern").
- [ ] **T12.4 Release with a fresh check.**
  **Do:** "Release hold…" (keep "Require a fresh identity check" ticked). **You** sit back down → "Verify again".
  **Expect:** you pass, because you match the original reference, and the exam continues.
- [ ] **T12.5 Different person on resume.**
  **Do:** "Pause" → close the tab → your **helper** opens the link → "Resume exam" → does the checks.
  **Expect:** the helper does not get back in. The exam is held for review with before/after images (Identity tab →
  Compare).
- [ ] **T12.6 Dark room on resume.**
  **Do:** release with a check. **You** resume in a very dark room.
  **Expect:** "Let's try that again" with lighting guidance — **never** "different person". Turn a light on → it
  passes.
- [ ] **T12.7 End.**
  **Do:** staff → "Submit on behalf…".

## Stage 13 — Connection problems, ending and other screens

- [ ] **T13.1 Offline.**
  **Do:** Tester 4 (Exam A) → start the exam. Open Chrome DevTools (⌥⌘I) → Network → the throttling menu → **Offline**.
  Answer a question and cover the camera for 6 s. Wait 40 s, then set it back to **No throttling**.
  **Expect:**
  - While offline:
    - Candidate: "Live reporting is interrupted… (N items waiting)".
    - Staff, within ~20 s: "Disconnected" and "Reporting interrupted since …".
  - When back online, the banner clears. The "Camera view blocked" event arrives with the badge **"Delivered late"**,
    shown once, at its original time.
- [ ] **T13.2 Server restart.**
  **Do:** while Tester 4 is in the exam, run `docker compose restart app` in the project folder. Wait ~30 s.
  **Expect:** the candidate keeps working; answers are kept; the outage appears in the timeline once.
- [ ] **T13.3 Withdraw consent.**
  **Do:** Tester 4 → "Monitoring active — what is monitored?" → "Withdraw my consent…" → tick "I understand that my
  exam ends now." → "Withdraw consent and end my exam".
  **Expect:**
  - Candidate: "Your exam has ended" (consent withdrawn).
  - Staff: "Candidate withdrew consent (no score)".
  - Privacy page: a new "Consent withdrawn" request.
- [ ] **T13.4 Time runs out.**
  **Do:** Tester 5 (Exam C, 2 minutes) → start → wait.
  **Expect:**
  - "Time remaining" turns red.
  - At 0: "Time is up. Your answers are being submitted…".
  - Then "The exam time ran out, and your saved answers were submitted automatically."
  - Staff: "Time expired (auto-submitted)".
- [ ] **T13.5 Scheduling window.**
  **Do:** Exam A → "Assign candidates" → set "Opens" to 2 hours from now and "Closes" to 4 hours from now → assign
  Tester 6 → open their link.
  **Expect:** "This exam is not open yet — This exam opens on …", a line saying the camera check is possible from 30
  minutes before, and the times in your time zone.
- [ ] **T13.6 Reschedule.**
  **Do:** staff → Tester 6's session → "Reschedule…" → Opens: now, Closes: in 1 hour → "Save window". Candidate →
  "Check again".
  **Expect:** the welcome screen appears. The timeline has "Exam rescheduled".
- [ ] **T13.7 Regenerate link.**
  **Do:** Tester 6's session → "Regenerate link…" → confirm. Open the **old** link.
  **Expect:** "This exam link is not valid". The new link works.

## Stage 14 — Accommodations (Tester 6)

- [ ] **T14.1 Extra time.**
  **Do:** Candidates → Tester 6 → "Add accommodation…" → "Extra time", 25% → "Add accommodation".
  **Expect:**
  - Listed as Active.
  - The candidate's welcome screen shows "Your approved arrangements" and 25 min instead of 20.
  - Session page: "Approved accommodations" with "Exam rules changed for this candidate".
- [ ] **T14.2 Identity verified by staff.**
  **Do:** add "Identity verified by staff" → candidate reloads the link and goes through check-in.
  **Expect:**
  - Candidate: "Identity check by a staff member" → "Continue" → "A staff member will now verify your identity…".
  - Staff: the hold "Waiting for staff to verify identity" → "Verify identity…" → method "Video call" → tick the
    confirmation → "Verified — candidate may start".
  - The candidate can start.
- [ ] **T14.3 Revoke.**
  **Do:** "Revoke…" → reason → "Revoke".
  **Expect:** it moves under "Ended". (Only exams that have not started yet are affected.)
- [ ] **T14.4 No camera** (optional, needs one more candidate).
  **Do:** give a new candidate "No camera" and assign them.
  **Expect:** the exam runs without ever asking for the camera.

## Stage 15 — Review queue (needs held or flagged exams from Stages 11–12)

- [ ] **T15.1 Views.**
  **Do:** open "Review queue".
  **Expect:** tabs Assigned to me / Unassigned / Escalated / Overdue / All waiting / Resolved, each with a count. Rows
  show undecided flags and a due badge such as "Flag decisions due in 71 h".
- [ ] **T15.2 Assign to me.**
  **Do:** click "Assign to me" on a row.
  **Expect:** it moves to "Assigned to me".
- [ ] **T15.3 Escalate.**
  **Do:** as Test Reviewer → session → Review tab → "Escalate…" → reason → "Escalate".
  **Expect:** it appears under "Escalated". The reviewer now sees "This review was escalated: an administrator
  resolves it." Resolve it as owner.
- [ ] **T15.4 Overdue holds.**
  **Do:** Settings → Review targets → "Decide a held exam within (minutes)" = 1 → "Save targets". Wait a minute with
  an exam on hold.
  **Expect:** "Hold decision overdue by …" in red, and it appears under "Overdue". Set the target back to 15.

## Stage 16 — Exam versions and regrade (Exam A)

- [ ] **T16.1 Edit a published exam.**
  **Do:** Exam A → "Edit" → Q1 → mark "Venus" as correct instead of "Mercury" → "Save changes".
  **Expect:** the message "This exam is published. Saving creates version 2…". The Versions panel lists v2 with
  "Answer key changed on 1 question". Tester 1's finished attempt still shows "version 1".
- [ ] **T16.2 View a version.**
  **Do:** "View" on v1 and v2.
  **Expect:** the questions with "✓ correct" and "changed: …" badges.
- [ ] **T16.3 Regrade.**
  **Do:** "Regrade with v2…" → "Attempts that started on" v1 → reason → "Preview" → "Regrade N attempts".
  **Expect:**
  - A table of before and after scores.
  - "Regraded N attempts of v1 with the answer keys of v2…".
  - Tester 1's session shows "Regraded …" and a "Score regraded" timeline entry.
- [ ] **T16.4 Put it back.**
  **Do:** edit Q1 back to "Mercury" (creates v3) and regrade again with v3.

## Stage 17 — Detection quality and identity thresholds

- [ ] **T17.1 Quality page.**
  **Do:** Quality → Time range "Last 7 days".
  **Expect:** "Per-detector results" with totals, kept, false detections and the precision proxy from your Stage 10
  decisions. Also "Identity decisions by trigger" and "Identity decisions by condition" (try "Break down by: Face
  lighting").
- [ ] **T17.2 Four-eyes threshold change.**
  **Do:** as owner → "Propose new thresholds…" → Confirmations 3 → a reason of 10+ characters → "Propose".
  **Expect:** "Version 2 is waiting for approval" with an impact preview. As owner you can only "Withdraw".
- [ ] **T17.3 Second-person approval.**
  **Do:** sign in as Test Admin → Quality → "Approve and activate".
  **Expect:** v2 becomes Active and v1 Retired.
- [ ] **T17.4 Rollback.**
  **Do:** as owner → History → v1 → "Restore…" → reason → "Restore now".
  **Expect:** v1 is active again immediately.

## Stage 18 — Camera & identity test tool (no exam running)

- [ ] **T18.1 Enrol yourself.**
  **Do:** Tools → "Camera & identity test" → "Enrol" (look at the screen, move your head slightly).
  **Expect:** "Enrolled N of 8 frames. Now start the live comparison."
- [ ] **T18.2 Live comparison.**
  **Do:** "Start live comparison".
  **Expect:** "Consistent with the enrolled person" with a high similarity.
- [ ] **T18.3 Someone else.**
  **Do:** your helper sits in front of the camera.
  **Expect:** within a few seconds, "Suspect — possibly a different person", then "Confirmed — a different person…".
- [ ] **T18.4 Bad light.**
  **Do:** you sit back down and turn the light off.
  **Expect:** "Could not verify" and lighting guidance, not "different person". Nothing is stored ("Reset" clears
  it).

## Stage 19 — Privacy

- [ ] **T19.1 Operational checks.**
  **Do:** open Privacy.
  **Expect:**
  - Rows for Retention job, Deletion on schedule, Privacy requests, Face analysis, Webhooks, Email alerts and API keys.
  - Each row says OK, Needs attention or Failing.
  - Email alerts should say they are not configured (expected: no email server is set up).
- [ ] **T19.2 Record an access request.**
  **Do:** "Record a privacy request…" → "Access (copy of their data)" → From "Tester 1" → link the candidate Tester 1 →
  "Record request".
  **Expect:** a request with a deadline 30 days out ("Due in 30 days").
- [ ] **T19.3 Export personal data.**
  **Do:** in that request → "Export the candidate's data (ZIP)".
  **Expect:** a ZIP downloads with the candidate record, the consent, the report, answers, events and the images. Mark
  the request Completed with "How it was answered".
- [ ] **T19.4 Extend a deadline.**
  **Do:** "Extend the deadline" → 30 days → reason (10+ characters) → "Save changes".
  **Expect:** "Extended by 30 days: …".
- [ ] **T19.5 Legal hold.**
  **Do:** Tester 1's session → "Legal hold…" → "Place legal hold".
  **Expect:** a "Legal hold" badge on the session. Privacy → Deletion schedule → "Legal holds" lists it.
- [ ] **T19.6 Erasure.**
  **Do:** record an "Erasure" request for Tester 4 (linked) → "Erase the candidate…" → "Erase permanently".
  **Expect:** "The candidate and their records were erased (N sessions, N images)…". Trying this on Tester 1 (on legal
  hold) is refused.
- [ ] **T19.7 Deletion schedule.**
  **Expect:** "Next 30 days" lists how many images are due for deletion on which date (30 days after each exam ended).

## Stage 20 — Settings

- [ ] **T20.1 Organisation and privacy contact.**
  **Do:** set "Privacy contact" to your email → "Save settings".
  **Expect:** "Settings saved." A candidate's privacy notice now shows that contact.
- [ ] **T20.2 Retention validation.**
  **Do:** set "Keep event records" to 10 → save.
  **Expect:** "Whole number of days, 30–3650". Put it back.
- [ ] **T20.3 Default policy.**
  **Do:** change one setting in "Default proctoring policy" → save → "New exam".
  **Expect:** the new exam starts with that setting. Afterwards use "Reset to product defaults" if you like.
- [ ] **T20.4 Require two-step sign-in.**
  **Do:** "Two-step sign-in" → "Required for everyone" → "Save requirement". Sign in as Test Reviewer.
  **Expect:** "Set up two-step sign-in — … requires two-step sign-in for your account"; nothing else is reachable until
  they set it up. Switch the requirement back to "Optional for everyone" afterwards.
- [ ] **T20.5 Reset someone's two-step sign-in.**
  **Do:** Users → Test Reviewer → "Reset two-step sign-in".
  **Expect:** their two-step sign-in shows Off.
- [ ] **T20.6 Evidence storage.**
  **Expect:** "This server has one storage location: Cloudflare R2" and "Stored now: N images…".
- [ ] **T20.7 Usage and limits.**
  **Expect:** Exams, Candidates and Exam sessions created this month, all "No limit".

## Stage 21 — Integrations

- [ ] **T21.1 Create a read-only API key.**
  **Do:** Integrations → API keys → name "Test key", Access "Read only", Expires "In 30 days" → "Create API key".
  **Expect:** the key (`sp_live_…`) is shown **once** → copy it → "I have stored it". The table shows "Expires in 30
  days".
- [ ] **T21.2 Use the key.**
  **Do:** in Terminal:

  ```bash
  curl -s http://localhost:8080/api/v1/exams -H "Authorization: Bearer PASTE_KEY_HERE"
  ```

  **Expect:** your three exams as JSON. "Last used" updates on the Integrations page.
- [ ] **T21.3 Permission refused.**
  **Do:**

  ```bash
  curl -s -X POST http://localhost:8080/api/v1/candidates -H "Authorization: Bearer PASTE_KEY_HERE" -H 'Content-Type: application/json' -d '{"name":"API Tester"}'
  ```

  **Expect:** `"error":"insufficient_scope"` (a read-only key cannot create candidates).
- [ ] **T21.4 Full-access key and safe retries.**
  **Do:** create a "Full access" key and send the POST above twice, with the new key, adding
  `-i -H 'Idempotency-Key: test-123'` both times (`-i` shows the reply headers).
  **Expect:** one candidate "API Tester" is created. The second reply is identical (header `Idempotent-Replayed: true`)
  and no duplicate is created.
- [ ] **T21.5 Revoke.**
  **Do:** "Revoke" → "Revoke key", then repeat T21.2 with that key.
  **Expect:** `"error":"invalid_api_key"`.
- [ ] **T21.6 Webhook address rules.**
  **Do:** "Add webhook" → Endpoint `http://localhost:9999/hook`.
  **Expect:** "Must start with https://" (production mode only allows public https addresses). See Part 3 for a full
  webhook test.
- [ ] **T21.7 Email alerts.**
  **Expect:** "Email alerts are unavailable: this server has no outgoing email (SMTP) configured…" and the controls are
  disabled. That's expected until email is set up (Part 3).
- [ ] **T21.8 External verifier.**
  **Expect:** status "Off". Choosing "Amazon Rekognition" shows the warning "Face images leave your servers…" and the
  AWS fields. Don't save unless you have AWS set up (Part 3).

## Stage 22 — Audit log

- [ ] **T22.1 See everything recorded.**
  **Do:** Audit log.
  **Expect:** entries for your sign-ins, exams published, users created, evidence views, holds, releases, erasure and
  so on, each with time, actor and target.
- [ ] **T22.2 Filter and export.**
  **Do:** filter `evidence.view` → "Download CSV (filtered)".
  **Expect:** only evidence views; a CSV downloads, and the export itself appears in the log.

## Stage 23 — Operator commands (Terminal, in the project folder)

- [ ] **T23.1 List organisations.**

  ```bash
  docker compose exec app node dist/scripts/org.js list
  ```

  **Expect:** "Example University", production, with usage counts.
- [ ] **T23.2 Retention dry run.**

  ```bash
  docker compose exec app node dist/scripts/retention.js --dry-run
  ```

  **Expect:** what would be purged now (probably nothing, because nothing is older than 30 days) and what is kept
  under legal hold.
- [ ] **T23.3 Break-glass access** (on the test reviewer only).

  ```bash
  docker compose exec app node dist/scripts/staff-access.js --email reviewer@example.com --reset-mfa --reset-password --reason "Testing break-glass recovery"
  ```

  **Expect:** a temporary password printed once. The reviewer's two-step sign-in is off and their sessions are ended.
  The audit log shows it with actor "System".
- [ ] **T23.4 Sandbox organisation** (optional; it creates a second organisation).

  ```bash
  docker compose exec app node dist/scripts/org.js create --name "Sandbox Test" --owner-email sandbox-owner@example.com --kind sandbox
  ```

  **Expect:**
  - A temporary owner password is printed once.
  - Signing in as that owner shows the banner "Sandbox — data is deleted after 14 days; not for real candidates.".
  - Settings → Usage shows limits (5 exams, 50 candidates, 100 sessions a month).
  - Candidate welcome screens show "Practice environment".

## Stage 24 — Accessibility (optional)

- [ ] **T24.1 Keyboard only.**
  **Do:** take a short exam (a new assignment on Exam A) with only Tab, Shift-Tab, the arrow keys, Space and Enter.
  **Expect:** everything is reachable. Focus moves to each new screen's heading. "Skip to the question" appears on the
  first Tab. Dialogs keep focus inside them and Esc closes them (except "Return to fullscreen").
- [ ] **T24.2 Screen reader.**
  **Do:** turn on VoiceOver (⌘F5) during an exam.
  **Expect:** questions, answer states and alerts are read out. The countdown is announced only at 10, 5 and 1 minute.
- [ ] **T24.3 Narrow screen.**
  **Do:** make the staff window very narrow (or zoom to 400%).
  **Expect:** the pages reflow without sideways scrolling.

---

# Part 3 — What needs extra setup

| Feature | What's missing on this setup | How to test it later |
|---|---|---|
| Email alerts, "Send test email", security emails | No email server (`SMTP_HOST`, `SMTP_FROM` in `.env`) | Add SMTP settings to `.env`, then `docker compose up -d`. Test: Integrations → Email alerts → recipients → "Send test email". |
| Webhooks (test ping, deliveries, retries, signatures) | Production mode only sends to public `https://` addresses | Use a public request-catcher (e.g. webhook.site; test data will be sent to that site), or the deployed server's real LMS endpoint. |
| Single sign-on (OpenID Connect / SAML) and SCIM | An identity provider (Microsoft Entra ID, Okta, Google…) | Follow `docs/OPERATIONS.md` §7. You can already open Settings → Single sign-on → "Add identity provider" and see the form and its checks. |
| Second opinion (Amazon Rekognition) | An AWS account with Rekognition access (charged per call) | `docs/EXTERNAL_VERIFIER.md`. |
| Several evidence storage locations, `storage-move` | Only one location (R2) is configured | Add `STORAGE_LOCATIONS` in `.env` (`docs/OPERATIONS.md` §2). |
| Key rotation (`rekey`) | Rotating `EVIDENCE_KEY` on your real data | Only on a backup copy; see `docs/OPERATIONS.md`. |
| Prometheus metrics (`/metrics`) | `METRICS_TOKEN` not set | Set `METRICS_TOKEN` (24+ characters), then `curl -H "Authorization: Bearer <token>" http://localhost:8080/metrics`. |
| Busy-server protection, separate vision workers | Needs many simultaneous candidates | `e2e/scripts/load-test.ts` and `docker-compose.vision.yml` (`docs/PERFORMANCE.md`). |
| Safari and Firefox candidates with a real webcam | Not covered by the automatic tests | Repeat Stage 5–8 once in each browser. |

## Small issues noticed while writing this guide

- **Numeric answer with a tolerance.** The server and the import accept a numeric answer key with a tolerance (for
  example `1.00|0.005`). The exam editor rejects it ("The correct answer must be a number"). An imported exam that uses
  a tolerance can't be saved in the editor without changing that answer.
- **"Reject" shown to the proposer.** On the Quality page, the person who proposed new thresholds also sees "Reject",
  but the server always refuses their own rejection. They can only "Withdraw".
- **Wrong setting name.** The "Email alerts" operational check says `SMTP_URL`; the real setting is `SMTP_HOST`.
