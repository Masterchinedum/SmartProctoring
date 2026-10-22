# External second-opinion face verifier

SmartProctoring verifies identity with its own on-premises face recogniser (OpenCV Zoo SFace, `docs/ARCHITECTURE.md`
§4). Some organisations want an additional, independent opinion from a large vendor for the decisions that matter
most, and accept that face images are sent to that vendor for those decisions. Others license a top-ranked
on-premises SDK. Both fit behind one small provider interface. The first provider is **Amazon Rekognition
CompareFaces**.

**Off by default.** Nothing leaves your server unless an organisation administrator selects a provider **and** at
least one decision point, and the server operator allows that provider.

## 1. What it does

At a selected decision point, the server sends two images to the provider: the candidate's live camera image (the
*probe*) and the image it is compared with (the *reference*: the identity reference taken at check-in, or the approved
ID photo). The provider returns a similarity between 0 and 1. The server combines that answer with its own decision
using a fixed, documented table (§5). The external result can:

* confirm the internal decision;
* settle an internal **inconclusive** result as a **match** when the provider is confident that it is the same person;
* turn a **borderline** internal decision that it contradicts into **inconclusive**, flagged for human review;
* flag a **clear** internal decision that it contradicts for human review. The decision itself is kept.

It **never** records "possible different person" on its own, and it never changes "unable to verify" (an unusable
image). If the provider is slow, down, throttling or misconfigured, the internal decision is used alone ("fail
open"), and the failure is logged and returned so that it can be stored with the check.

Decision points (`externalVerifier.useFor`):

| Setting | Meaning | Suggested identity triggers |
|---|---|---|
| `checkIn` | Readiness check at the start, including the ID-photo comparison | `check_in`, `id_photo` |
| `resume` | Returning after a pause, a reconnect or a hold | `resume`, `reconnect`, `reverify` |
| `suspectedSwap` | A possible change of person during the exam, before a "possible different person" event is raised | internal `mismatch` on `follow_up`, `track_break`, `appearance_change`, `periodic` |

Routine periodic samples that match are **not** sent. This keeps cost, latency and data transfer small.

## 2. Costs and latency

* **Cost.** AWS charges for each CompareFaces call. Prices depend on the region and on volume tiers, and they change
  over time. See the Amazon Rekognition pricing page for current prices; this document does not quote them. One
  comparison is one CompareFaces call, or two when a throttled call is retried. Estimate your volume as the number
  of sessions × the enabled decision points that occur per session (usually 1 check-in, plus 1 per resume or
  reconnect, plus a few per suspected change of person).
* **Latency.** One HTTPS round trip to the chosen AWS region plus AWS's processing time. We have not measured it
  with real credentials. Measure it from your server with the smoke test (§8), and pick a region close to your
  servers. The hard ceiling is `EXTERNAL_VERIFIER_TIMEOUT_MS` (default 4 s, retry included). After that, the
  internal decision stands alone. After 5 consecutive failures, calls for the organisation pause for 60 s
  (circuit breaker), so an outage does not add the timeout to every check. The staff "Test connection" always
  calls the provider.
* The AWS SDK is loaded the first time an organisation uses the verifier. Servers that never enable it do not
  load it.

## 3. Privacy implications

Face images are **biometric data**. When the verifier is active, they are sent to a third party for the selected
checks.

* **Sub-processor.** The provider (for Amazon Rekognition: Amazon Web Services) processes biometric data on your
  behalf. List it in your records of processing and DPIA, sign its data processing terms, and choose the **region**
  to match your data-residency requirements.
* **Provider data use.** AWS's service terms have allowed AWS to store and use content processed by some AI
  services, including Rekognition, to improve those services, unless the customer opts out with an **AI services
  opt-out policy** in AWS Organizations. Check AWS's current terms and opt out before you enable the verifier.
  SmartProctoring only calls CompareFaces. It never creates face collections, never indexes faces and never
  searches 1:N.
* **Candidate notice and consent.** While the verifier is active, the candidate privacy notice
  (`buildPrivacyNotice`) names the provider. It says that the camera image and the image it is compared with may
  be sent there for an independent second comparison, and that the provider never decides on its own that the
  candidate is a different person. The "Who can see your data" section names it as well. Images are sent **only**
  for sessions whose candidate accepted the notice **at or after** the moment the provider became active
  (`enabledAt`). Candidates who consented earlier, and so saw a notice that did not name the provider, are
  excluded for the rest of that session. Residual edge case: a candidate who opened the notice just before an
  administrator switched the verifier on and accepted it just after. Switch it on outside exam windows.
* **Data minimisation.** Only the probe and one reference image are sent per comparison, only at the selected
  decision points, over TLS through the AWS SDK. SmartProctoring stores nothing new: the similarity, the face count
  and the outcome can be stored with the identity check, but never the images again or the provider's raw response
  (the stored raw data is sanitised to counts and scores, with no bounding boxes, landmarks or poses).
* **Server kill switch.** `EXTERNAL_VERIFIERS=none` disables the feature for every organisation on the server. See
  `docs/PRIVACY.md` §7 and `docs/SECURITY.md`.

## 4. Configuration

### Server (operator)

| Variable | Default | Purpose |
|---|---|---|
| `EXTERNAL_VERIFIERS` | `aws-rekognition` | Providers that organisations may enable (comma-separated). `none` switches the feature off server-wide. |
| `EXTERNAL_VERIFIER_ENV_CREDENTIALS` | `false` | Lets organisations use the server's own AWS credentials (the default credential chain: IAM role / instance profile, `AWS_*` environment, shared config) instead of storing an access key. The operator then pays, and the images go to the operator's AWS account. Enable it only for single-tenant deployments. |
| `EXTERNAL_VERIFIER_TIMEOUT_MS` | `4000` | Deadline per comparison, retry included (500–30000). |

Outbound network: allow HTTPS egress to `rekognition.<region>.amazonaws.com` (and to STS or the instance metadata
service when you use role credentials).

### AWS account

Create an IAM user (for a stored key) or a role (for server credentials) that is allowed only this action:

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "rekognition:CompareFaces", "Resource": "*" }]
}
```

Opt out of AI-service content use (AWS Organizations → Policies → AI services opt-out policies) before you enable
the verifier (§3).

### Organisation (Settings → Integrations → "Identity second opinion")

1. Choose **Amazon Rekognition**, enter the **region** (e.g. `eu-west-1`) and either an **access key** (access key
   ID + secret access key) or, when the server allows it, **this server's AWS credentials**.
2. Keep every "Ask for a second opinion" option **off** and save. Nothing is sent during exams yet.
3. **Test connection with a photo…** uploads a photo with one clear face. The server compares it **with itself**
   using the saved settings. A working setup reports a similarity close to 100 %. Errors appear as a code (`auth`,
   `timeout`, `network`, `throttled`, `invalid_image`, `provider_error`) plus the provider's message.
4. Switch on the decision points you want and save. The app asks for confirmation because images will start
   leaving the server. From then on the notice names the provider (§3).

API (admin): `GET/PUT /api/admin/settings` → `externalVerifier` (see `packages/shared/src/verifiers.ts`),
`GET /api/admin/verifiers` (the providers this server offers), `POST /api/admin/verifiers/test` (body `image/jpeg`,
≤ 5 MB, 10 per minute).

```jsonc
// PUT /api/admin/settings
{ "externalVerifier": {
    "provider": "aws-rekognition", "region": "eu-west-1",
    "accessKeyId": "AKIA…", "secretAccessKey": "…",          // write-only, always together
    "useFor": { "checkIn": true, "resume": true, "suspectedSwap": true } } }
