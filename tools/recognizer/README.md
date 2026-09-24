# tools/recognizer — webcam-robust face recogniser (training + evaluation)

Reproducible, label-free robustness training of the server's face recogniser (OpenCV Zoo **SFace**,
`apps/server/models/face_recognition_sface_2021dec.onnx`, Apache-2.0) for laptop-webcam conditions, and the
held-out evaluation that decides whether a candidate ships. Results, decision and limitations:
[`docs/accuracy/recognizer.md`](../../docs/accuracy/recognizer.md).

**Current status: no candidate shipped.** The best candidate (A_mdeg) halves the error in dim and backlit light,
but it raised the matched-degradation (dim-room) false-match rate and family false-accepts on the evaluation set.
See §4.5 of that document.

Nothing in this folder ships with the server. No images, crops, checkpoints or datasets are committed. Everything
is written under `$RECOG_WORK` (default `/tmp/claude-0/recognizer`).

## Files

| File | What |
|---|---|
| `common.py` | Python mirror of the production pipeline: decode, YuNet pre/post-processing (`detect.ts`), 5-point similarity alignment (`align.ts`), SFace in PyTorch loaded from the ONNX weights, onnxruntime embedder |
| `prep.py` | Port of `apps/server/src/vision/embed-prep.ts` (illumination normalisation `stretch` / `gamma` / `clahe`, flip TTA): the non-learned baselines |
| `webcam.py` | Training-side webcam degradation model: an independent Python port of `apps/server/src/eval/webcam-sim.ts` (same condition ranges) with training-only widened ranges, low-res sensor and heavy JPEG |
| `fetch_data.py` | Downloads the training images: public-domain US Congress portraits, pinned commit |
| `build_train.py` | Clean and degraded training crops, the identity audit against the evaluation set, and the train/validation split |
| `train.py` | Method A (partial self-distillation fine-tune of SFace) and method B (enhancement front-end in front of frozen SFace) |
| `export.py` | ONNX export with the SFace I/O contract, PyTorch-vs-onnxruntime parity, and CPU latency against the original |
| `eval.py` | Held-out evaluation on the vision agent's simulated webcam frames and clean photos: EER, TAR@FAR, family impostors, 3-frame averaging, identity-cluster bootstrap CIs and paired deltas |
| `ts/harness.mts` | Runs the vision agent's **production webcam harness** (`apps/server/src/eval/webcam-*.ts`, the v2 pipeline: quality gate, low-light detection pass, flip/denoise recipe, templates, calibrated LLR/SPRT, engine checks) with another model, via a model-specific cache tag. Optional `--refit` recalibrates `BUCKET_MODELS` to the model's own score distributions. The summary includes the **matched-degradation** case (dim/backlit enrolment vs same-condition probes) |
| `report.py` | Markdown tables from `eval.py` JSON |
| `check_recipes.py` | Parity of `prep.py` with the server's recipe embeddings |
| `ts/render_val_frames.mts`, `check_matched.py` | Validation portraits rendered by the TypeScript simulator, and the matched-degradation impostor check (dim-room reference vs dim-room impostors) on 150 held-out identities: about 57k impostor pairs per condition, no evaluation identities |
| `check_parity.py`, `ts/dump_embeddings.mts` | Python-vs-server parity of decode, alignment and embedding (also runs a candidate through the real TS engine) |
| `ts/export_faceset.mts` | Lists the evaluation images from `apps/server/src/eval/datasets.ts` (single source of truth) |

## Reproduce

