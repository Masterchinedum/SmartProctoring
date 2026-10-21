# Privacy, data protection and retention

SmartProctoring processes biometric data (face images and face templates). This document describes
exactly what is collected, why, where it is stored, who can access it and when it is deleted. It is
written to support your Data Protection Impact Assessment (GDPR Art. 35), biometric-privacy notices
(e.g. Illinois BIPA, Texas CUBI, Washington), and candidate-facing transparency. It is not legal
advice — review it with counsel for your jurisdictions.

## 1. Principles built into the product

| Principle | How it is implemented |
|---|---|
| Transparency | Before any camera analysis the candidate sees a notice listing what is monitored, what is stored, what is **not** stored, the retention period and a contact. The notice is versioned (`PRIVACY_NOTICE_VERSION`) and the candidate's consent is recorded with timestamp and version. A “what is monitored?” link stays visible during the exam. |
| Data minimisation | Behavioural analysis runs **in the candidate's browser**; video never leaves the device. **No continuous video, audio or screen recording.** Only (a) screenshots at the moment something was observed, (b) identity-check frames that did not cleanly match (plus check-in/resume frames), and (c) the protected identity reference are uploaded. Clipboard contents are never read. Exam-page interaction is used as **timing only** (when a key was last pressed, the pointer last moved, the page last scrolled, an answer last changed), in the browser, to learn where the candidate looks while working; keys, typed text and pointer positions are never read or recorded, and the timing is never uploaded. |
| Purpose limitation | The identity reference is created per exam session and used only to check that the same person continues that session. It is never reused for another exam, another candidate, or any other purpose, and is never used for identification (1:N search). |
| Security | Images and face templates are encrypted at rest with AES-256-GCM (per-object IV, key id for rotation). Keys come from the environment/KMS, never the database. Access requires an authenticated staff account; every view of an image is written to the audit log. |
| Human oversight | The system reports *observations* with confidence and evidence; it never declares misconduct. “Unable to verify” (poor image) is always kept distinct from “possible different person”. Holds are resolved by people. |
| Storage limitation | Evidence is deleted automatically after the retention period (see §4). |

## 2. Data inventory

