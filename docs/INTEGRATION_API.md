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

* Create a key in **Integrations → API keys** (administrators only). The key looks like
  `sp_live_` followed by 43 characters and is **shown once** — store it in your secret manager.
  SmartProctoring keeps only a SHA-256 hash and a short prefix (e.g. `sp_live_AbCdEfGh`) so you can
  recognise it in the list, together with its creation time and when it was last used.
* A key belongs to one organisation and has the fixed scope `integration` (everything on this page).
  It cannot use the staff API.
* **Revoke** a key in the same list; it stops working immediately. Creating and revoking keys, and
  every write made with a key, is recorded in the audit log (actor “API key ‘name’”).
* At most 25 active keys per organisation. Rotate by creating a new key, deploying it, then revoking the
  old one.

Every request sends the key as a bearer token:

```bash
export SP=https://proctor.example.com
export SP_KEY=sp_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
curl -s "$SP/api/v1/exams" -H "Authorization: Bearer $SP_KEY"
```

### Conventions

* JSON in, JSON out (`Content-Type: application/json`). Timestamps are **epoch milliseconds** (UTC).
* Errors: non-2xx with `{ "error": "<code>", "message": "...", "details"?: ... }`.
  `401 invalid_api_key` (missing, malformed or revoked key), `404 *_not_found` (also for ids of another
  organisation), `400 validation_failed` (with `details: [{ path, message }]`), `409` for state
  conflicts (e.g. `exam_not_published`), `429 rate_limited`.
* Rate limit: 600 requests per minute per key by default (`API_RATE_LIMIT_PER_MINUTE`). Responses carry
  `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-reset`; on 429 wait `retry-after` seconds.
* Lists accept `limit` (1–500, default 100) and `offset`, and return `{ items, total }`.

---

## 2. Endpoints

### Exams

`GET /api/v1/exams?status=published` → `{ items: [{ id, title, status, durationSec }] }`
(`status` is `draft`, `published` or `archived`; omit it for all).

```bash
curl -s "$SP/api/v1/exams?status=published" -H "Authorization: Bearer $SP_KEY"
```

### Candidates

`POST /api/v1/candidates` `{ name, email?, externalId? }` — **upsert by `externalId`**: if a candidate with
this external id exists, its name (and email, when given) is updated and `200 { candidate, created: false }`
is returned; otherwise a candidate is created: `201 { candidate, created: true }`. Without `externalId` a new
candidate is always created. Use your own stable user id (student number, employee id) as `externalId`.

```bash
curl -s -X POST "$SP/api/v1/candidates" -H "Authorization: Bearer $SP_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ada Lovelace","email":"ada@example.edu","externalId":"S-10442"}'
# {"candidate":{"id":"7c0e…","name":"Ada Lovelace","email":"ada@example.edu","externalId":"S-10442","createdAt":1790240400000},"created":true}
```

`GET /api/v1/candidates?externalId=S-10442` (or `?email=`) → `{ items: [candidate], total }`.

### Assignments (exam links)

`POST /api/v1/exams/:examId/assignments` `{ candidateIds?: string[], externalIds?: string[] }` (together at
most 1000) → `{ items: [{ sessionId, candidateId, candidateName, externalId, accessLink, existing }] }`.

* The exam must be **published** (`409 exam_not_published` otherwise).
* Unknown candidates → `400 validation_failed` naming them (nothing is created).
* **Idempotent per candidate**: a candidate who already has a not-yet-finished session for this exam keeps
  it — the existing `sessionId` and link are returned with `existing: true`. Retrying a request is safe.
* `accessLink` is the candidate's personal link (`https://…/take/<token>`). Treat it like a password: send
  it only to that candidate (e.g. show it behind your LMS login).

```bash
curl -s -X POST "$SP/api/v1/exams/$EXAM_ID/assignments" -H "Authorization: Bearer $SP_KEY" \
  -H 'Content-Type: application/json' -d '{"externalIds":["S-10442","S-10443"]}'
```

### Sessions

A *session* is one candidate's attempt at one exam.

