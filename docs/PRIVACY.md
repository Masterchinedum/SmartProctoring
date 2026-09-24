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
| Data minimisation | Behavioural analysis runs **in the candidate's browser**; video never leaves the device. **No continuous video, audio or screen recording.** Only (a) screenshots at the moment something was observed, (b) identity-check frames that did not cleanly match (plus check-in/resume frames), and (c) the protected identity reference are uploaded. Clipboard contents are never read. |
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
| Identity reference: 3–5 face templates (128 numbers each) + reference images | Check-in | `identity_references` + evidence store | Yes | Evidence retention period after the session ends |
| Liveness / check frames | Check-in, resume, reconnect | Evidence store | Yes | Evidence retention period |
| Identity-sample probe images (only when not a clean match, unless configured) | During exam | Evidence store | Yes | Evidence retention period |
| Event screenshots (moment of observation) | During exam | Evidence store | Yes | Evidence retention period |
| Copy of the approved ID photo attached to an ID-photo identity event (the exact photo compared, for review) | Check-in | Evidence store | Yes | Evidence retention period of that session (also after the photo on file is replaced or removed; kept under legal hold) |
| Event metadata (type, times, confidence, measurements) | During exam | Postgres `events`, `identity_checks` | — | Event retention period (default 365 days) |
| Answers, timing, pauses, periods | During exam | Postgres | — | Your exam-records policy |
| Device info (camera label, SHA-256 of camera id, user agent, screen size) | Check-in | `device_records` | — | With the session record |
| Staff actions (reviews, notes, holds, evidence views) | Staff | `audit_log`, `notes` | — | Audit retention per your policy |
| Webhook notifications (candidate name + external id, exam title, event type/title/observation/times, links) — **no images, face data or scores** | Integrations | `webhook_deliveries` (sent to endpoints your admins configure) | — | 30 days (delivery log) |
| Alert emails (candidate name, exam, observation sentence, link) — **no images** | Integrations | `email_alerts` queue, your SMTP provider | — | 30 days (queue) |
| API-key activity (writes, report/event reads) | Your integrations | `audit_log` (actor `api_key`) | — | Audit retention per your policy |

Not collected: continuous video/audio, screen contents, other applications, other monitors or
devices, clipboard contents, keystrokes, location.

## 3. Access control

* Candidates authenticate with a single-use-per-session access link; they cannot see evidence,
  references or other candidates.
* Staff roles: **owner / admin** (configure exams, candidates, retention, users) and **reviewer**
  (view sessions and evidence, review events, add notes, manage holds). There is no public or
  unauthenticated evidence URL; evidence responses are `Cache-Control: no-store`.
* Every evidence view, review decision, hold/release/termination, re-enrolment, settings change and
  retention purge is written to `audit_log` (Audit log page).

## 4. Retention and deletion

* **Evidence** (screenshots, identity references, check frames, probe images, reference templates):
  deleted `evidenceRetentionDays` (organisation default 30; per-exam override
  `policy.retention.evidenceDays`) after the session ends. A retention job runs hourly (and via
  `pnpm --filter @sp/server retention:run`). The blob is deleted from storage, the template bytes are
  cleared, and a tombstone (“deleted under the retention policy on …”) remains so reports stay
  consistent.
* **Legal hold**: an administrator can place a session under legal hold (e.g. an open appeal); its
  evidence is not purged until the hold is lifted. Holds are audit-logged.
* **Event metadata** is deleted after `eventRetentionDays` (default 365).
* **Sessions that never end** (not started, paused or on hold and then forgotten) are closed automatically
  after `abandonAfterDays` without activity (default 30; status terminated, no score, answers kept), so the
  retention periods above start running.
* Deleting a candidate removes their ID photo and template immediately.

## 5. Candidate rights and alternatives

Provide an alternative assessment arrangement for candidates who do not consent or need an
accommodation (e.g. a camera-less policy, or in-person proctoring). The notice directs candidates to
the privacy contact configured in Settings. Data subject access requests can be served from the
session report plus the evidence listed in the session's Identity and Events tabs.

## 6. Accuracy and fairness

Face verification and behavioural detection are probabilistic. The product (a) gates identity
decisions on image quality and returns “unable to verify” instead of guessing, (b) requires repeated
confirmation before raising a possible-different-person event during an exam, (c) routes uncertain
cases to human review, and (d) measures accuracy per detection. See `docs/accuracy/` for methodology,
results and the protocol to evaluate on your own consented, demographically diverse data before
launch.

## 7. Sub-processors

None by default: all analysis runs in the candidate's browser and on your own server. If you enable
S3-compatible storage or managed Postgres/Redis, list those providers as sub-processors. If you configure SMTP
(email alerts), your email provider receives alert emails (candidate name, exam, observation, link — no
images). Webhooks and the integration API send data only to systems your administrators configure; list
them in your records of processing.