| Data | Source | Stored where | Encrypted | Retention |
|---|---|---|---|---|
| Candidate name, email, external id | Administrator | Postgres `candidates` | DB-level (use encrypted volumes) | Until the candidate is deleted |
| Approved ID photo + its face template (optional) | Administrator upload | Evidence store + `candidates.id_photo_embedding` | Yes (AES-256-GCM) | Until removed by an administrator or the candidate is deleted |
| Consent record (time, notice version) | Candidate | `exam_sessions` | — | With the session record |
| Identity reference: up to 8 face templates (128 numbers each), their mean, the candidate's own similarity baseline (a few summary numbers) + reference images | Check-in | `identity_references` + evidence store | Yes | Evidence retention period after the session ends |
| Liveness / check frames | Check-in, resume, reconnect | Evidence store | Yes | A check that passes with nothing to review keeps none of its frames: they are deleted right after it passes (the reference images and a probe image shown to staff are kept as separate copies). Frames of checks that failed, were held, abandoned or flagged for review: evidence retention period |
| Identity-sample probe images (only when not a clean match, unless configured) | During exam | Evidence store | Yes | Evidence retention period |
| Identity-sample burst frames: per-frame face template while the burst (3 frames within ~1 s) is being decided, then per-frame metadata (similarity, quality measurements, face box / landmarks); images of the burst's representative frame only | During exam | `identity_sample_frames` (+ evidence store for the one kept image pair) | Template: yes, cleared as soon as the burst is decided — or, for a burst that will never be decided, when the exam is paused, put on hold or ended (at the latest ~30 s later, by the background job, for any session); images of the burst's other frames are deleted when it is decided | Face box / landmarks: evidence retention period; the rest: event retention period |
| Event screenshots (moment of observation) | During exam | Evidence store | Yes | Evidence retention period |
| Copy of the approved ID photo attached to an ID-photo identity event (the exact photo compared, for review) | Check-in | Evidence store | Yes | Evidence retention period of that session (also after the photo on file is replaced or removed; kept under legal hold) |
| Event metadata (type, times, confidence, measurements) | During exam | Postgres `events`, `identity_checks` | — | Event retention period (default 365 days) |
| Answers, timing, pauses, periods | During exam | Postgres | — | Your exam-records policy |
| Device info (camera label, SHA-256 of camera id, user agent, screen size) | Check-in | `device_records` | — | With the session record |
| Staff actions (reviews, notes, holds, evidence views) | Staff | `audit_log`, `notes` | — | Audit retention per your policy |
| Review decisions (each conclusion on an event with its note, who, when) and the session review (assignee, escalation note, outcome and note) | Staff | `event_reviews`, `session_reviews`, `events` (current decision), `audit_log` | — | With the session (deleted with the candidate); audit copies per your audit retention. The outcome (never the notes) is sent to integrations |
| Exam-page interaction timing: epoch ms of the last keydown, pointer movement / press, scroll and answer change — **no keys, no text, no pointer position** | Candidate's browser, during the exam | **Browser memory only** (the in-browser monitoring engine; its learned "working region" — head-pose statistics while typing / using the mouse — is kept in memory from one exam period to the next in the same page and discarded when the page closes or the camera changes). Never uploaded. It appears in the evaluation trace only when a tester opens the exam with `?trace=1` and downloads the file themselves | — | Until the page is closed |
| Webhook notifications (candidate name + external id, exam title, event type/title/observation/times, links) — **no images, face data or scores** | Integrations | `webhook_deliveries` (sent to endpoints your admins configure) | — | 30 days (delivery log) |
| Alert emails (candidate name, exam, observation sentence, link) — **no images** | Integrations | `email_alerts` queue, your SMTP provider | — | 30 days (queue) |
| API-key activity (writes, report/event reads) | Your integrations | `audit_log` (actor `api_key`) | — | Audit retention per your policy |
| Integration API responses kept for `Idempotency-Key` retries (e.g. a created candidate's name, email and external id; assigned candidates' exam links) | Your integrations (POST requests sent with the header) | `api_idempotency_keys` | AES-256-GCM (`EVIDENCE_KEY`) | 24 hours |
| **Optional, off by default:** probe image + one reference/ID-photo image sent for an external second opinion at the decision points an administrator selected (`docs/EXTERNAL_VERIFIER.md`) | Identity checks | Sent to the configured provider (e.g. Amazon Rekognition, in the chosen AWS region) over TLS; SmartProctoring stores only the resulting score/outcome with the check | In transit (TLS) | Provider's terms (opt out of AI-service content use) |
| External verifier credentials (AWS access key pair, optional) | Administrator | `organizations.settings` | Yes (AES-256-GCM) | Until removed or the provider is switched off |
| Accommodations: what was granted (e.g. extra time, identity verified by staff), a **broad basis only** (accessibility / technical / other — never a diagnosis), scope, dates, who granted / revoked it, and an optional administrators' note | Administrator | `accommodations`; a copy of what applied (without basis or note) on each session | Note: yes (AES-256-GCM); visible to administrators only, never in the audit log, reports or integrations | Until revoked records are deleted with the candidate |
| Staff identity verification (method, optional note, who, when) — when identity is verified by staff instead of the automated face check | Staff | `events` (`identity_verified_by_staff`), `audit_log` | — | Event retention period |
| Privacy requests (the register of data-subject requests): kind, who it is from (as given), linked candidate and session, channel, received / due dates, extension and its reason, what was asked, assignee, how it was answered, when the candidate's data was exported / erased | Administrator; consent withdrawal: the candidate in the exam app | `privacy_requests`, `audit_log` | What was asked: yes (AES-256-GCM); administrators and owners only | Kept as the record that requests were answered (they outlive an erased candidate: the candidate link becomes empty). Delete per your records policy |
| Personal-data exports (ZIP: candidate record, accommodations, sessions with report, answers, events, identity checks, decrypted images) | Generated on request by an administrator | **Not stored on the server**: streamed to the administrator's browser; the request records when, the audit log who | In transit (TLS); handle the file as personal data | Yours: send it securely, then delete your copy |
| Retention job runs (start, end, counts, last error) | Server | `job_status` | — | The last run only |

Not collected: continuous video/audio, screen contents, other applications, other monitors or
devices, clipboard contents, keystrokes (which keys; only the time of the last key press is used, in the
browser — see the interaction-timing row above), pointer positions, location.