// GET returns { provider, region, useEnvCredentials, accessKeyIdSet, accessKeyIdHint (last 4), useFor, active, enabledAt }
```

**Secrets.** The key pair is encrypted with the evidence keyring (AES-256-GCM, AAD `external-verifier:<orgId>`) and
stored as base64 inside the organisation settings. It is never returned; responses show only `accessKeyIdSet` and
the last 4 characters of the key ID. It never appears in the audit log or in server logs, and it is re-encrypted by
`rekey` (target `external_verifier_credentials`). Choosing provider `none`, switching to server credentials or
`clearCredentials: true` deletes it. Settings changes are audit-logged (`settings.updated`, with
`meta.externalVerifier` = from/to summary and `credentials: set|removed|unchanged`), and so is every test
(`external_verifier.tested`).

Validation (HTTP 400 `validation_failed`, `details[].path` = `externalVerifier.<field>`):
* the provider must be offered by the server;
* AWS needs a region (`eu-west-1` style) and either a stored key or server credentials (when allowed);
* the key ID and the secret must be given together;
* a stored key and server credentials are mutually exclusive;
* unknown fields are refused.

## 5. Decision fusion

`fuseWithExternal(internal, external, policy)` in `apps/server/src/verifiers/fusion.ts` is a pure function. It
returns the final decision, `needsHumanReview`, an `outcome` code, a reviewer-facing `explanation` that names both
opinions, and a `record` of both to store with the check.

**Internal strength.** With the thresholds the internal decision was made with (reference or ID photo) and
`borderlineMargin` (default 0.05):

* a **match** is *borderline* when similarity < match + margin, otherwise *clear*;
* a **mismatch** is *borderline* when similarity ≥ mismatch − margin, otherwise *clear*;
* a decision without a similarity counts as clear;
* a **mismatch** made on **accumulated calibrated evidence** (`InternalOpinion.evidence`: the mid-exam SPRT of a
  suspected swap, or the evidence of a resume / reconnect / reverify check's frames) takes its strength from that
  evidence, not from the raw similarity: *clear* when the evidence reached its decision threshold (a
  `confirmed_mismatch`, a `likely_mismatch` check), otherwise *borderline*. A look-alike scoring 0.35–0.45 looks
  borderline by similarity although several samples decided it; a provider's "same person" then flags the decision
  for review but never overrules it. A match keeps the similarity rule, so a provider's "different person" can still
  downgrade a match just above the threshold.

**External band.**

| Band | Condition |
|---|---|
| *same* | similarity ≥ `externalSame` (default 0.95) |
| *different* | similarity < `externalDifferent` (default 0.50) |
| *uncertain* | between the two |
| *unusable* | no face, more than one face in the probe, error or timeout |

The defaults follow the provider's documented score semantics. Rekognition's similarity is a percentage, and its
API's default threshold is 80 %. **The defaults are not calibrated on your data.** Calibrate them with the protocol
in `docs/accuracy/`.

| internal \ external | same | different | uncertain | unusable / none |
|---|---|---|---|---|
| match, clear | match (agree) | **match + review** (disagreement flagged) | match | match |
| match, borderline | match (agree) | **inconclusive + review** (downgraded) | match | match |
| inconclusive | **match** (resolved by external)¹ | **inconclusive + review** | inconclusive | inconclusive |
| mismatch, borderline | **inconclusive + review** (downgraded) | mismatch (agree) | mismatch | mismatch |
| mismatch, clear | **mismatch + review** (disagreement flagged) | mismatch (agree) | mismatch | mismatch |
| unable to verify | unable to verify | unable to verify | unable to verify | unable to verify |

¹ `resolveInconclusive` (default true). When it is false, the result stays inconclusive without a review flag.

Example explanation: *"SmartProctoring: possible different person (similarity 0.10; match ≥ 0.45, mismatch < 0.28).
Amazon Rekognition (Amazon Web Services): same person (similarity 0.99 ≥ 0.95). The two disagree. The internal
decision is kept and the check is flagged for human review."*

## 6. Integration seam (developers)

```ts
import { fuseWithExternal, fusionPolicyFor, maybeExternalSecondOpinion } from '../verifiers/index.js';

