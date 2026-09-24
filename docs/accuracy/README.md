# Accuracy — how it is measured

The requirement: *accuracy should be measured separately for each detection, especially person-swap
detection and false identity mismatches, tested across lighting changes, different cameras, glasses,
hairstyles, clothing changes, backgrounds and pauses of different lengths; where the system cannot
reach a dependable conclusion it must say so and route the case for human review.*

SmartProctoring measures accuracy at three levels:

| Level | What | Where |
|---|---|---|
| 1. Identity (offline) | False identity-mismatch rate, missed-swap (false match) rate, inconclusive and unable-to-verify rates, per capture condition and per synthetic perturbation (dim, very dark, overexposed, blur, JPEG, low-res camera, noise, colour cast, occlusion, cut-off face), similarity distributions, EER/ROC, and event-level estimates (swap detected within N minutes; false `identity_mismatch` events per candidate-hour; resume-check outcomes) | [identity.md](identity.md), `pnpm --filter @sp/server eval:identity` |
| 2. Behavioural detectors (offline) | Per detector: precision, recall, F1, false alerts per hour of clean monitoring, onset latency, duplicate events for one ongoing issue (must be 0) — on labelled scenario traces and on recorded real traces | [detection.md](detection.md), `pnpm --filter @sp/detection eval` |
| 3. Production (online) | Reviewer decisions per detector: *reviewed* vs *dismissed as false positive* → precision proxy per event type; identity decisions by trigger (check-in, resume, reconnect, face return, periodic…); identity-mismatch events dismissed vs confirmed | Staff app → **Quality** page (`GET /api/admin/metrics/detection-quality`); offline reports can be uploaded there for side-by-side view |

## Designed-in safeguards (not just measured)

* **Quality gate before any identity decision** — images that are too dark, bright, blurry, small,
  turned, cut off or with several faces return *unable to verify* with candidate guidance, never
  *different person*.
* **Three-way decision** — match / inconclusive / mismatch, with a grey zone between thresholds.
* **Confirmation** — during an exam a single mismatching sample only triggers a follow-up sample;
  two consecutive quality mismatches are needed to raise *possible different person*.
* **Routing to people** — repeated *unable to verify* at a check routes the session to human review
  (hold) after the configured attempts; reviewers see before/after images and the surrounding
  timeline; environment differences are labelled context only.
* **Debounced behaviour detectors** — duration, repetition, confidence and the candidate's own
  baseline; one event per ongoing issue.

## Current baselines and what they do NOT establish

The committed baselines were produced on a small public smoke set (identity: 25 photos / 9 adults)
and on synthetic, labelled traces (behaviour). They show that the pipeline behaves as designed —
e.g. 0 false mismatches across all perturbations, poor images become *unable to verify* — but they
are **not** production error rates and are not demographically representative.

## Before launch: run the protocol on your own consented data

1. **Identity** — collect, with explicit consent, webcam images from ≥ 100 people across your
   candidate demographics: a check-in set plus later captures tagged by condition (`lighting-dim`,
   `lighting-bright`, `glasses-on/off`, `hairstyle`, `clothing`, `background`, `camera-b` (different
   webcam/laptop), `pause-15m`, `pause-1d`, `pause-7d`). Run
   `pnpm --filter @sp/server eval:identity -- --dataset <dir> --perturb --out report.json` and upload the
   JSON on the Quality page. Gate go-live on: false identity mismatch ≤ 0.1 % per sample and 0 at
   resume checks, missed swaps per resume check ≤ 1 %, unable-to-verify ≤ 5 % in normal lighting.
   Report results per demographic group, with confidence intervals (≥ 300 genuine trials per
   group for a ±1 % bound).
2. **Behaviour** — run pilot sessions with `?trace=1` on the candidate link to record observation
   traces, label them (`docs/accuracy/detection.md` explains the label format), and run
   `pnpm --filter @sp/detection eval -- --trace <file> --labels <labels.json>`.
3. **Production** — watch the Quality page. A rising dismissal rate for a detector means false
   positives: tune its policy thresholds per exam (Exams → Policy → Detection) rather than globally.