**Where it is stored (data residency).** "Evidence store" above means the storage location the organisation
chose under *Settings → Where evidence images are stored*, among the locations the server operator configured (for
example one bucket per region; `docs/OPERATIONS.md` §2). **Only the images** live there: event screenshots,
identity reference images, check frames, probe images and approved ID photos (and their event-linked copies),
encrypted. **Everything else stays where the server's database is** — candidate names, emails and external ids,
exams and answers, event records, **face templates** (identity references, ID-photo and check-frame templates are
database columns), consent records, the audit log, privacy requests — and so do database backups, logs and Redis.
Images stored before the choice changed stay in their previous location until the operator moves them
(`storage:move`, audit-logged as `evidence.storage_moved`); each image row records its location, so it is always read
and deleted there. Data that must stay in one region in full needs the database there too (a separate deployment).

## 3. Access control

* Candidates authenticate with a single-use-per-session access link; they cannot see evidence,
  references or other candidates.
* Staff roles: **owner / admin** (configure exams, candidates, retention, users) and **reviewer**
  (view sessions and evidence, review events, add notes, manage holds). There is no public or
  unauthenticated evidence URL; evidence responses are `Cache-Control: no-store`.
* Every evidence view, review decision, hold/release/termination, re-enrolment, settings change and
  retention purge is written to `audit_log` (Audit log page). Administrators can download it as CSV for an audit
  or a data-subject request (it contains staff names and the notes recorded with decisions; the download is
  itself audit-logged).

## 4. Retention and deletion

* **Evidence** (screenshots, identity references, check frames, probe images, reference templates):
  deleted `evidenceRetentionDays` (organisation default 30; per-exam override
  `policy.retention.evidenceDays`) after the session ends. A retention job runs hourly (and via
  `pnpm --filter @sp/server retention:run`). The blob is deleted from storage, the template bytes are
  cleared, and a tombstone (“deleted under the retention policy on …”) remains so reports stay
  consistent.
* **Legal hold**: an administrator can place a session under legal hold (e.g. an open appeal); its
  evidence is not purged until the hold is lifted. Holds are audit-logged.
* **Event metadata** (events, identity checks, check frames, identity-sample burst frames, evidence tombstones) is
  deleted after `eventRetentionDays` (default 365). Face boxes and landmarks stored with check frames and burst frames
  are removed earlier, together with the evidence.
* **Sessions that never end** (not started, paused or on hold and then forgotten) are closed automatically
  after `abandonAfterDays` without activity (default 30; status terminated, no score, answers kept), so the
  retention periods above start running. A scheduling window counts as activity until it closes, so a session
  scheduled weeks ahead is not closed before its window.
* **Reopening an exam for recovery** (staff, `POST /api/admin/sessions/:id/reopen`) keeps the session's evidence: the
  candidate is verified again against the original identity reference. While reopened the session has no end time,
  so retention waits until it ends again (from the new end). It is refused once the evidence was deleted under the
  retention policy, after a consent withdrawal, and for an exam the candidate submitted themselves; it never brings
  deleted data back. The staff member's reason is kept in the timeline and the audit log, not sent to integrations.
* Deleting a candidate removes their ID photo and template immediately.
* **Withdrawal of consent** (`POST /api/candidate/consent/withdraw`, from the exam app): the exam ends at once
  (status terminated, end reason `candidate_withdrew`, no score; answers and the event timeline are kept), the
  session's images, face templates and face geometry are deleted right away (not at the end of the retention
  period), images still in the candidate's browser are refused when they arrive, and a consent-withdrawal request is
  added to the register so staff arrange an alternative assessment. A session under legal hold keeps its images
  (the request says so). The approved ID photo belongs to the candidate record and is kept unless staff remove it.
  In the exam app it is reached from the privacy notice ("What is monitored?" on the start screen and in the exam):
  *Withdraw my consent…* explains what happens (the exam ends now and cannot be continued, monitoring and the camera
  stop, images and identity data are deleted straight away, answers are kept but not scored, the provider will be in
  touch), takes an optional reason (passed to staff in the register entry) and needs an explicit "I understand"
  before it ends the exam. Images still queued in the browser are deleted on the device, not sent. The notice itself
  (version 2026-10-21) tells candidates under "Your choices" that they can withdraw at any time.
