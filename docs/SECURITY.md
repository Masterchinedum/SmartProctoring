# Security

This document summarises SmartProctoring's threat model, the security controls in the product, the results
of the latest security review and a checklist for operators running it in production. Privacy commitments
(what is collected, retention, candidate rights) are in `docs/PRIVACY.md`; deployment in `docs/OPERATIONS.md`.

Report vulnerabilities privately to the maintainers; do not open public issues for them.

## 1. Threat model

**Assets.** Face images and face templates (biometric data), identity references, event evidence, exam
content and answer keys, candidate personal data, staff accounts, organisation API keys and webhook
secrets, external face-verifier credentials (AWS access keys, optional), the evidence encryption key, the integrity of the proctoring record (who took the exam, what was
observed).

**Actors and trust.**

| Actor | Authenticates with | Trusted for |
|---|---|---|
| Candidate (browser) | Access link token (256-bit, bearer) + `X-Client-Instance` | Nothing beyond its own session. The client is assumed hostile: it may be modified, replayed or scripted. |
| Accomplice | The candidate's link, if shared | Nothing — must not be able to act as the verified browser or skip identity checks. |
| Reviewer / admin / owner | Password + (when on, or required by the organisation) a TOTP / recovery code, **or** single sign-on through the organisation's identity provider (OIDC / SAML) → staff session cookie (`sp_session`) | Their own organisation only, by role (reviewer < admin < owner). |
| Organisation identity provider (optional) | Its signature on ID tokens / SAML assertions (keys / certificates configured by an owner) | Asserting who a staff member of *its* organisation is, for the email domains the organisation claimed — never accounts of other organisations, never the owner role, never a disabled account. |
| SCIM client (the identity provider's provisioning) | The organisation's SCIM token (`sp_scim_…`) | Creating, updating and disabling its organisation's reviewer / admin accounts — never owners. |
| Integration (LMS/HR) | Organisation API key (`sp_live_…`) | Its organisation's exams, candidates, sessions, reports and events — never images or face data. |
| Webhook receiver | Verifies our HMAC signature | Receives notifications only; never images, templates or similarity scores. |
| External face verifier (optional, e.g. AWS Rekognition) | Our request, signed with the organisation's IAM key or the server's role | Off by default. When an admin enables it: receives face images for the selected identity checks; its answer is advisory — combined by a fixed table, it never records a "possible different person" on its own (`docs/EXTERNAL_VERIFIER.md`). |
| Other tenants | Their own credentials | Nothing in another organisation (all ids of other orgs are 404). |
| Network attacker / third-party website | — | Nothing (TLS, CSRF and clickjacking defences). |

**Trust boundaries.** Identity decisions run on the server against a reference the client never sees; the
browser only uploads JPEG frames. Behavioural detection runs in the browser and is therefore
*advisory*: a tampered client can suppress its own events (documented limitation), but it cannot forge a
server-side identity match, read other sessions, or change category/severity (they come from the catalog).

## 2. Controls

### Authentication and sessions
* Staff: scrypt password hashes (N=2^17, r=8, p=1 ≈ 128 MiB, 16-byte salt, parameters stored per hash; older
  hashes keep verifying and are upgraded at the next successful sign-in; at most two derivations run at once),
  uniform timing for unknown users (dummy hash), generic error message, `auth.login_failed` audit entries
  (address tried, reason, backoff state — never the password), 10 login attempts per minute per client IP, and a
  per-account backoff independent of the IP: after 5 consecutive failures (no 15-minute pause) the address
  waits 30 s, doubling up to 15 min, before any password is checked again (429 `too_many_attempts`). It is keyed
  on the address tried, so unknown addresses behave identically (no enumeration); attempts are charged before
  the password check (bursts cannot slip through); an administrator's password reset lifts it.
* Staff sessions: opaque 256-bit token in a signed cookie, only `sha256(token)` stored; `HttpOnly`,
  `SameSite=Lax`, `Secure` (default in production), new token at every login (no fixation), sliding idle
  timeout (`STAFF_SESSION_IDLE_MIN`, default 60) and absolute lifetime (`STAFF_SESSION_MAX_HOURS`, default
  12). Logout deletes the server-side session; password change/reset and disabling a user revoke sessions;
  the realtime WebSocket re-validates and closes with 4401 (the staff app then re-checks the sign-in and returns
  to the login page with the current page as return path).
* Two-step sign-in (staff): RFC 6238 TOTP (HMAC-SHA1, 30 s, 6 digits — what every authenticator app supports),
  accepting the previous/current/next step only, each step at most once per account (the last used step is
  stored and advanced by compare-and-set, so a code seen over a shoulder or replayed from a log is refused even
  within its 30 s). The secret (160 bits) is stored AES-GCM encrypted (AAD `totp:<userId>`; a not-yet-confirmed
  one under `totp-pending:<userId>`, valid 15 min) and is only ever shown during set-up; it is turned on by a
  correct code, never by the set-up request alone, and replacing it needs a code from the current factor too.
  10 recovery codes (`XXXXX-XXXXX`, ≈ 49 bits each, uniform from a 31-letter alphabet without look-alikes) are
  shown once and stored as `sha256("recovery:" + normalised code)`; each is consumed atomically (single use
  under concurrency); new codes replace all old ones and need a TOTP code. Sign-in with two-step sign-in on:
  the correct password creates no session, only a login challenge (256-bit token, sha256 stored, signed
  `HttpOnly`, `SameSite=Strict` cookie `sp_mfa` limited to `/api/auth`, 5 min, 5 code attempts, same-origin
  only). Every code attempt is charged to the account's backoff exactly like a password attempt, and the
  backoff is cleared only by a complete sign-in, so codes cannot be guessed faster than passwords.
  Re-authentication inside a signed-in session — the current password to change it; a code to create recovery
  codes, move to a new phone or turn it off — is charged to its own per-account backoff with the same schedule
  (one counter per secret, so a successful password change never resets code guessing), so a session left open
  or stolen cannot be used to guess faster than the sign-in allows (429, audited as `auth.login_failed` with
  `step`). Turning it on
  or moving it to a new phone signs out the account's other sessions. Turning it off needs the password and a
  code; it is refused (409 `mfa_required_by_organisation`) while the organisation requires it for the
  account's role. Owners can require it for administrators and owners or for everyone (`requireMfa`); staff
  without it then get only the set-up endpoints (403 `mfa_enrollment_required` everywhere else) until they
  set it up. An administrator can reset a lost factor (not their own; an owner's only by an owner), which also
  signs the person out. Every change is audited (`auth.mfa_enabled|mfa_replaced|mfa_disabled|
  mfa_recovery_codes_regenerated`, `auth.recovery_code_used`, `user.mfa_reset`, `auth.login` with `mfa`) and,
  with SMTP configured, emailed to the account owner so an unexpected change is noticed.
* Candidates: access token = 256 random bits (only sha256 + an AES-GCM copy for staff re-display stored),
  regenerating a link invalidates the old one immediately. Every write also requires the browser instance
  that passed the camera/identity check (`X-Client-Instance`); a new instance must pass a reconnect check.
  The verified instance id is echoed only to that instance. Concurrent use of the verified instance id from
  two places (a copied id) is detected from its requests — a different User-Agent, two networks alternating
  within 60 s, or two interleaved heartbeat `seq` streams (hashed IPs/UA only; a single network change, a
  dual-stack switch, a counter restart or a page reload are not signals): a `multiple_instances` event
  (`details.signal`, `ipHashes`, `uaChanged`) and a mandatory reconnect (identity) check for both devices.
* API keys: 256-bit, shown once, sha256 stored, revocation effective on the next request, per-key rate limit,
  every write/report read audited as actor `api_key`. They cannot call the staff API. Least privilege: each key
  carries **scopes** (`exams:read`, `candidates:read|write`, `assignments:write`, `sessions:read`, `reports:read`,
  `events:read`); every `/api/v1` route is registered from the endpoint catalogue with the scope it requires
  (`packages/shared/src/integrations.ts`; a contract test fails on any route outside it), checked after
  authentication (403 `insufficient_scope`, RFC 6750 `WWW-Authenticate`). Candidates' exam links (a credential for
  the exam) are returned only to keys with `assignments:write`, never in lists or reports. Keys may **expire**
  (at most 3 years ahead; refused with 401 `api_key_expired`, never extended — rotate instead); keys expiring
  within 14 days or expired while in use are flagged on the Integrations page, in the operational checks and by
  `sp_cluster_api_keys_expiring_soon`. Keys created before scopes existed were migrated with every scope (the
  access they had). Creation (with scopes and expiry) and revocation are audited.
* Integration API `Idempotency-Key`: scoped to the organisation (the unique index on `(org, key)` is the lock, so
  concurrent duplicates run once; the others get 409), bound to a hash of method, path, query and canonical body
  (another request with the key → 422), only 2xx responses are kept and replayed, for 24 h, **encrypted** with the
  keyring (they can contain exam links; AAD `api-idempotency:<id>`, covered by `rekey`) and purged hourly. The
  scope check runs before any replay. The OpenAPI document (`GET /api/v1/openapi.json`) is public: it describes the
  contract only (no organisation data) and is rate-limited per address.

### Single sign-on and SCIM (staff)
* **Who configures it.** Identity providers, "require single sign-on" and the SCIM token are changed by owners only
  (403 `owner_required` for administrators, who can view the configuration and test a connection); every change is
  audited (`sso.provider_created|updated|deleted|tested`, `settings.updated` with `requireSso`,
  `scim.token_created|rotated|revoked`). The OIDC client secret is write-only (responses say `clientSecretSet`),
  AES-GCM encrypted (AAD `sso-client-secret:<providerId>`, a `rekey` target) and never logged or audited.
* **Finding the organisation.** By the email domain typed on the sign-in page: each domain is claimed by one
  identity provider on the whole server (first come; public mailbox domains such as gmail.com are refused), and only
  addresses of the provider's claimed domains are accepted from it. Every provider also has its own sign-in link.
  Residual risk: on a shared server an organisation could claim a domain that is not its own and so receive other
  staff's sign-in attempts at its provider (it can never sign them in: accounts of other organisations are never
  matched). Operators of multi-tenant servers should review claimed domains (`sso_domains`); domain verification by
  DNS is a possible hardening.
