# Integration API and webhooks

SmartProctoring can be connected to a learning-management system (LMS), HR system or any other back
office in two directions:

* **Integration API** (`/api/v1/*`, you call us): list exams, create or update candidates, assign
  candidates to exams (you receive the candidates' personal exam links), and read session status,
  results, the final report and the event list.
* **Webhooks** (we call you): near-real-time notifications when something happens — a proctoring event
  was observed, an exam was put on hold, a pause needs approval, an exam was submitted, and so on.

An administrator sets both up in the staff app under **Integrations** (Settings → Integrations).

> Privacy: neither the API nor webhooks ever carry images, face templates or face-similarity scores.
> Evidence stays behind staff sign-in; responses contain links into the staff app instead
> (`staffUrl`). Wording is observational ("more than one person was visible"), never a verdict.

---

## 1. API keys

* Create a key in **Integrations → API keys** (administrators only): a name, its **access** (full access, read only,
  or chosen permissions — the scopes below) and its **expiry** (in 30 days, 90 days, 1 year (the default) or 2 years,
  on a date, or never; at most 3 years ahead). The key looks like `sp_live_` followed by 43 characters and is
  **shown once** — store it in your secret manager. SmartProctoring keeps only a SHA-256 hash and a short prefix
  (e.g. `sp_live_AbCdEfGh`) so you can recognise it in the list, together with its access, creation time, expiry and
  when it was last used.
* A key belongs to one organisation and only works on the integration API (`/api/v1/*`, everything on this page): it
  cannot use the staff API.
* **Revoke** a key in the same list; it stops working immediately. Creating and revoking keys (with their scopes and
  expiry), and every write made with a key, is recorded in the audit log (actor “API key ‘name’”).
* At most 25 active keys per organisation (revoked and expired keys do not count).

### Scopes

Every endpoint requires one scope. Give each system only what it needs: a reporting or archiving tool needs only
`:read` scopes; an LMS that enrols students and hands out exam links needs `candidates:write` and `assignments:write`.

| Scope | Allows | Endpoints |
|---|---|---|
| `exams:read` | listing exams | `GET /exams` |
| `candidates:read` | finding candidates | `GET /candidates` |
| `candidates:write` | creating and updating candidates | `POST /candidates` |
| `assignments:write` | assigning candidates to exams, scheduling and rescheduling when they can start, and seeing their personal exam links | `POST /exams/{examId}/assignments`, `PUT /sessions/{id}/window`; also `accessLink` in `GET /sessions/{id}` |
| `sessions:read` | attempts: status, times, score, event counts, hold, review | `GET /sessions`, `GET /sessions/{id}` |
| `reports:read` | final reports | `GET /sessions/{id}/report` |
| `events:read` | proctoring event lists | `GET /sessions/{id}/events` |

* **Full access** (the staff app's default) has every scope; **Read only** has every `:read` scope — no changes and
  no candidates' exam links (`accessLink` is `null` in `GET /sessions/{id}` without `assignments:write`, because a link
  lets its holder take the exam as the candidate). **Choose permissions…** ticks scopes one by one.
* A request without the scope its endpoint needs gets `403 insufficient_scope` with
  `details: { "requiredScope": "candidates:write", "scopes": [...] }` and
  `WWW-Authenticate: Bearer realm="…", error="insufficient_scope", scope="candidates:write"`.
* **Keys created before scopes existed** (API version 1.0) were given every scope of version 1.1 — the full access
  they had — and no expiry, so existing integrations keep working unchanged. Scopes added in later versions are never
  added to existing keys automatically: create a new key that has them.

### Expiry and rotation

* After its expiry time a key is refused with `401 api_key_expired` (the message names the date); it is never
  extended. The Integrations page marks keys that expire within 14 days (“Expires in 5 days”) and expired keys, with a
  banner; **Privacy → Operational checks** warns about keys expiring within 14 days and fails for a key that expired
  while a system was still using it; operators can alert on the Prometheus gauge
  `sp_cluster_api_keys_expiring_soon`.
* **Rotate** a key (before it expires, when a person who knew it leaves, or if it may have leaked): create a new key
  with the same access, deploy it to the connected system, check that the new key's “Last used” changes, then revoke
  the old key. Both keys work in between, so there is no downtime. `Idempotency-Key`s are shared by all keys of the
  organisation, so a retry sent with the new key is still recognised.

Every request sends the key as a bearer token:

```bash
export SP=https://proctor.example.com
export SP_KEY=sp_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -s "$SP/api/v1/exams" -H "Authorization: Bearer $SP_KEY"
```

### Conventions

* JSON in, JSON out (`Content-Type: application/json`). Timestamps are **epoch milliseconds** (UTC).
* Responses may gain **new fields** in later versions (never removed or changed in meaning within a major version):
  ignore fields you do not know. Enumerations (e.g. event `type`) may gain values.
* Errors: non-2xx with `{ "error": "<code>", "message": "...", "details"?: ... }`. Codes:

  | Status | `error` | When |
  |---|---|---|
  | 400 | `validation_failed` | the request does not match the schema (`details: [{ path, message }]`) |
  | 400 | `invalid_idempotency_key` | a malformed `Idempotency-Key` header |
  | 401 | `invalid_api_key` | missing, malformed, unknown or revoked key |
  | 401 | `api_key_expired` | the key is past its expiry |
  | 403 | `insufficient_scope` | the key lacks the endpoint's scope |
  | 404 | `exam_not_found`, `session_not_found` | unknown id — also for ids of another organisation |
  | 409 | `exam_not_published`, `already_started`, `invalid_state` | state conflicts (e.g. rescheduling an exam that started or ended) |
  | 409 | `idempotency_key_in_use` | the first request with this `Idempotency-Key` is still running (retry after `Retry-After` seconds) |
  | 409 | `quota_exceeded` | creating a candidate or exam sessions would exceed one of the organisation's limits (below) |
  | 422 | `idempotency_key_reused` | the `Idempotency-Key` was used for a different request |
  | 429 | `rate_limited` | too many requests |

* Rate limit: 600 requests per minute per key by default (`API_RATE_LIMIT_PER_MINUTE`). Responses carry
  `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`; on 429 wait `retry-after` seconds.
* **Quotas.** Your SmartProctoring operator may set limits for your organisation: candidate records, and exam sessions
  created per calendar month **in UTC** (a sandbox organisation — for trials and testing, see below — has limits by
  default: 50 candidates, 100 sessions a month). Creating a candidate or assigning candidates beyond a limit answers
  `409 quota_exceeded`, nothing is created, and `details` says which limit: `{ "quota": "candidates" |
  "sessionsPerMonth", "limit": 100, "used": 98, "requested": 5, "resetsAt": 1793491200000 | null, "kind": "sandbox" |
  "production" }` (`resetsAt`: when the monthly count starts again, 00:00 UTC on the 1st). Do not retry it unchanged:
  wait for `resetsAt`, assign fewer candidates, or ask for a higher limit. Your administrators see the usage under
  Settings → *Usage and limits*. Updating an existing candidate, and assignments that return a candidate's existing
  session (`existing: true`), are never refused.
* **Sandbox organisations** are for building and testing an integration, not for real candidates: everything works
  as in production, but their exam sessions, images and candidates are deleted automatically 14 days (by default)
  after their last use, every webhook carries `"sandbox": true`, and the candidate's exam page says it is a practice
  environment.
* Lists accept `limit` (1–500, default 100) and `offset`, and return `{ items, total }`.

### Idempotency

Every `POST` and `PUT` accepts an optional **`Idempotency-Key`** header, so a retry after a timeout or a dropped
connection can never apply the request twice (for example, create a second candidate when no `externalId` is sent):

```bash
curl -s -X POST "$SP/api/v1/candidates" -H "Authorization: Bearer $SP_KEY" \
  -H "Idempotency-Key: 3f1d7a0e-5b1c-4f7e-9d67-2d4b1c0a9e11" \
  -H 'Content-Type: application/json' -d '{"name":"Ada Lovelace"}'
```

* The key: **1–255 characters** — letters, digits and `- _ . : ~ + / =`. Use a new random UUID per logical request
  and reuse it only for retries of that request. Anything else is refused (`400 invalid_idempotency_key`).
* The first **successful (2xx)** response is stored for **24 hours**. A repeat with the same key and the same request
  returns it again — same status and body — with the header **`Idempotent-Replayed: true`**; nothing is executed again.
  Stored responses are kept encrypted (they can contain exam links) and deleted after 24 hours.
* "The same request" means the same method, path, query string and JSON body (the order of object keys does not
  matter). The same key with a different request is refused with **`422 idempotency_key_reused`**.
* A **failed** request (any 4xx or 5xx) changed nothing and stores nothing: retry it — corrected if needed — with the
  same key.
* While the first request with a key is still running, a concurrent repeat gets **`409 idempotency_key_in_use`** with
  `Retry-After: 1`; retry it and you receive the stored response. A request interrupted mid-way (e.g. the server
  restarted) no longer blocks its key after 60 seconds.
* Keys are scoped to your **organisation** and shared by all its API keys (a retry after a key rotation is still
  recognised); other organisations' keys never collide with yours. A key without the endpoint's scope is refused
  (403) before any replay.
* Without the header, requests behave as before. `POST /exams/{examId}/assignments` is safe to retry even without it
  (a candidate keeps their unfinished attempt), but the header returns exactly the first response, including
  `existing: false` for the attempts it created.

### OpenAPI document

`GET /api/v1/openapi.json` returns the **OpenAPI 3.1** description of this API — every endpoint, parameter, request
and response schema, error code, required scope and header — for code generators (e.g. openapi-generator,
openapi-typescript), API clients (Postman, Insomnia) or contract tests on your side. It needs **no API key** (it
contains no organisation data; limited to 60 requests per minute per address) and its `servers` entry is this
server's API base URL. The same document is in the repository as `docs/openapi.json`; both are generated from the
schemas the server itself uses to validate requests (`packages/shared/src/integrations.ts`), and the server's
contract tests check every response against them. `info.version` is the API version (see the changelog at the end).

```bash
curl -s "$SP/api/v1/openapi.json" -o smartproctoring-openapi.json
```

---

## 2. Endpoints

The scope each endpoint requires is given in brackets; the OpenAPI document lists the same.

### Exams

`GET /api/v1/exams?status=published` [`exams:read`] → `{ items: [{ id, title, status, durationSec, version }] }`
(`status` is `draft`, `published` or `archived`; omit it for all). `version` is the exam version candidates who start
now get (null while the exam was never published): publishing, and every later edit of a published exam, creates a
new version, and each attempt keeps the version it started with — its questions, answer keys and points.

```bash
curl -s "$SP/api/v1/exams?status=published" -H "Authorization: Bearer $SP_KEY"
```

### Candidates

`POST /api/v1/candidates` [`candidates:write`] `{ name, email?, externalId? }` — **upsert by `externalId`**: if a candidate with
this external id exists, its name (and email, when given) is updated and `200 { candidate, created: false }`
is returned; otherwise a candidate is created: `201 { candidate, created: true }`. Without `externalId` a new
candidate is always created. Use your own stable user id (student number, employee id) as `externalId`. Creating a
candidate beyond the organisation's limit answers `409 quota_exceeded` (an update of an existing one never does).

```bash
curl -s -X POST "$SP/api/v1/candidates" -H "Authorization: Bearer $SP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.edu","externalId":"S-10442"}'
# {"candidate":{"id":"7c0e…","name":"Ada Lovelace","email":"ada@example.edu","externalId":"S-10442","createdAt":1790240400000},"created":true}
```

`GET /api/v1/candidates?externalId=S-10442` (or `?email=`) [`candidates:read`] → `{ items: [candidate], total }`.

### Assignments (exam links)

`POST /api/v1/exams/:examId/assignments` [`assignments:write`] `{ candidateIds?: string[], externalIds?: string[], window?: { startsAt?, endsAt? } }`
(at least one id, at most 1000 in each list) → `{ items: [{ sessionId, candidateId, candidateName, externalId, accessLink, existing, window }] }`.

* The exam must be **published** (`409 exam_not_published` otherwise).
* Unknown candidates → `400 validation_failed` naming them (nothing is created).
* More new sessions than the organisation may still create this month → `409 quota_exceeded` (nothing is created; see
  *Quotas* above). Candidates who already have a session for the exam do not count.
* **Idempotent per candidate**: a candidate who already has a not-yet-finished session for this exam keeps
  it — the existing `sessionId` and link are returned with `existing: true`. Retrying a request is safe.
* `accessLink` is the candidate's personal link (`https://…/take/<token>`). Treat it like a password: send
  it only to that candidate (e.g. show it behind your LMS login).
* `window` (optional) is a **scheduling window** for the new sessions: `startsAt` / `endsAt` as epoch milliseconds or
  ISO 8601 date-times with a time zone (`"2026-11-02T09:00:00+01:00"`); either may be omitted or `null` (open-ended).
  The candidate can **start** the exam only inside it; the camera and identity check-in may begin **30 minutes before**
  `startsAt`. An exam that started inside its window is **never cut off** when the window closes (it runs until its
  clock runs out, through pauses and reconnections). Outside the window the candidate's link shows when the exam
  opens / that it has closed, in the candidate's own time zone. Rules: `endsAt` after `startsAt`, at least 5 minutes
  long, `endsAt` not in the past, at most two years ahead (`400 validation_failed` otherwise). A candidate's existing
  unfinished session keeps its own window (the response shows it): change it with `PUT /sessions/:id/window`.

```bash
curl -s -X POST "$SP/api/v1/exams/$EXAM_ID/assignments" -H "Authorization: Bearer $SP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"externalIds":["S-10442","S-10443"],"window":{"startsAt":"2026-11-02T09:00:00Z","endsAt":"2026-11-02T12:00:00Z"}}'
```

### Rescheduling

`PUT /api/v1/sessions/:id/window` [`assignments:write`] `{ window: { startsAt?, endsAt? }, note? }` → the session (below). Sets, changes or
clears (both `null`) the window of a session **that has not started**; `409 already_started` once the candidate
started, `409 invalid_state` once the session ended. The same rules as on assignment. Recorded in the audit log
(actor: the API key) and on the session's timeline, and sent as `session.rescheduled`.

### Sessions

A *session* is one candidate's attempt at one exam.

`GET /api/v1/sessions?examId=&externalId=&candidateId=&status=&limit=&offset=` [`sessions:read`] → `{ items, total }` (same shape as below, with `accessLink: null`)
(`status` accepts a comma-separated list: `invited,ready,active,paused,on_hold,submitted,terminated`).

`GET /api/v1/sessions/:id` [`sessions:read`] →

```json
{
  "id": "5f0c…", "status": "submitted", "endReason": "candidate_submitted",
  "exam": { "id": "…", "title": "Algebra final" },
  "examVersion": 3,
  "accommodations": ["extra_time"],
  "candidate": { "id": "…", "name": "Ada Lovelace", "email": "ada@example.edu", "externalId": "S-10442" },
  "createdAt": 1790240400000, "startedAt": 1790244000000, "endedAt": 1790247300000,
  "remainingMs": 0, "timerRunning": false, "pauseCount": 1,
  "score": { "points": 17, "maxPoints": 20, "autoGraded": true, "regraded": 0 },
  "counts": { "integrity": 2, "uncertain": 1, "technical": 0, "unreviewed": 3, "open": 0, "highSeverity": 1 },
  "hold": null,
  "window": { "startsAt": 1790240400000, "endsAt": 1790251200000 },
  "accessLink": "https://proctor.example.com/take/…",
  "review": { "state": "resolved", "outcome": "no_concerns" },
  "staffUrl": "https://proctor.example.com/admin/sessions/5f0c…"
}
```

* `accessLink`: the candidate's personal exam link, only for keys with the `assignments:write` scope (`null`
  otherwise, in lists, in reports and in the answer of `PUT /sessions/:id/window`).
