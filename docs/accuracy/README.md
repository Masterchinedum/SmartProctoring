# Accuracy — how it is measured

The requirement: *accuracy should be measured separately for each detection, especially person-swap
detection and false identity mismatches, tested across lighting changes, different cameras, glasses,
hairstyles, clothing changes, backgrounds and pauses of different lengths; where the system cannot
reach a dependable conclusion it must say so and route the case for human review.*

SmartProctoring measures accuracy at three levels:

| Level | What | Where |
|---|---|---|
| 1. Identity (offline) | False identity-mismatch rate, missed-swap (false match) rate, inconclusive and unable-to-verify rates, per capture condition and per synthetic perturbation (dim, very dark, overexposed, blur, JPEG, low-res camera, noise, colour cast, occlusion, cut-off face), similarity distributions, EER/ROC, and event-level estimates (swap detected within N minutes; false `identity_mismatch` events per candidate-hour; resume-check outcomes) | [identity-v2.md](identity-v2.md) (webcam calibration, current), [identity.md](identity.md) (pipeline, v1 smoke set), `pnpm --filter @sp/server eval:identity [-- --webcam]` |
| 1b. Identity end to end | The whole product in a real browser on webcam-realistic video (dim, backlit, side-lit, 720p and VGA cameras, another day, another room): first-attempt resume, quick swap after the exam starts, family impostor, look-alike in a dim room, long genuine sessions without false alarms, liveness | [end-to-end.md](end-to-end.md), `e2e/tests/2[0-4]-realistic-*` |
| 1c. Recogniser research | Label-free robustness fine-tuning of the face recogniser for dim / backlit webcams, with the ship / no-ship analysis | [recognizer.md](recognizer.md), `tools/recognizer/` |
| 2. Behavioural detectors (offline) | Per detector: precision, recall, F1, false alerts per hour of clean monitoring, onset latency, duplicate events for one ongoing issue (must be 0) — on labelled scenario traces and on recorded real traces | [detection.md](detection.md), `pnpm --filter @sp/detection eval` |
| 3. Production (online) | Reviewer decisions per detector: *reviewed* vs *dismissed as false positive* → precision proxy per event type; identity decisions by trigger (check-in, resume, reconnect, face return, periodic…); identity-mismatch events dismissed vs confirmed | Staff app → **Quality** page (`GET /api/admin/metrics/detection-quality`); offline reports can be uploaded there for side-by-side view |

## Designed-in safeguards (not just measured)

* **Quality gate before any identity decision** — images where face recognition itself breaks down (too dark, very
  low contrast, blurry, too small, turned, cut off, several faces) return *unable to verify* with candidate guidance,
  never *different person*. Usable frames fall into a good / fair / poor quality bucket that sets how much the
  comparison may count.
* **Calibrated evidence instead of a single threshold** — each comparison becomes a likelihood ratio from a model
  fitted per quality bucket and per reference quality (a reference enrolled in a dim room is judged against the
  candidate's own level in that room); evidence accumulates over samples (sequential test with *suspect* and
  *confirmed* levels) and is normalised to the candidate's own enrolment.
* **Poor light never confirms a swap on its own** — poor-light evidence is capped below the confirm level; it can make
  a session *suspect* (shown to staff as uncertain, with lighting guidance to the candidate and faster sampling) and
  confirmation then waits for a clear frame.
* **Fast checks where swaps happen** — samples right after the exam starts or resumes, every 6 s for 3 minutes, and
  immediately when the face track breaks or the face's appearance changes abruptly, in bursts of 3 frames.
* **Three-way decision at checks** — match / inconclusive / mismatch; retries that fail only on image quality cost half
  an attempt and pool their usable frames; repeated *unable to verify* routes the session to human review (hold) after
  the configured attempts; reviewers see before/after images, the surrounding timeline and, when enabled, an
  external second opinion; environment differences are labelled context only.
* **Debounced behaviour detectors** — duration, repetition, confidence and the candidate's own
  baseline; one event per ongoing issue.

## Current baselines and what they do NOT establish

The committed baselines were produced on public photos rendered through a laptop-webcam simulator (identity v2:
140 photos / 43 people incl. 3 families; the v1 smoke set was 25 photos / 9 adults), on webcam-realistic end-to-end
video, and on synthetic, labelled traces (behaviour). They show that the pipeline behaves as designed —
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