* **OIDC.** Authorization code flow with PKCE (S256), `state` and `nonce` (`openid-client`, MIT): per-provider redirect
  URI (no mix-up between providers); the ID token's signature is verified against the provider's JWKS even though it
  comes from the token endpoint (asymmetric algorithms only; `alg: none` and HS256 are refused), with `iss` (= the
  configured issuer, which must match its discovery document), `aud` / `azp`, `exp` / `iat` (60 s tolerance) and the
  attempt's nonce. Discovery and JWKS are cached for an hour (refreshed on an unknown key id). `email_verified` must
  be true unless the owner turns that off for providers that do not send it (Microsoft Entra ID with a single-tenant
  issuer). Requests to the provider go through the SSRF guard below.
* **SAML 2.0.** SP-initiated only (HTTP-Redirect AuthnRequest, HTTP-POST response; unsolicited / IdP-initiated
  responses are refused). The XML signature is verified by `@node-saml/node-saml` / `xml-crypto` (never by our
  code): the Response (covering its only assertion) or the Assertion must be signed by one of the configured
  certificates; multiple or encrypted assertions are refused; only the signed content is read. Then: Conditions
  NotBefore / NotOnOrAfter (60 s skew), assertion at most 10 minutes old, AudienceRestriction = our SP entity ID,
  assertion Issuer = the configured entity ID, a bearer SubjectConfirmation whose Recipient is our ACS URL, whose
  InResponseTo is a request we sent for this provider and which has not expired, and each assertion ID used once
  (remembered until it would have expired).