`GET /api/v1/sessions?examId=&externalId=&candidateId=&status=&limit=&offset=` → `{ items, total }` (same shape as below, with `accessLink: null`)
(`status` accepts a comma-separated list: `invited,ready,active,paused,on_hold,submitted,terminated`).

`GET /api/v1/sessions/:id` →

```json
{
  "id": "5f0c…", "status": "submitted", "endReason": "candidate_submitted",
  "exam": { "id": "…", "title": "Algebra final" },
  "candidate": { "id": "…", "name": "Ada Lovelace", "email": "ada@example.edu", "externalId": "S-10442" },
  "createdAt": 1790240400000, "startedAt": 1790244000000, "endedAt": 1790247300000,
  "remainingMs": 0, "timerRunning": false, "pauseCount": 1,
  "score": { "points": 17, "maxPoints": 20, "autoGraded": true },
  "counts": { "integrity": 2, "uncertain": 1, "technical": 0, "unreviewed": 3, "open": 0, "highSeverity": 1 },
  "hold": null,
  "accessLink": "https://proctor.example.com/take/…",
  "staffUrl": "https://proctor.example.com/admin/sessions/5f0c…"
}
```

* `status` / `endReason`: `submitted` with `candidate_submitted`, `time_expired` or `staff_submitted`;
  `terminated` with `staff_terminated` or `abandoned` (closed automatically after the organisation's
  inactivity period — no score is implied). `hold` is set while the exam is `on_hold` (reason, since, message).
* `counts` are observations awaiting or after human review — not a verdict. Dismissed events are not
  counted in the category totals.
* `score` is present once answers were graded (open questions are not auto-graded: `autoGraded: false`).

`GET /api/v1/sessions/:id/report?tz=Europe/Berlin` → the same final report the staff app shows (periods,
totals of observed / unobserved time, identity-check summary, event counts per category and type, notable
events, factual observations, reviewer notes, limitations). The only difference: evidence references are
replaced by `evidenceCount` and a `staffUrl` per event, plus a `staffUrl` for the session. `tz` sets the time
zone for times written in sentences (default UTC).

`GET /api/v1/sessions/:id/events?category=&type=&severity=&since=` → `{ items: Event[] }`, chronological.
Each event: `id, sessionId, type, category (integrity | uncertain | neutral | technical), severity (info | low
| medium | high), source, status (open | closed), title, observation, startedAt, endedAt, durationMs,
confidence, details, context, review { status, by, byName, at, note }, notesCount, receivedAt, deliveredLate,
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
| `session.held` | The exam was put on hold (identity review, pause limit, staff…) | session fields, `reason` = hold reason |
| `session.released` | Staff released a hold | session fields, `reason`, `requireCheck` |
| `session.pause_requested` | The candidate asked for a pause that needs approval | session fields, `pauseRequest { id, reason }` |
| `session.submitted` | Submitted by the candidate, on time expiry or by staff | session fields, `endReason`, `score` |
| `session.terminated` | Ended by staff, or closed automatically after inactivity | session fields, `endReason`, `reason` (`abandoned_after_inactivity` or null) |
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
constant time, and reject timestamps more than 5 minutes away from your clock (replay protection).

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

1. Nightly or on enrolment: `POST /api/v1/candidates` for each student (upsert by your student id).
2. When the exam window opens: `POST /api/v1/exams/:examId/assignments` with the students' `externalIds`;
   show each student their `accessLink` inside the LMS.
3. Subscribe a webhook to `session.submitted`, `session.terminated`, `session.held` and (optionally)
   `event.created` with minimum severity `high`.
4. On `session.submitted`: fetch `GET /api/v1/sessions/:id` (score, counts) and, after staff review,
   `GET /api/v1/sessions/:id/report` to archive the report with the grade.

Candidates that should not be able to start any more (e.g. withdrew) can be handled by staff (terminate).
Sessions nobody touches are closed automatically after the organisation's inactivity period
(Settings → Retention, default 30 days) with `endReason: "abandoned"`.
