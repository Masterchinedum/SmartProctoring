# tools/recognizer — webcam-robust face recogniser (training + evaluation)

Reproducible, label-free robustness training of the server's face recogniser (OpenCV Zoo **SFace**,
`apps/server/models/face_recognition_sface_2021dec.onnx`, Apache-2.0) for laptop-webcam conditions, and the
held-out evaluation that decides whether a candidate ships. Results, decision and limitations:
[`docs/accuracy/recognizer.md`](../../docs/accuracy/recognizer.md).

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

# 4. train (CPU; see docs/accuracy/recognizer.md for the runs that were compared)
$PY tools/recognizer/train.py --method A --name A_upto7 --train-upto conv_7 --steps 1200 --batch 32 --clean-batch 8 --lr 1e-4
$PY tools/recognizer/train.py --method B --name B_enh --steps 1200 --batch 32 --clean-batch 8

# 5. export + parity + latency
$PY tools/recognizer/export.py --run A_upto7 --method A --train-upto conv_7 --out $RECOG_WORK/export/A_upto7.onnx

# 6. evaluate (first --model is the reference for paired deltas); protocols photo, checkin (good-light check-in),
#    checkin:dim / checkin:backlit (MATCHED degradation: enrolled in the same poor light as the probes)
$PY tools/recognizer/eval.py --embed-only --model A=$RECOG_WORK/export/A_nce.onnx --recipe none --recipe none+flip   # optional, parallel
$PY tools/recognizer/eval.py --model base=apps/server/models/face_recognition_sface_2021dec.onnx \
    --model A=$RECOG_WORK/export/A_nce.onnx --recipe none --recipe none+flip --mixed --out $RECOG_WORK/eval/report
$PY tools/recognizer/report.py $RECOG_WORK/eval/report.json --protocol photo

# 7. the production harness (v2 pipeline) with the candidate swapped in, then recalibrated
mkdir -p $RECOG_WORK/harness
for m in base:apps/server/models/face_recognition_sface_2021dec.onnx A:$RECOG_WORK/export/A_nce.onnx; do
  $TSX tools/recognizer/ts/harness.mts --model ${m#*:} --tag ${m%%:*} --recipe v2 --shards 2 \
      --summary $RECOG_WORK/harness/${m%%:*}-v2.summary.json
  $TSX tools/recognizer/ts/harness.mts --model ${m#*:} --tag ${m%%:*} --recipe v2 --shards 1 \
      --refit $RECOG_WORK/harness/${m%%:*}-v2.summary.json --summary $RECOG_WORK/harness/${m%%:*}-v2-refit.summary.json
done
```

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