* **The sign-in attempt** (10 minutes, one use) is bound to the browser that started it by the signed, httpOnly
  `sp_sso` cookie (SameSite=Lax, path `/api/auth/sso`, sha256 stored): the OIDC callback and the SAML completion
  step refuse another browser (no login CSRF, no replay into another browser). Failures return to the sign-in page
  with a general message and are audited as `auth.sso_failed` with the precise reason; the callback's `code` and
  `state` are redacted from logs.
* **Accounts.** A linked identity (provider + subject) signs in its account; otherwise the account with the asserted
  email (case-insensitive) in the provider's organisation is linked — refused when that account is already linked to
  another subject at the provider (a re-used address; an administrator unlinks it, `user.sso_unlinked`) — or, only
  when the owner switched on just-in-time accounts, created with the mapped / default role (never owner) and no
  password. Disabled accounts never sign in. Roles of existing accounts are not changed at sign-in.
* **Second factor.** After single sign-on the identity provider is responsible for multi-factor authentication:
  SmartProctoring's own two-step sign-in is neither asked nor required (the organisation's `requireMfa` applies to
  password sign-ins). Settings and the account page say so; owners must require MFA in their identity provider.
* **Require single sign-on** (owner): password sign-in of administrators and reviewers is refused after the right
  password (403 `sso_required`; said only then, so it does not reveal accounts) and their password sessions end.
  **Owners keep password + two-step sign-in as break-glass access**, and the operator's `staff-access` CLI remains.
  The last enabled provider cannot be disabled or deleted while it is required.
* **Provider changes.** Disabling a provider, pointing it at another issuer / entity ID, or deleting it ends every
  session signed in through it; a new issuer also removes its account links.
* **SCIM 2.0** (`/scim/v2`): bearer token per organisation (256 bits, `sp_scim_` prefix, shown once, sha256 stored and
  compared in constant time, one active token, rotation and revocation effective on the next request), rate limit
  per token (`SCIM_RATE_LIMIT_PER_MINUTE`, 600), organisation-scoped (other organisations' accounts are 404, an
  address used elsewhere is a 409). `active: false` / DELETE disables the account and ends its sessions and pending
  sign-in steps at once. SCIM cannot read or set passwords, cannot give the owner role and cannot change, disable or
  delete owners (403). Every change is audited with actor type `scim`. It carries no cookie authority (no CSRF).

### Review decisions
* Reviewer decisions are structured (resolution taxonomy) and kept as a history (`event_reviews`); changing another
  reviewer's decision requires a reason and is recorded as an override (shown as a disagreement in the staff app and
  on the Quality page). Bulk decisions never override someone else's decision and are limited to technical /
  low-severity flags; incident decisions are checked against incidents recomputed on the server. Reviewers assign
  reviews only to themselves; administrators assign anyone and resolve escalated reviews. Assignment, escalation,
  resolution and reopening are audit-logged, and the audit trail can be exported as CSV by administrators (the
  export itself is audited). Integrations receive the review outcome but never staff notes or the event
  explanations (which quote detector and identity measurements).