```bash
# 0. environment (CPU is enough; PyPI wheels only)
python3 -m venv /tmp/claude-0/mlenv && /tmp/claude-0/mlenv/bin/pip install -r tools/recognizer/requirements.txt
PY=/tmp/claude-0/mlenv/bin/python; TSX=apps/server/node_modules/.bin/tsx; export RECOG_WORK=/tmp/claude-0/recognizer

# 1. data
$PY tools/recognizer/fetch_data.py                                   # training portraits (public domain), ~180 MB
pnpm --filter @sp/server eval:fetch-faces                            # evaluation photos (datasets.ts cache)
mkdir -p $RECOG_WORK/eval && $TSX tools/recognizer/ts/export_faceset.mts > $RECOG_WORK/eval/faceset.json
# evaluation webcam frames: rendered + analysed by the server's harness (apps/server/src/eval/webcam-eval.ts,
# cache $SP_FACESETS_DIR/_frames/v3). eval.py reads that cache (frames + production landmarks).

# 2. parity: Python crops/embeddings vs the production TypeScript engine (requirement cosine >= 0.99)
find /tmp/claude-0/facesets -name '*.jpg' -o -name '*.png' | grep -v _trees | grep -v _frames > $RECOG_WORK/eval_files.txt
$TSX tools/recognizer/ts/dump_embeddings.mts $RECOG_WORK/eval_files.txt > $RECOG_WORK/ts_dump_eval.jsonl
$PY tools/recognizer/check_parity.py $RECOG_WORK/ts_dump_eval.jsonl

# 3. training crops (clean + 12 degraded renders per portrait, identity audit, split) ~25 min on 2 cores
$PY tools/recognizer/build_train.py --workers 2

# 4. train (CPU, ~6-9 s/step on 2-3 shared cores; docs/accuracy/recognizer.md lists the runs that were compared)
#    A_nce  (method A, the base of the shipped candidate)
$PY tools/recognizer/train.py --method A --name A_nce --train-upto conv_7 --steps 1200 --batch 32 --clean-batch 8 --lr 1e-4 \
    --w-nce 0.1 --tau 0.07 --w-rel 10          # stopped at step 760 (validation flat); best step 700
#    ablations: A_upto7 = same without InfoNCE (--w-rel 5, no --w-nce); B_enh = enhancer front-end
$PY tools/recognizer/train.py --method A --name A_upto7 --train-upto conv_7 --steps 1200 --batch 32 --clean-batch 8 --lr 1e-4
$PY tools/recognizer/train.py --method B --name B_enh --steps 1200 --batch 32 --clean-batch 8 --lr 1e-3 --w-nce 0.1 --w-rel 10 --w-pix 0.1

# 4b. A_mdeg = the CANDIDATE: matched-degradation fine-tune (dim-room reference vs dim-room impostors) from A_nce
$PY tools/recognizer/train.py --method A --name A_mdeg --train-upto conv_7 --init $RECOG_WORK/runs/A_nce/best.pt --steps 500 \
    --batch 32 --clean-batch 8 --lr 5e-5 --w-nce 0.1 --tau 0.07 --w-rel 10 --w-dd 10 --w-mean 50 --p-homog 0.5 --dd-penalty 5

# 4c. validation portraits rendered by the TypeScript simulator -> matched-degradation impostor check (no eval identities)
$PY -c "import numpy as np; d=np.load('$RECOG_WORK/train/dataset.npz'); open('$RECOG_WORK/val_names.txt','w').write('\n'.join(d['names'][d['is_val']])+'\n')"
$TSX tools/recognizer/ts/render_val_frames.mts $RECOG_WORK/val_names.txt $RECOG_WORK/train/congress $RECOG_WORK/valframes
$PY tools/recognizer/check_matched.py --model base=apps/server/models/face_recognition_sface_2021dec.onnx --model A=$RECOG_WORK/export/A_mdeg.onnx

# 5. export + parity + latency
$PY tools/recognizer/export.py --run A_mdeg --method A --train-upto conv_7 --out $RECOG_WORK/export/A_mdeg.onnx

# 6. evaluate (first --model is the reference for paired deltas); protocols photo, checkin (good-light check-in),
#    checkin:dim / checkin:backlit (MATCHED degradation: enrolled in the same poor light as the probes)
$PY tools/recognizer/eval.py --embed-only --model A=$RECOG_WORK/export/A_mdeg.onnx --recipe none --recipe none+flip   # optional, parallel
$PY tools/recognizer/eval.py --model base=apps/server/models/face_recognition_sface_2021dec.onnx \
    --model A=$RECOG_WORK/export/A_mdeg.onnx --recipe none --recipe none+flip --mixed --out $RECOG_WORK/eval/report
$PY tools/recognizer/report.py $RECOG_WORK/eval/report.json --protocol photo

# 7. the production harness (v2 pipeline) with the candidate swapped in, then recalibrated
mkdir -p $RECOG_WORK/harness
for m in base:apps/server/models/face_recognition_sface_2021dec.onnx A:$RECOG_WORK/export/A_mdeg.onnx; do
  $TSX tools/recognizer/ts/harness.mts --model ${m#*:} --tag ${m%%:*} --recipe v2 --shards 2 \
      --summary $RECOG_WORK/harness/${m%%:*}-v2.summary.json
  $TSX tools/recognizer/ts/harness.mts --model ${m#*:} --tag ${m%%:*} --recipe v2 --shards 1 \
      --refit $RECOG_WORK/harness/${m%%:*}-v2.summary.json --summary $RECOG_WORK/harness/${m%%:*}-v2-refit.summary.json
done
#    NOTE: the harness uses the vision code in the working tree. Run base and candidate on the SAME calibration version
#    (the report's calibrationVersion; --out writes it).

# 8. quality-routed hybrid: candidate embeddings for POOR-bucket frames only, SFace elsewhere (needs both caches above)
$TSX tools/recognizer/ts/harness.mts --model $RECOG_WORK/export/A_mdeg.onnx --tag A --recipe v2 --shards 1 \
    --hybrid-base apps/server/models/face_recognition_sface_2021dec.onnx --summary $RECOG_WORK/harness/hybrid.summary.json
$PY tools/recognizer/report.py --harness base=$RECOG_WORK/harness/base-v2.summary.json,A=$RECOG_WORK/harness/A-v2-refit.summary.json,hybrid=$RECOG_WORK/harness/hybrid.summary.json

# 9. matched-degradation false-match rates with paired bootstrap CIs (base / candidate / hybrid), production pipeline
$TSX tools/recognizer/ts/matched.mts --base apps/server/models/face_recognition_sface_2021dec.onnx \
    --cand $RECOG_WORK/export/A_mdeg.onnx --tag A --reps 1000 --out $RECOG_WORK/harness/matched.json
```

