"""
Build the label-free training set from the downloaded public-domain portraits (fetch_data.py).

  python tools/recognizer/build_train.py [--k-train 12] [--k-val 6] [--workers 3]

Steps
  1. detect + align every portrait with the production path (common.detect_and_align) -> CLEAN crops
     (the teacher's input);
  2. identity audit against the evaluation set: SFace similarity of every portrait to every evaluation photo;
     portraits reaching --audit-max-sim (default 0.45, the product's match threshold) are DROPPED, so no
     evaluation identity can leak into training even if the id-based exclusion missed one;
  3. split portraits into train / validation (validation is used only for early stopping, never for reporting);
  4. render K degraded webcam frames per portrait (webcam.py, frame-level degradation before detection), detect
     with YuNet on the degraded frame at the production detector scale, and align from the detected landmarks
     (fallback to the known landmarks when detection fails, flagged) -> DEGRADED crops.
     Half of the samples are mirrored (source and landmarks flipped; the matching clean target is the flipped
     clean crop).

Output: $RECOG_WORK/train/dataset.npz (crops as uint8 HWC RGB, no identity labels), audit.json.
"""
from __future__ import annotations

import argparse
import json
import multiprocessing as mp
import time
from pathlib import Path

import numpy as np

from common import SFACE_ONNX, WORK, OrtEmbedder, YuNet, align_face, decode_image, detect_and_align, load_rgb, to_planar, write_json

_DET = None


def _init_worker():
    global _DET
    import cv2

    cv2.setNumThreads(1)
    _DET = YuNet(threads=1)


def _render_job(job):
    """job = (portrait index, file, landmarks, flip, seed) -> (index, flip, crop uint8, tags, det_ok, lm_err_rel)."""
    from webcam import render_frame, sample_params

    idx, file, lm, flip, seed = job
    rng = np.random.default_rng(seed)
    src = load_rgb(file)
    lm = np.asarray(lm, np.float64)
    if flip:
        src = np.ascontiguousarray(src[:, ::-1])
        lm = lm[[1, 0, 2, 4, 3]].copy()
        lm[:, 0] = src.shape[1] - 1 - lm[:, 0]
    p = sample_params(rng, None, extra=True)
    win, det_scale, true_lm = render_frame(src, lm, p, rng)
    faces = _DET.detect(win, scale=det_scale)
    ie = float(np.hypot(*(true_lm[1] - true_lm[0])))
    det_ok, err = False, -1.0
    if faces:
        # The detected face must be the subject (landmarks within 0.5 inter-eye of the truth).
        err = float(np.abs(faces[0].landmarks - true_lm).max()) / max(ie, 1e-6)
        det_ok = err < 0.5
    use = faces[0].landmarks if det_ok else true_lm + rng.normal(0, 0.03 * ie, true_lm.shape)
    crop = align_face(win, use)
    return idx, flip, np.clip(np.rint(crop), 0, 255).astype(np.uint8), p.tags, det_ok, err


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=str(WORK / "train" / "congress"))
    ap.add_argument("--eval-faceset", default=str(WORK / "eval" / "faceset.json"))
    ap.add_argument("--out", default=str(WORK / "train" / "dataset.npz"))
    ap.add_argument("--k-train", type=int, default=12)
    ap.add_argument("--k-val", type=int, default=6)
    ap.add_argument("--n-val", type=int, default=150)
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--audit-max-sim", type=float, default=0.45)
    ap.add_argument("--seed", type=int, default=20260924)
    args = ap.parse_args()
    t0 = time.time()
    files = sorted(Path(args.src).glob("*.jpg"))
    det = YuNet(threads=2)
    emb = OrtEmbedder(SFACE_ONNX)

    # 1. clean crops
    clean, lms, names = [], [], []
    for f in files:
        crop, face = detect_and_align(det, f)
        if crop is None or face.score < 0.8 or face.inter_eye < 40:
            continue
        clean.append(crop)
        lms.append(face.landmarks)
        names.append(f.name)
    clean = np.stack(clean)
    print(f"{len(files)} portraits, {len(clean)} usable faces ({time.time() - t0:.0f}s)")
    e_train = emb(clean.transpose(0, 3, 1, 2))

    # 2. identity audit vs evaluation photos
    ev = json.load(open(args.eval_faceset))["images"]
    ev_crops, ev_ids = [], []
    for im in ev:
        c, _ = detect_and_align(det, im["file"])
        if c is not None:
            ev_crops.append(to_planar(c))
            ev_ids.append(im["identity"])
    e_eval = emb(np.stack(ev_crops))
    sim = e_train @ e_eval.T
    best = sim.max(1)
    arg = sim.argmax(1)
    drop = best >= args.audit_max_sim
    top = np.argsort(-best)[:15]
    audit = {
        "threshold": args.audit_max_sim,
        "dropped": [{"portrait": names[i], "eval_identity": ev_ids[arg[i]], "similarity": round(float(best[i]), 4)} for i in np.nonzero(drop)[0]],
        "top15": [{"portrait": names[i], "eval_identity": ev_ids[arg[i]], "similarity": round(float(best[i]), 4)} for i in top],
        "eval_images": len(ev_ids),
    }
    write_json(Path(args.out).with_name("audit.json"), audit)
    print(f"audit: dropped {int(drop.sum())} portraits with similarity >= {args.audit_max_sim} to an evaluation photo; top: {audit['top15'][:3]}")
    keep = np.nonzero(~drop)[0]
    clean, lms, names = clean[keep], [lms[i] for i in keep], [names[i] for i in keep]

    # 3. split
    rng = np.random.default_rng(args.seed)
    perm = rng.permutation(len(clean))
    is_val = np.zeros(len(clean), bool)
    is_val[perm[: args.n_val]] = True

    # 4. degraded pool
    jobs = []
    for i in range(len(clean)):
        k = args.k_val if is_val[i] else args.k_train
        for j in range(k):
            jobs.append((i, str(Path(args.src) / names[i]), lms[i].tolist(), bool(j % 2), int(args.seed * 1000 + i * 97 + j)))
    print(f"rendering {len(jobs)} degraded frames with {args.workers} workers ...")
    deg = np.zeros((len(jobs), 112, 112, 3), np.uint8)
    src_idx = np.zeros(len(jobs), np.int32)
    flip = np.zeros(len(jobs), bool)
    det_ok = np.zeros(len(jobs), bool)
    lm_err = np.zeros(len(jobs), np.float32)
    tags = []
    with mp.get_context("fork").Pool(args.workers, initializer=_init_worker) as pool:
        for n, (i, fl, crop, tg, ok, err) in enumerate(pool.imap(_render_job, jobs, chunksize=16)):
            deg[n], src_idx[n], flip[n], det_ok[n], lm_err[n] = crop, i, fl, ok, err
            tags.append("+".join(tg))
            if (n + 1) % 1000 == 0:
                print(f"  {n + 1}/{len(jobs)} ({(time.time() - t0):.0f}s)", flush=True)
    print(f"detected on the degraded frame: {det_ok.mean():.1%}; median landmark error {np.median(lm_err[det_ok]):.3f} x inter-eye")
    np.savez(
        args.out,
        clean=np.clip(np.rint(clean), 0, 255).astype(np.uint8),
        clean_float=clean.astype(np.float16),
        names=np.array(names),
        is_val=is_val,
        deg=deg,
        deg_src=src_idx,
        deg_flip=flip,
        deg_det_ok=det_ok,
        deg_lm_err=lm_err,
        deg_tags=np.array(tags),
    )
    print(f"saved {args.out} ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