### Model governance
* Identity thresholds change only through a decision configuration: proposed by an administrator with a reason,
  approved or rejected by a **different** administrator / owner (four eyes; self-approval only when no other active
  administrator exists, and recorded as such). Reviewers can read configurations, calibration and drift but not
  change them; the settings API refuses threshold changes (409). Restoring an earlier, previously approved version is
  immediate (incident response) and withdraws an open proposal. Every step is audit-logged
  (`decision_config.proposed / approved / rejected / withdrawn / rolled_back`, with the values from and to).
* Concurrency: one active version and one open proposal per organisation (partial unique indexes), each transition
  under the organisation row lock; configurations are scoped to the organisation (another organisation's id is 404).
* Every identity decision records the configuration, calibration and model versions that made it, so a disputed
  decision can be traced to the exact rules in force.

### Privacy operations
* The privacy register (`/api/admin/privacy-requests`), the retention preview and the operational checks are for
  administrators and owners only (reviewers get 403); every query is scoped to the staff member's organisation.
* What a person asked is encrypted at rest (AES-256-GCM, AAD `privacy-request:<id>`, re-encrypted by `rekey`).
* A personal-data export is produced only from a register entry (`GET /privacy-requests/:id/export`, 10 per minute
  per address): `exportedAt` on the request and a `privacy_request.exported` audit entry (who, counts) are written
  before the archive streams. The archive is never stored on the server; it leaves out the session access link (a
  credential), staff-only decision versions, answer keys and face templates. `Cache-Control: no-store`.
* Erasure is possible only for an erasure request (`POST /privacy-requests/:id/erase` with `{confirm: true}`), is
  refused while an exam runs or a legal hold applies, and is audited (`candidate.deleted` with the request id,
  `privacy_request.erased`).
* Consent withdrawal (`POST /api/candidate/consent/withdraw`) is open to the holder of the access link whether or not
  their browser is the one in control: it can only end the exam and delete data, never extend access. Rate-limited
  (10 per minute per token).

### Scheduling and recovery
* Rescheduling (`POST /api/admin/sessions/:id/reschedule`) and reopening for recovery (`POST /sessions/:id/reopen`) are
  administrator actions (reviewers 403), organisation-scoped (404 otherwise), run under the session row lock and are
  audited (`session.rescheduled`, `session.reopened` with the reason). Integrations reschedule with
  `PUT /api/v1/sessions/:id/window` (audit `api.session.rescheduled`, actor the API key). Neither can extend what a
  link holder can do beyond the exam rules: the window bounds only the start; a reopened exam continues only after a
  fresh live-person and identity check against the original reference (the `reverify` check, with its attempt limit
  and check rate limit), and reopening is refused once that reference was purged or the candidate withdrew consent.
* The resume policy cannot be bypassed by opening more windows: the limit is checked under the row lock when a
  reconnect check would start (409 `resume_limit_reached`), and the time disconnected also by the sweeper. Staff notes
  and reasons for reschedules and reopenings never leave through webhooks (`session.rescheduled` carries the window,
  `session.reopened` the previous end reason).

### Organisations, sandboxes and quotas
* An organisation's kind (`production` / `sandbox`), its quotas and a sandbox's clean-up period are changed only by the
  server operator (`org:create` / `org:set`, server environment required); staff cannot (`PUT /settings` ignores the
  fields; `GET /usage` is read-only, administrators only). Every operator change is in the organisation's audit log
  (actor `system`, with the reason). The first owner's temporary password is printed once, never stored in clear,
  logged or emailed.
* Quotas are also an abuse control for open trials: limits on candidates and on exam sessions per month (counted when
  created; deleting candidates or sessions does not give them back, so a create–delete loop cannot get round them)
  are checked under a per-organisation lock in the creating transaction, for the staff app and the integration API
  alike, so parallel requests cannot exceed them.
* The sandbox clean-up selects sandbox organisations only and re-checks the kind under a lock on the organisation
  row before each deletion; turning a production organisation into a sandbox needs an explicit `--confirm-purge`.

### Authorisation
* Every `/api/admin/*` route has `requireStaff(<role>)`; every query is scoped by the staff member's
  organisation (other organisations' ids return 404). Only owners create/modify owners and admins; the last
  owner cannot be removed. Access links are returned only to admins, only on detail views.
* Candidate routes resolve the session from the token; check, evidence, event and question ids are scoped to
  that session.

### CSRF, clickjacking, browser hardening
* State-changing cookie requests and WebSocket upgrades must come from `PUBLIC_URL`'s origin (or the request's
  own host): `Origin` decides; without it, `Sec-Fetch-Site` (cross-site/same-site refused) and `Referer` are
  checked. Logout is protected the same way. Only JSON bodies are parsed for these routes (form posts get
  415, `text/plain` fails validation), and there is no CORS.
* The one exception is the SAML assertion consumer service (`POST /api/auth/sso/saml/<id>/acs`): the identity
  provider's page posts the response cross-site by design. It is the only route with a form-encoded body parser
  (its own plugin scope, 512 KB), it uses no cookie (SameSite=Lax cookies are not sent with it) and only records the
  validated identity on its sign-in attempt; the sign-in is completed by a same-site GET that must present the
  browser-binding cookie of the browser that started it.
* Response headers on every response: `Content-Security-Policy` (`default-src 'self'`, `script-src 'self'
  'wasm-unsafe-eval'` for self-hosted MediaPipe, `object-src 'none'`, `frame-ancestors 'none'`),
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` (the candidate URL contains the token),
  `Permissions-Policy: camera=(self), microphone=()…`, `X-Content-Type-Options: nosniff`,
  `Cross-Origin-Opener-Policy: same-origin`, HSTS when `COOKIE_SECURE` is on. `/api/*` responses are
  `Cache-Control: no-store`; evidence is `private, no-store` + `Cross-Origin-Resource-Policy: same-origin`.
* The web app renders all user-supplied text as text (no `dangerouslySetInnerHTML`, no markdown), keeps no
  credentials in `localStorage`, and only redirects to in-app `/admin` paths after login.

### Input handling
* zod validation on every body/query; unknown event types rejected; category/severity/title from the catalog.
* Body limits: JSON 2 MB; candidate JPEG 1 MB; ID photo 5 MB; offline-evaluation JSON 10 MB (admin).
  Candidate JPEGs must start with a JPEG signature and declare at most 4096 px per side / 3840×2160 px
  (checked from the frame header before decoding); the decoder additionally refuses > 50 MP.
* Per-session caps: 1,500 evidence items / 300 MB, 30 checks per hour, 5,000 events, 16 KB event details.
* SQL via drizzle with bound parameters only; `LIKE` wildcards escaped; storage keys built from UUIDs and
  validated (no traversal); CSV export neutralises formula prefixes (`= + - @` tab CR) and quotes cells.

### Cryptography
* AES-256-GCM for every blob and template, random 96-bit IV per object, AAD binding each ciphertext to its
  row (`evidence:<id>`, `reference:<id>`, `idphoto:<candidateId>`, `access-token:<sessionId>`,
  `webhook-secret:<id>`, `frame:<id>`, `external-verifier:<orgId>`, `totp:<userId>`, `totp-pending:<userId>`,
  `sso-client-secret:<providerId>`), key id embedded for rotation (`EVIDENCE_KEYS_OLD`). After a rotation
  the `rekey` CLI re-encrypts every encrypted column and evidence blob under the current key (batched,
  resumable, compare-and-set per row, `--dry-run`, audit `keys.rekeyed`), so old keys can be retired
  (`docs/OPERATIONS.md` §3).
* Constant-time comparison for liveness nonces; tokens/keys are looked up by hash.
* Webhooks: `HMAC-SHA256(secret, t.body)` with timestamp; secrets shown once, stored encrypted.
* Evidence storage locations (data residency, `docs/OPERATIONS.md` §2): buckets, directories, endpoints and
  credentials come from the environment only and are never sent to the staff app (it gets names, labels and regions).
  `storage:move` copies the ciphertext as stored (it never writes plaintext), verifies each copy by decrypting it with
  the image's AAD and comparing the SHA-256 recorded at upload, switches the row with compare-and-set, and only then
  deletes the old copy; new keys differ from the old ones, so a misconfiguration cannot make the deletion hit the copy.
  Choosing a location is owner-only and audited; each move is audited (`evidence.storage_moved`).
* External verifier AWS keys: write-only (responses show `accessKeyIdSet` + the last 4 characters of the key id),
  encrypted in the organisation settings (AAD binds them to the organisation), never logged or audited, deleted when
  the provider is switched off or server credentials are chosen; covered by `rekey`.

### Outbound requests (SSRF)
* Webhook URLs must be `https://` in production and resolve to public unicast addresses (IPv4/IPv6 private,
  loopback, link-local/metadata, CGNAT, NAT64/6to4-embedded and documentation ranges refused), checked when
  saved and again at connect time through a pinned DNS lookup (no DNS rebinding); redirects are never
  followed; 10 s timeout; at most 64 KB of the response is read and 200 characters kept.
* Identity providers (OIDC discovery, JWKS, token endpoint): the same guard (`guardedFetch`): public addresses only
  unless `SSO_ALLOW_PRIVATE_NETWORKS` (default: the webhook setting, off in production), DNS pinned at connect time,
  `https://` in production, redirects never followed, 10 s deadline (`SSO_TIMEOUT_MS`), at most 1 MB read.
* External face verifier (optional): requests go only through the AWS SDK to the Rekognition endpoint of the
  configured region — no administrator-supplied URLs; deadline `EXTERNAL_VERIFIER_TIMEOUT_MS` (4 s), one retry when
  throttled, a per-organisation circuit breaker (5 failures ⇒ 60 s pause), failures fall back to the internal
  decision. Operators can switch the feature off (`EXTERNAL_VERIFIERS=none`) and must opt in to letting
  organisations use the server's own AWS credentials (`EXTERNAL_VERIFIER_ENV_CREDENTIALS`).

### Dedicated vision workers (optional, `VISION_DRIVER=remote`)
* A worker receives candidate images and returns face templates and face crops: biometric data in transit. It holds
  no database connection, evidence key, session secret or storage, keeps an image only in memory for the analysis and
  its answer, and never logs images or request bodies (route logs at `warn` and above carry method, URL and errors).
* **Authentication**: every request except the two health probes carries `Authorization: Bearer <VISION_WORKER_TOKEN>`
  (≥ 24 characters, random). The worker compares SHA-256 digests with `timingSafeEqual` against every accepted token
  (two while rotating, OPERATIONS §3), **before reading the body**, so an unauthenticated client cannot make it
  buffer images. `/health/live` and `/health/ready` reveal only `ok`, the number of ready threads and an instance id.
* **Network exposure: a worker must never be reachable from the internet.** Keep it on the private network of the
  API servers: Compose `expose` (no `ports`), a Kubernetes ClusterIP / headless Service with a NetworkPolicy allowing
  only the servers, or a firewall rule. The driver sends the token and images in clear over `http://`; between hosts
  on a network you do not fully control, put TLS in front of the workers (a reverse proxy or service mesh) and use
  `https://` URLs — certificates are verified against the system CAs (`NODE_EXTRA_CA_CERTS` for a private CA; the
  certificate must name the host in the URL, also when a DNS name is expanded to its addresses).
* **Availability**: request bodies ≤ 8 MB, the analysis queue bounded per priority (256) with 503 + `Retry-After`;
  servers skip a worker that fails (circuit breaker) and never retry an analysis a worker accepted, so a slow worker
  cannot be flooded with duplicates. URLs come only from the operator's environment (no SSRF surface).

### Abuse and availability
* Rate limits: candidate endpoints per access token (30–600/min per endpoint), privacy notice 60/min/IP,
  login and password change 10/min/IP, single sign-on discovery 10/min/IP, start / callback / completion 20/min/IP,
  SAML ACS 30/min/IP, integration API 600/min/key, SCIM 600/min/token, webhook test/redeliver, test email,
  external-verifier and identity-provider tests (10/min).
  With `REDIS_URL` the counters are kept in Redis and shared by all instances (a Redis outage lets requests
  through and is logged); without it they are in memory per instance.
* Vision work is bounded (concurrency + queue of 256); overload returns `503 vision_busy` with `Retry-After`
  and the candidate client backs off exponentially.

### Privacy and audit
* Every image fetch (screenshots, check frames, identity references, probes, ID photos — all served only by
  `GET /api/admin/evidence/:id`) writes `evidence.view` to the audit log; so do reviews, notes, holds,
  releases, re-enrolments, settings (incl. external-verifier changes: provider/region/uses, key set/removed — never
  the key), external-verifier tests, users, API keys, webhooks, retention purges, operator changes to organisations
  (`organization.created` / `organization.updated`) and sandbox clean-ups (`sandbox.purge`).
* Webhooks, alert emails and the integration API never contain images, templates or similarity scores.
  Webhooks and alert emails never carry candidate-written text as is: events reported by the browser use the
  catalog title/observation, the pause reason and other user-controlled text are stripped of links
  (URLs, `www.`, bare host names, IP literals), and alert emails contain no link except the staff app's.
* Logs never contain access tokens (`/take/<token>`, `?token=`, `Authorization`, cookies are redacted).

## 3. Security review — 2026-09-24

Scope: `apps/server` (auth, all staff/candidate/v1 routes, WebSocket, crypto, storage, webhooks, vision
input), `apps/web` (admin and candidate), deployment files, `pnpm audit --prod`. Findings were verified
against a running instance and with integration tests (`apps/server/test/security.test.ts`).

| # | Severity | Finding | Status |
|---|---|---|---|
| 1 | High | `GET /api/candidate/session` returned the verified browser's `verifiedInstanceId` to anyone with the link; sending it as `X-Client-Instance` let a second device read questions and save answers as the verified browser, with no reconnect/identity check and no `multiple_instances` event. | Fixed (echoed only to that instance) |
| 2 | Medium | Candidate rate limits were keyed on the raw `Authorization` header: `Bearer  <token>` / `bearer <token>` got fresh buckets, so identity samples, check frames and uploads were effectively unlimited. | Fixed (keyed on the parsed token) |
| 3 | Medium | Decompression bomb: a ~290 KB progressive JPEG declaring 49 MP cost ~290 ms CPU and ~150 MB RSS per decode (combined with #2: vision pool saturation, 503 for all candidates). | Fixed (≤ 4096 px/side, ≤ 3840×2160 checked before decoding) |
| 4 | Medium | `TRUST_PROXY=true` (as in `.env.example`) trusts the client-written left-most `X-Forwarded-For` entry: rotating it bypassed the login rate limit (12/12 attempts, no 429) and forged audit-log IPs. | Mitigated (production warning, hop counts refused — Fastify ≥ 5.12 ignores them); operators must set proxy addresses (§4) |
| 5 | Medium | The integration API returned face-similarity scores (event `details.min/maxSimilarity`, report `session.identity.lastSimilarity`, ID-photo similarity, "(lowest similarity 0.00)" in sentences) although documented as never doing so. | Fixed (nulled / removed in `/api/v1`; staff views unchanged) |
| 6 | Low | CSRF defence relied on `Origin` only when present; logout had no check (cross-origin logout worked). | Fixed (`Sec-Fetch-Site`/`Referer` fallback; logout same-origin only) |
| 7 | Medium | A colluding candidate can still copy their own instance id (DevTools) to a second device. | Fixed (detection) — UA change, networks alternating within 60 s or interleaved heartbeat `seq` for the verified instance → `multiple_instances` event (hashed IPs) + mandatory reconnect check; binding the instance to a server-issued secret remains a possible hardening |
| 8 | Medium | Key rotation is incomplete: no re-encryption tool, and long-lived ciphertexts (ID-photo templates, access tokens, webhook secrets, legal-hold evidence) keep needing old keys indefinitely. | Fixed — `rekey` CLI re-encrypts every encrypted column and evidence blob (batched, resumable, `--dry-run`, audited); retire an old key once `rekey --dry-run` reports nothing under it |
| 9 | Low | Login throttling is per IP only (no per-account backoff); no MFA/SSO for staff who can view biometric evidence; scrypt N=2^15 is below current guidance (2^17). | Fixed — scrypt N=2^17 (old hashes upgraded at sign-in), per-account backoff 30 s → 15 min after 5 failures (IP-independent, no enumeration), failed logins audited; two-step sign-in (TOTP + recovery codes, organisation-wide requirement, admin reset, security emails); single sign-on (OIDC, SAML 2.0) with SCIM provisioning and an owner break-glass (§2) |
| 10 | Low | Candidate-controlled text (event `observation` ≤ 500 chars, camera label) is forwarded into staff alert emails (escaped) and webhooks — phishing from a trusted sender. | Fixed — catalog wording for client-reported events; links stripped from pause reasons and other user-controlled text in webhooks and emails |
| 11 | Low | Rate-limit counters are in memory per instance (not shared through Redis). | Fixed — Redis store for all rate limits when `REDIS_URL` is set |
| 12 | Low | Default staff session lifetime is long (8 h idle / 7 days absolute). | Fixed — defaults 60 min idle / 12 h absolute (env overridable); the staff app returns to the sign-in page with a return path |
| 13 | Low | `POST /api/admin/users` answers `email_taken` for addresses registered in any organisation (cross-tenant enumeration by admins). | Open |
| 14 | Low | `apps/web/index.html` has no `<meta name="referrer" content="no-referrer">` (defence in depth if the SPA is ever served without our headers); production build ships public source maps. | Open |
| 15 | Info | CSP `connect-src` allows any `ws:`/`wss:` host; reviewers receive exam answer keys; candidate links stay valid after the exam ends; unlimited WebSocket connections per staff session; client retry backoff has no jitter. | Open |

Dependencies (`pnpm audit --prod`): **sharp 0.34.5** (high: libvips/libheif CVEs, fixed in ≥ 0.35.4) —
candidate and ID-photo uploads must start with a JPEG signature, and libvips then always selects the JPEG
loader (verified: an AVIF re-labelled with a JPEG signature is rejected by `VipsJpeg`), so the vulnerable
HEIF/GIF/TIFF loaders are not reachable from uploads; upgrade anyway. **@fastify/static 8.3.0** (route-guard
bypass / directory listing, fixed in ≥ 10.1.2) — not exploitable here (no `list`, no `allowedPath`, no guarded
static paths; the root only holds the public web build; traversal attempts return 403); upgrade.
**drizzle-orm 0.44.7** (identifier escaping, fixed in ≥ 0.45.2) — not reachable (no `sql.identifier`,
`.as()` or `sql.raw` with request data); upgrade.
**FIXED:** upgraded to sharp 0.35.4, @fastify/static 10.1.4 (static/SPA-fallback tests incl. encoded traversal)
and drizzle-orm 0.45.3 (drizzle-kit 0.31.11: no schema diff, migrations apply on a fresh database);
`pnpm audit --prod` reports no known vulnerabilities. Remaining advisories are development-only (vitest 3 →
fixed in 4.1.11; esbuild in drizzle-kit's loader and tsup — dev servers only, never shipped).

## 4. Production checklist

**TLS and proxy**
- [ ] Terminate TLS in front of the app (camera access requires HTTPS); redirect HTTP to HTTPS; proxy the
      WebSocket `/api/admin/live`.
- [ ] Bind the app to localhost or the private network only (e.g. `127.0.0.1:8080:8080` in Compose) so
      nothing reaches it except through the proxy.
- [ ] Dedicated vision workers (if used): on the private network only, never published; a random
      `VISION_WORKER_TOKEN` (`openssl rand -hex 32`) from the secret manager; `https://` worker URLs (TLS in front of
      the workers) whenever the traffic leaves a network you control.
- [ ] `TRUST_PROXY` = the proxy's address(es), e.g. `127.0.0.1`, `loopback,uniquelocal` or the load balancer
      subnet — **not** `true` (unless the proxy overwrites `X-Forwarded-For`). Hop counts are not supported.
- [ ] `PUBLIC_URL` = the exact public origin (used for links and the CSRF origin check); `COOKIE_SECURE=true`.
- [ ] The proxy must pass through (not strip) the app's security headers; if it serves static files itself,
      copy CSP, `Referrer-Policy: no-referrer`, `X-Frame-Options`, `Permissions-Policy` and HSTS. Consider
      HSTS preload once the whole domain is HTTPS-only.

**Secrets and keys**
- [ ] `EVIDENCE_KEY` (32 random bytes) and `SESSION_SECRET` (≥ 32 chars) from a secret manager, never in
      images or the repository; back the evidence key up separately from the database backups.
- [ ] Rotate `EVIDENCE_KEY` by moving the old key to `EVIDENCE_KEYS_OLD`, restart, then run `rekey`; remove the
      old key only once `rekey --dry-run` reports nothing left under it (`docs/OPERATIONS.md` §3).
- [ ] Rotating `SESSION_SECRET` signs every staff member out. Rotate webhook secrets and API keys on staff
      turnover; revoke unused keys. Give each integration its own API key with only the scopes it needs (read only
      for reporting tools) and an expiry (default one year); alert on `sp_cluster_api_keys_expiring_soon`.
- [ ] Remove `BOOTSTRAP_ADMIN_PASSWORD` from the environment after the first start; the owner changes it.
- [ ] External face verifier (organisations can opt in by default): set `EXTERNAL_VERIFIERS=none` if face images
      must never leave your infrastructure; otherwise give the IAM user/role only `rekognition:CompareFaces`, opt
      out of AI-service content use, and allow `EXTERNAL_VERIFIER_ENV_CREDENTIALS` only on single-tenant servers
      (`docs/EXTERNAL_VERIFIER.md`).

**Database, storage, backups**
- [ ] Postgres role for the app: not a superuser, owner of the application schema only (migrations run at
      start-up), strong password, `sslmode=require` for remote databases; no public exposure of 5432.
- [ ] Encrypted volumes for Postgres (candidate names/emails are not application-encrypted) and the evidence
      store; for S3 use a private bucket, block public access, SSE, and a least-privilege key limited to the
      bucket/prefix (Get/Put/Delete) — the same for every storage location in `STORAGE_LOCATIONS`, each with its own
      key where possible.
- [ ] Backups: Postgres PITR/dumps and evidence snapshots with retention aligned to `evidenceRetentionDays`
      (purged evidence survives in backups until they expire); test restores; keep backups encrypted.

**Abuse and monitoring**
- [ ] With several instances, set `REDIS_URL` so in-app rate limits are shared (otherwise they are per
      instance); add rate limiting at the proxy/WAF as well, e.g. `/api/auth/login` ≤ 10/min per IP,
      `/api/candidate/*` ≤ 20 req/s per IP, request bodies ≤ 5 MB.
- [ ] Alert on bursts of `auth.login_failed` (reason `throttled` = an account under attack), `evidence.view` by one user, `api_key.created`,
      `user.updated` (role changes), `auth.mfa_disabled`, `user.mfa_reset`, `auth.recovery_code_used`, `webhook.auto_disabled`, and on `503 vision_busy` rates;
      with single sign-on also on bursts of `auth.sso_failed` (reasons `token_rejected`, `replayed`, `wrong_recipient`), `sso.provider_*`,
      `scim.token_*`, `user.created` by actor `scim` / just-in-time, and `settings.updated` turning `requireSso` off.
- [ ] Ship logs to central storage with restricted access; they contain staff emails and IP addresses but
      never tokens.
- [ ] Keep dependencies patched (`pnpm audit --prod` in CI).

**Accounts and process**
- [ ] Give most staff the reviewer role; limit owners/admins; disable accounts on departure (revokes sessions
      immediately).
- [ ] Require two-step sign-in (Settings → Two-step sign-in): at least for administrators and owners, preferably for
      everyone who can see candidate evidence.
- [ ] With single sign-on: require MFA for the application **in the identity provider** (SmartProctoring does not ask
      for its own code after single sign-on); use a single-tenant issuer (Entra ID: `…/<tenant-id>/v2.0`); claim only
      your own email domains; keep just-in-time accounts off or at the reviewer role; keep at least two owners with a
      password and two-step sign-in as break-glass; store the SCIM token only in the identity provider and rotate it on
      staff turnover. Configure SMTP so staff are emailed about changes to their
      two-step sign-in; verify the caller's identity out of band before resetting someone's two-step sign-in.
- [ ] Keep staff session lifetimes short (defaults `STAFF_SESSION_IDLE_MIN=60`, `STAFF_SESSION_MAX_HOURS=12`;
      shorten further where staff use shared or unmanaged devices).
- [ ] Review the audit log regularly (evidence views, re-enrolments, legal holds, settings changes).