## Deciding

Ship only if **all** of the following hold on the evaluation set. The paired bootstrap CIs are in `eval.py` /
`ts/matched.mts` output.
* **Win**: a pooled-webcam win in both ΔEER and ΔTAR@1e-3.
* **Non-inferiority on clean / good / typical / sidelit**: ΔEER upper CI ≤ +1.0 pt and ΔTAR@1e-3 lower CI
  ≥ −3.0 pts.
* **Matched degradation**: FMR not worse in dim or backlit (at the model's own good-light threshold and at 0.45).
* **Families**: no worse family swap detection, and no worse family pass at checks.
* **Poor light**: a clear poor-bucket gain.
* **Engineering**: ONNX parity ≥ 0.999 and latency ≤ 2×.

If shipping, recalibrate every model in `apps/server/src/vision/calibration.ts`, not only `BUCKET_MODELS`.

## Rules this tooling follows

* **Label-free training.** Training uses only image bytes: no names or identity labels. The teacher is the
  original SFace on the clean crop, and the student learns to reproduce that embedding from a degraded capture of
  the same photo.
* **Disjoint identities.** Training portraits of people who also appear in the evaluation sets are excluded by id
  (Biden, Obama). Any portrait whose SFace similarity to any evaluation photo is ≥ 0.45 is also dropped
  (`$RECOG_WORK/train/audit.json`).
* **Validation ≠ evaluation.** Early stopping uses held-out *training-source* portraits only. The evaluation
  identities are used once per candidate, for reporting.
* **Independent degradation code for training and evaluation.** Training frames are rendered by `webcam.py`
  (PIL/OpenCV), evaluation frames by the server's TypeScript simulator (sharp/libvips). Both use the same ranges,
  so a model cannot win by learning one implementation's artefacts.
* **Licences.** Code dependencies are BSD/Apache/MIT (Pillow: MIT-CMU). No pretrained weights other than SFace
  (Apache-2.0). No non-commercial datasets or weights.