* `status` / `endReason`: `submitted` with `candidate_submitted`, `time_expired`, `staff_submitted` or
  `resume_limit` (the exam was interrupted — reopened in a new browser window, or disconnected — more often or for
  longer than the exam's resume rules allow, and the rules say to end it; the saved answers are graded);
  `terminated` with `staff_terminated`, `candidate_withdrew` (the candidate withdrew consent in the exam app; no
  score, its images deleted) or `abandoned` (closed automatically after the organisation's
  inactivity period — no score is implied). `hold` is set while the exam is `on_hold` (reason, since, message;
  `resume_limit` = held under the resume rules for a staff decision, `recovery` = staff reopened the ended exam and
  the candidate has to pass a fresh identity check before it continues).
* `window`: the scheduling window (null: the exam can be started any time). Abandoned-session housekeeping counts
  inactivity from the end of the window at the earliest.
* **Reopened exams**: staff may reopen an exam that ended by time, by staff, after inactivity or under the resume
  rules (never one the candidate submitted, nor after a consent withdrawal or once its images were deleted under the
  retention policy). It then goes back to `on_hold` (`hold.reason` `recovery`; `endReason`, `endedAt` and `score` are
  cleared until it ends again) — or to `invited` if it had never started — and `session.reopened` is sent. Treat a
  `session.submitted` / `session.terminated` as final only together with the review outcome if your process allows
  recovery.
* `counts` are observations awaiting or after human review — not a verdict. Dismissed events are not
  counted in the category totals.
* `accommodations`: the kinds of approved accommodations applied to the attempt (`extra_time`, `rest_breaks`,
  `no_liveness_challenge`, `assistive_technology`, `detection_exemptions`, `support_person`,
  `staff_identity_verification`, `no_camera`); extra time is already included in the duration. The report lists
  each one and every exam rule it changed (`accommodations.exceptions`), never why it was granted.
* `score` is present once answers were graded (open questions are not auto-graded: `autoGraded: false`), with the
  answer keys of the attempt's own exam version (`examVersion`; null until the attempt starts). `regraded` counts
  administrator regrades (a corrected answer key applied to finished attempts — see `session.regraded` below); the
  report's `score.regrades` lists each one with the score before it and the reason.
* `review { state, outcome }`: the staff review of the attempt — `state` `none` (not picked up yet), `open`,
  `escalated` or `resolved`; `outcome` once resolved: `no_concerns`, `concerns` (refer under your
  integrity process), `inconclusive` or `technical_issues` (problems outside the candidate's control may have
  affected the attempt). The outcome is a staff decision, never automated; it is also sent as `session.reviewed`.

`GET /api/v1/sessions/:id/report?tz=Europe/Berlin` [`reports:read`] → the same final report the staff app shows (periods,
totals of observed / unobserved time, identity-check summary, event counts per category and type, notable
events, factual observations, reviewer notes, limitations, the review with its outcome and note, and the incidents
— flags close in time, grouped). The differences: evidence references are replaced by `evidenceCount` and a
`staffUrl` per event, plus a `staffUrl` for the session, and the reviewer-facing explanations of events are left
out (they quote detector and identity measurements). `tz` sets the time zone for times written in sentences
(default UTC; an unknown zone falls back to UTC). Face-similarity values are always `null`. The full structure is in
the OpenAPI document (`SessionReport`).

`GET /api/v1/sessions/:id/events?category=&type=&severity=&review=&since=` [`events:read`] → `{ items: Event[] }`,
chronological. `type` takes a comma-separated list; `review` is `unreviewed`, `reviewed` or `dismissed`.
Categories: `integrity` (a potential integrity issue), `uncertain` (an observation that could not be assessed
reliably), `technical` (a technical problem), `neutral` (a session change) and `exception` (the attempt ran under
an approved accommodation / policy exception — context, never a flag). `review.resolution` is the reviewer's
structured conclusion: `concern`, `no_concern`, `accommodation`, `technical`, `inconclusive` or `false_detection`
(null for older plain decisions and for undecided events).
Each event: `id, sessionId, type, category (integrity | uncertain | technical | neutral | exception), severity
(info | low | medium | high), source, status (open | closed), title, observation, startedAt, endedAt, durationMs,
confidence, details, context, review { status, resolution, by, byName, at, note }, notesCount, receivedAt, deliveredLate,
evidenceCount, staffUrl`. `since` filters by the time the server received the latest version (use it for
incremental polling).

```bash
curl -s "$SP/api/v1/sessions/$SESSION_ID/events?category=integrity" -H "Authorization: Bearer $SP_KEY"
```

Reading reports and event lists is recorded in the audit log.

---

## 3. Webhooks

Configure in **Integrations → Webhooks**: an `https://` URL, the notification types to receive, the
minimum severity for proctoring-event notifications, and whether it is active. The **signing secret**
(`whsec_…`) is shown once when the webhook is created (and again only when you rotate it). **Send test**
delivers a `ping` immediately.

### Notification types

| Type | When | `data` |
|---|---|---|
| `event.created` | A potential-integrity, uncertain or technical event is observed, at or above the webhook's minimum severity (neutral session changes are never sent as events) | event fields (below) |
| `event.closed` | Such an event (one with a duration) ended | event fields |
| `identity.mismatch` | A possible different person was observed (always sent when subscribed, regardless of minimum severity) | event fields |
| `session.held` | The exam was put on hold (identity review, pause limit, staff, `staff_verification` = waiting for a staff member to verify identity under that accommodation…) | session fields, `reason` = hold reason |
| `session.released` | Staff released a hold | session fields, `reason`, `requireCheck` |
| `session.pause_requested` | The candidate asked for a pause that needs approval | session fields, `pauseRequest { id, reason }` |
| `session.submitted` | Submitted by the candidate, on time expiry, by staff, or ended under the exam's resume rules | session fields, `endReason`, `score`, `reason` (`too_many_reconnects` / `offline_too_long` when `endReason` is `resume_limit`, else null) |
| `session.terminated` | Ended by staff, by the candidate withdrawing consent, or closed automatically after inactivity | session fields, `endReason`, `reason` (`abandoned_after_inactivity`, `consent_withdrawn` or null) |
| `session.regraded` | An administrator regraded the finished attempt with corrected answer keys / points (sent only when its score or a question's result changed) | session fields, `score` (the new one), `reason` (the administrator's) |
| `session.reviewed` | Staff completed the review of the attempt (sent again if a reopened review is completed again) | session fields, `outcome` (`no_concerns` \| `concerns` \| `inconclusive` \| `technical_issues`; never the reviewer's note) |
| `session.rescheduled` | The scheduling window was set, changed or cleared (staff app or `PUT /sessions/:id/window`), before the exam started | session fields, `window` and `previousWindow` (`{ startsAt, endsAt }` or null; never the staff note) |
| `session.reopened` | Staff reopened an ended exam for recovery | session fields (`status` `on_hold` or `invited`, `endReason` null), `reason` = how it had ended (e.g. `time_expired`), `addedMinutes`; never the staff reason |
| `ping` | “Send test” in the staff app | `{ webhookId, message, sentBy }` |

Event fields: `id, sessionId, type, category, severity, title, observation, status, startedAt, endedAt,
durationMs, confidence, deliveredLate, sessionStatus, candidate { id, name, externalId }, exam { id, title },
staffUrl`. Session fields: `sessionId, status, endReason, at, eventId, reason, candidate, exam, staffUrl`.
For events reported by the candidate's browser, `title` and `observation` are always the standard wording of the
event type (never text supplied by the browser); `pauseRequest.reason` is the candidate's own text with links
removed (`[link removed]`).

### Request format

```http
POST /your/endpoint HTTP/1.1
Content-Type: application/json; charset=utf-8
User-Agent: SmartProctoring-Webhooks/1.0
X-SmartProctoring-Event: event.created
X-SmartProctoring-Delivery: 3f1d7a0e-5b1c-4f7e-9d67-2d4b1c0a9e11
X-SmartProctoring-Attempt: 1
X-SmartProctoring-Signature: t=1790244123,v1=5d41402abc4b2a76b9719d911017c592…

{"id":"3f1d7a0e-5b1c-4f7e-9d67-2d4b1c0a9e11","type":"event.created","createdAt":1790244122874,
 "orgId":"…","data":{"id":"…","sessionId":"…","type":"multiple_people","category":"integrity",
 "severity":"high","title":"More than one person in view",
 "observation":"More than one person was visible in the camera view.","status":"open",
 "startedAt":1790244101000,"endedAt":null,"durationMs":null,"confidence":0.91,"deliveredLate":false,
 "sessionStatus":"active","candidate":{"id":"…","name":"Ada Lovelace","externalId":"S-10442"},
 "exam":{"id":"…","title":"Algebra final"},
 "staffUrl":"https://proctor.example.com/admin/sessions/…?event=…"}}
```

* **Sandbox**: deliveries from a sandbox organisation (test data, not real candidates) have `"sandbox": true` next to
  `orgId`; production deliveries have no `sandbox` field. Use it to keep test notifications out of real records.
* **Respond with any 2xx within 10 seconds** (do the work asynchronously). Anything else — other status
  codes, redirects (never followed), timeouts, connection errors — is a failed attempt.
* **Retries**: after 30 s, 1 min, 2 min, 5 min, 15 min, 30 min, 1 h, 2 h and 6 h (10 attempts, about
  10.5 hours in total); then the delivery is marked failed. While an endpoint is down, later
  notifications wait instead of hammering it.
* **Idempotency**: `X-SmartProctoring-Delivery` (= the body's `id`) is the same on every retry and on a
  manual redelivery. Store processed ids and ignore repeats — delivery is *at least once*.
* **Ordering is not guaranteed** (retries). Use `createdAt` and the event/session timestamps, or read the
  current state from the API (`GET /api/v1/sessions/:id`) when the order matters.
* **Automatic disabling**: when an endpoint fails 20 consecutive attempts (`WEBHOOK_DISABLE_AFTER_FAILURES`)
  over at least an hour with no success, the webhook is switched off, the staff app shows a *Disabled after
  repeated failures* badge, the audit log records it and the alert recipients get an email. Fix the
  endpoint, then re-enable it: pending notifications (up to 72 hours old) are delivered.
* The staff app lists the latest 100 deliveries per webhook (status, attempts, last HTTP status / error) and
  can **redeliver** any of them (same delivery id). Delivery records are kept for 30 days.
* Webhook URLs must be `https://` and must resolve to public internet addresses: private, loopback,
  link-local and similar ranges are refused when the URL is saved and again when connecting.

### Verifying the signature

`X-SmartProctoring-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>`. Compute
the HMAC over the **raw request body exactly as received** (before any JSON parsing), compare in
constant time, and reject timestamps more than 5 minutes away from your clock (replay protection). The two functions
below (Node.js and Python) are copied verbatim by SmartProctoring's own tests and run against signatures made by the
server's signing code, so they stay correct; in another language, follow the same steps: split the header on `,`
into `t` and `v1`, require `t` to be digits and `v1` 64 lowercase hex characters, check the time, compute
HMAC-SHA256 with the secret over the bytes `<t>.` followed by the raw body, and compare in constant time.

Node.js (18+, no dependencies):

<!-- verify-snippet:start -->
```js
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a SmartProctoring webhook request.
 * @param {string | Buffer} rawBody  the request body exactly as received (not re-serialised JSON)
 * @param {string | undefined} header  the X-SmartProctoring-Signature header
 * @param {string} secret  the webhook's signing secret (whsec_...)
 * @param {number} [toleranceSec=300]  maximum clock difference accepted (replay protection)
 * @param {number} [nowSec]  current unix time in seconds (defaults to the system clock)
 * @returns {boolean}
 */
export function verifySmartProctoringSignature(rawBody, header, secret, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof header !== 'string' || !secret) return false;
  const parts = {};
  for (const item of header.split(',')) {
    const i = item.indexOf('=');
    if (i > 0) parts[item.slice(0, i).trim()] = item.slice(i + 1).trim();
  }
  if (!/^\d+$/.test(parts.t ?? '') || !/^[0-9a-f]{64}$/.test(parts.v1 ?? '')) return false;
  if (Math.abs(nowSec - Number(parts.t)) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${parts.t}.`).update(rawBody).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
```
<!-- verify-snippet:end -->

Python (3.8+, standard library only):

<!-- verify-snippet-python:start -->
```python
import hashlib
import hmac
import re
import time


def verify_smartproctoring_signature(raw_body, header, secret, tolerance_sec=300, now_sec=None):
    """Verify a SmartProctoring webhook request.

    raw_body: the request body exactly as received (bytes; not re-serialised JSON)
    header: the X-SmartProctoring-Signature header (str or None)
    secret: the webhook's signing secret (whsec_...)
    tolerance_sec: maximum clock difference accepted (replay protection)
    now_sec: current unix time in seconds (defaults to the system clock)
    """
    if not isinstance(header, str) or not secret:
        return False
    parts = {}
    for item in header.split(","):
        key, sep, value = item.partition("=")
        if sep and key.strip():
            parts[key.strip()] = value.strip()
    t, v1 = parts.get("t", ""), parts.get("v1", "")
    if not re.fullmatch(r"[0-9]+", t) or not re.fullmatch(r"[0-9a-f]{64}", v1):
        return False
    now = int(time.time()) if now_sec is None else now_sec
    if abs(now - int(t)) > tolerance_sec:
        return False
    if isinstance(raw_body, str):
        raw_body = raw_body.encode("utf-8")
    expected = hmac.new(secret.encode("utf-8"), t.encode("ascii") + b"." + raw_body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)
```
<!-- verify-snippet-python:end -->

In Flask, pass `request.get_data()` (the raw bytes) and `request.headers.get("X-SmartProctoring-Signature")`; in
Django, `request.body` and `request.headers.get("X-SmartProctoring-Signature")`.

Example receiver with Express (keep the body raw for verification):

```js
import express from 'express';
import { verifySmartProctoringSignature } from './verify-smartproctoring.js';

const app = express();
app.post('/hooks/smartproctoring', express.raw({ type: 'application/json' }), (req, res) => {
  if (!verifySmartProctoringSignature(req.body, req.get('X-SmartProctoring-Signature'), process.env.SP_WEBHOOK_SECRET)) {
    return res.status(400).send('bad signature');
  }
  const notification = JSON.parse(req.body.toString('utf8'));
  res.status(204).end(); // acknowledge fast, process asynchronously
  queueForProcessing(notification); // skip if notification.id was already processed
});
```

---

## 4. Typical LMS flow

0. Create one API key for the LMS with `exams:read`, `candidates:write`, `assignments:write`, `sessions:read` and
   `reports:read` (or full access), expiring in a year; put a reminder to rotate it in your calendar.
1. Nightly or on enrolment: `POST /api/v1/candidates` for each student (upsert by your student id), with an
   `Idempotency-Key` per request so retries are safe.
2. When the exam is scheduled: `POST /api/v1/exams/:examId/assignments` with the students' `externalIds` and the
   `window` in which they may start; show each student their `accessLink` inside the LMS (before the window the link
   shows when the exam opens). A student who has to move: `PUT /api/v1/sessions/:id/window`.
3. Subscribe a webhook to `session.submitted`, `session.terminated`, `session.held` and (optionally)
   `event.created` with minimum severity `high`.
4. On `session.submitted`: fetch `GET /api/v1/sessions/:id` (score, counts) and, after staff review,
   `GET /api/v1/sessions/:id/report` to archive the report with the grade.
5. On `session.regraded` (subscribe to it if you store grades): replace the stored grade with the new `score`.
6. On `session.reopened` (subscribe to it if staff may reopen exams for recovery, e.g. after a power cut): the attempt
   is in progress again; expect a new `session.submitted` / `session.terminated` (and a new score) later.

Candidates that should not be able to start any more (e.g. withdrew) can be handled by staff (terminate).
Sessions nobody touches are closed automatically after the organisation's inactivity period
(Settings → Retention, default 30 days) with `endReason: "abandoned"`.

## 5. Staff provisioning (SCIM 2.0) and single sign-on

Staff accounts (not candidates) can be provisioned by your identity provider over **SCIM 2.0** at
`<PUBLIC_URL>/scim/v2` with the organisation's SCIM token (`Authorization: Bearer sp_scim_…`, created by an owner in
Settings → Single sign-on; it is not an API key and API keys do not work there). Supported: `GET /ServiceProviderConfig`,
`/ResourceTypes`, `/Schemas`; `GET /Users` (filters `userName eq`, `externalId eq`, `id eq`, `emails.value eq`;
`startIndex` / `count` ≤ 200), `POST /Users`, `GET` / `PUT` / `PATCH` / `DELETE /Users/:id`. `userName` is the staff
member's email; the role comes from `roles` (`reviewer` or `admin`); `active: false` or `DELETE` disables the account
and signs it out everywhere; owners are never changed. No Groups resource, no bulk, no passwords. Errors use the SCIM
error schema; 600 requests per minute per token. Staff sign in with the organisation's OpenID Connect or SAML 2.0
identity provider. Set-up runbooks for Microsoft Entra ID, Okta and Google: `docs/OPERATIONS.md` §7.

---

## 6. Changelog

The API version is `info.version` of the OpenAPI document. Within version 1, changes are additive: new endpoints,
new optional request fields, new response fields and new enumeration values.

* **1.2.0** (October 2026)
  * **Quotas**: `POST /candidates` (a new candidate) and `POST /exams/{examId}/assignments` (new sessions) answer
    409 `quota_exceeded` with `details { quota, limit, used, requested, resetsAt, kind }` at one of the organisation's
    limits (candidates; exam sessions per calendar month in UTC).
  * **Sandbox organisations**: webhook envelopes of a sandbox carry `"sandbox": true`.
* **1.1.0** (October 2026)
  * **Scheduling and recovery**: a scheduling `window` on `POST /exams/{examId}/assignments`, on sessions and on
    assignment items; `PUT /sessions/{id}/window` to reschedule an attempt that has not started (409
    `already_started` / `invalid_state`); end reason and hold reason `resume_limit`, hold reason `recovery`; webhooks
    `session.rescheduled` and `session.reopened`; `session.submitted` carries `reason` for `resume_limit`.
  * **API keys** have **scopes** (403 `insufficient_scope`) and an optional **expiry** (401 `api_key_expired`);
    existing keys were given every scope and no expiry. `accessLink` in `GET /sessions/{id}` requires the
    `assignments:write` scope.
  * **`Idempotency-Key`** on every `POST` and `PUT` (`Idempotent-Replayed`, 409 `idempotency_key_in_use`, 422
    `idempotency_key_reused`, 400 `invalid_idempotency_key`).
  * **OpenAPI 3.1 document** at `GET /api/v1/openapi.json` (and `docs/openapi.json`). The events list documents its
    `review` filter. A Python webhook signature verifier next to the Node.js one.
* **1.0.0** (September 2026) — exams, candidate upsert, assignments with exam links, sessions, reports, events;
  signed webhooks.