* **Showing that deletion happens**: Privacy → *Deletion schedule* lists what is due over the next 30 days, what is
  past its date but not yet deleted, the sessions under legal hold, and the retention job's last run (recorded in the
  database whichever server ran it); *Operational checks* turns a failing or stalled job into a warning.

## 5. Candidate rights and alternatives

Provide an alternative assessment arrangement for candidates who do not consent or need an
accommodation. The product supports this per candidate (Candidates → Accommodations): extra time, rest
breaks, no head-turn challenge, assistive technology, behaviour detectors off, an approved support
person, **identity verified by a staff member instead of the automated face check** (no face template is
created and no face comparison is made), and **no camera at all**. Each one is shown to the candidate on
the welcome screen, the privacy notice describes exactly what still runs (without a camera it mentions no
camera monitoring and no images), and every exam rule it changed is listed on the session and in its
report. The notice directs candidates to the privacy contact configured in Settings.

**Data-subject requests** are handled in Privacy → *Requests* (administrators and owners):

1. Record the request the day it arrives (what was asked, who it is from, how it came in, the date received): the
   deadline is one month from receipt (GDPR Art. 12(3)); it can be extended once or more, up to two further months in
   total, with the reason you give the person. Overdue and due-soon requests are counted on the page and in the
   operational checks.
2. Link it to the candidate record when there is one. **Access**: *Export the candidate's data (ZIP)* — records and
   decrypted images of every session (answer keys and face templates are not included; images already deleted are
   listed in its README). Check the archive, send it securely. **Erasure**: *Erase the candidate…* deletes the
   candidate, their sessions and images — refused while an exam of theirs is running or under legal hold (lift the
   hold first, or reject the request with the reason, e.g. an open appeal). **Rectification**: correct the record on
   the Candidates page. **Restriction**: place their sessions under legal hold. **Objection**: offer an accommodation.
3. Complete or reject the request with a note saying how it was answered. Every step (created, exported, erased,
   extended, completed) is in the audit log.

Exports and erasures exist only through a request, so every copy that left the system is accounted for.

## 6. Accuracy and fairness

Face verification and behavioural detection are probabilistic. The product (a) gates identity
decisions on image quality and returns “unable to verify” instead of guessing, (b) requires repeated
confirmation before raising a possible-different-person event during an exam, (c) routes uncertain
cases to human review, (d) measures accuracy per detection, and (e) lets an organisation replace the
automated face check by staff verification for a candidate the technology does not serve well (for
example a facial difference or a face covering) — documented as an accommodation, not as an exception
hidden in the data. See `docs/accuracy/` for methodology,
results and the protocol to evaluate on your own consented, demographically diverse data before
launch.

## 7. Sub-processors

None by default: all analysis runs in the candidate's browser and on your own server. If you enable
S3-compatible storage or managed Postgres/Redis, list those providers as sub-processors. **Per region:** each evidence
storage location (Settings → Where evidence images are stored) is a sub-processor of the images stored there, in that
location's region — list, for each organisation, the provider and region of its chosen location (and of any location
still holding its earlier images until they are moved), next to the provider and region of the database, which holds
the face templates and all other records whatever location is chosen.

**External face verifier (optional, off by default).** If an administrator enables a second-opinion provider
(Settings → Integrations; `docs/EXTERNAL_VERIFIER.md`), that provider — for Amazon Rekognition, Amazon Web
Services — receives **face images** (the live camera image and the reference or ID photo it is compared with) for
the selected checks (check-in, resume, suspected change of person) and is a **sub-processor of biometric data**:
list it, sign its data processing terms, choose the AWS region for data residency, and opt out of the provider's
use of AI-service content (AWS Organizations AI services opt-out policy) before enabling it. While it is active the
candidate privacy notice names the provider, and images are sent only for candidates who accepted that notice
(consent at or after the moment it was enabled). The provider's answer never records a "possible different person"
on its own. `EXTERNAL_VERIFIERS=none` disables the feature server-wide. If you configure SMTP
(email alerts), your email provider receives alert emails (candidate name, exam, observation, link — no
images). Webhooks and the integration API send data only to systems your administrators configure; list
them in your records of processing.