const opinion = await maybeExternalSecondOpinion(ctx, org /* row or id */, 'resume', {
  reference: [referenceJpeg /* best first */], probe: probeJpeg,
}, { consentAcceptedAt: session.consentAcceptedAt, sessionId: session.id });
// null => disabled / not this decision point / consent predates enablement / server switched it off
const fused = fuseWithExternal({ decision, similarity }, opinion, fusionPolicyFor(orgThresholds(org)));
// act on fused.decision; store fused.record + fused.explanation + fused.outcome with the identity check;
// surface fused.needsHumanReview to reviewers
```

* Call it **outside** the session row lock (`withSession`), because it waits for a network call of up to the
  timeout. For example, run the internal analysis, call the seam, then open the locked mutation with both results.
* It never throws for provider problems. A failure returns `{ status: 'error', error, message, latencyMs }`, which
  the fusion treats as "no opinion" (and records).
* Use the ID-photo thresholds (`idPhotoMatch` / `idPhotoMismatch`) in `fusionPolicyFor` when the internal decision
  was an ID-photo comparison.

### Where the identity engine asks (apps/server/src/services/identity-external.ts)

Always outside the session lock; when the verifier does not apply (the default), nothing is loaded or sent and the
engine behaves exactly as without the feature.

| Decision point | When | Internal opinion fused | Images sent (reference → probe) | Effect of the fused decision |
|---|---|---|---|---|
| `check_in` | initial check with an approved ID photo (`idPhotoComparison` on) | the ID-photo comparison, **ID-photo thresholds** | approved ID photo → best check-in frame | replaces the ID-photo decision (advisory / required policy as before) |
| `check_in` | initial check without an ID photo comparison | the enrolment's own consistency (`match`, cosine of the two frames) | best reference frame → the accepted frame taken last | not `match` ⇒ no reference, retry (`second_opinion_inconclusive`) |
| `resume` | resume / reconnect / reverify check (not an authorised re-enrolment) | the check's decision, its accumulated evidence (strength of a mismatch) and mean-embedding score | reference images (full frame first) → the check's best probe frame | replaces the check decision (inconclusive ⇒ retry with guidance); a decisive `likely_mismatch` is kept (held / flagged per policy) with `needsHumanReview` when the provider disagrees |
| `suspected_swap` | the evidence accumulator is about to confirm a possible different person | `mismatch` with the confirming sample's score and the window's accumulated LLR (decisive at `sprt.confirm`) | reference images → that sample's frame | `identity_mismatch` + hold / flag as before; with `needsHumanReview` when the provider says "same person" (a confirmed SPRT is never overruled). Only evidence that is not decisive could be held off (`identity_unverifiable`, 5 min) — which the engine does not ask about |

Routine samples are never sent. The confirming sample's request waits for the answer (≤ `EXTERNAL_VERIFIER_TIMEOUT_MS`);
a lost answer is asked again after the timeout + 10 s (at least 15 s). Records: identity check `context.secondOpinion` (outcome, fused and internal
decision, bands, explanation, provider similarity — no images), `IdentityCheckDTO.secondOpinion`, and on the events it
affected (`identity_mismatch`, `identity_verified`, `identity_unverifiable`, `id_photo_compared`, `checkin_completed`)
`details.secondOpinion` + `details.needsHumanReview` for the staff UI.

## 7. Adding another provider (e.g. a licensed on-premises SDK)

1. Implement `ExternalVerifier` (`apps/server/src/verifiers/types.ts`):
   `compare({ reference: Buffer[], probe: Buffer }, { timeoutMs })` → `{ similarity: 0..1, faceFound, faceCount?,
   raw?, latencyMs }`. Throw `ExternalVerifierError(code, message)` for failures (`timeout`, `throttled`, `auth`,
   `invalid_image`, `network`, `not_configured`, `provider_error`). Keep `raw` sanitised (no image bytes, boxes or
   landmarks). An on-premises SDK can use every reference image (a gallery); map its score to 0..1 so that the
   fusion bands apply, or pass provider-specific `externalSame` / `externalDifferent` to `fusionPolicyFor`. A native
   or CPU-heavy SDK must not run on the event loop: run it in a worker thread or a sidecar service.
2. Register a `VerifierProviderFactory` (`{ id, displayName, location: 'cloud' | 'on_premises', create(ctx) }`) in
   the default provider list of `apps/server/src/verifiers/registry.ts`. `create` receives the organisation's
   settings and decrypted credentials, and throws `not_configured` when something is missing.
3. Add the id to `EXTERNAL_VERIFIER_PROVIDERS` and `EXTERNAL_VERIFIER_NAMES` (`packages/shared/src/verifiers.ts`),
   plus any settings fields it needs (for example an endpoint or licence file path; validate them in
   `applyExternalVerifierUpdate`). Store secrets through `encryptVerifierCredentials` so that `rekey` covers them.
4. Operators allow it with `EXTERNAL_VERIFIERS=aws-rekognition,<id>`. For `on_premises` providers, the privacy
   notice wording ("an external face-comparison service") should be adjusted if no data leaves your infrastructure.
5. Add tests like `apps/server/test/verifiers/aws-rekognition.test.ts` with a mocked client.

## 8. Tests and live smoke test

Automated tests use no network (`pnpm --filter @sp/server test -- test/verifiers`):

* `fusion.test.ts`: every cell of the decision table, band and margin edges, and the invariants (never a mismatch
  from the external result alone; a clear decision is never flipped).
* `aws-rekognition.test.ts`: the provider with a mocked Rekognition client (request shape, 0–100 → 0..1, largest
  face, no face, throttling retry, deadline, auth/image/network/provider errors) and the registry (credentials,
  cache, circuit breaker).
* `settings-api.test.ts`: settings validation, write-only secrets, audit, `enabledAt`, the privacy notice, the
  test-connection endpoint, the seam's consent gate and fail-open behaviour, and the server switches.
* `test/rekey.test.ts` covers the encrypted key pair.

**Live smoke test with real credentials** (manual; costs a few CompareFaces calls):

```bash
cd apps/server
# credentials from the default chain: AWS_PROFILE, AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or an IAM role
AWS_PROFILE=proctoring-verifier npx tsx src/verifiers/smoke-cli.ts --region eu-west-1 \
  alice-1.jpg alice-2.jpg bob.jpg        # reference, then probes (one image = compared with itself)
# alice-1.jpg vs alice-2.jpg: similarity 0.99..  faceFound true  faces 1  … ms
# alice-1.jpg vs bob.jpg:     similarity 0.0…    faceFound true  faces 1  … ms
```

Exit code 0 means every call answered. With invalid credentials you get `ERROR auth … UnrecognizedClientException`.
With no credentials you get `ERROR auth … CredentialsProviderError`. Then run the in-app check: Settings →
Integrations → Identity second opinion → **Test connection with a photo…**.
