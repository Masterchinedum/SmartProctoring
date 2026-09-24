"""
Held-out evaluation of SFace-compatible recognisers under webcam conditions. THE ONLY THING THAT DECIDES.

  python tools/recognizer/eval.py --model base=apps/server/models/face_recognition_sface_2021dec.onnx \
      --model A=$RECOG_WORK/export/A.onnx --recipe none --recipe none+flip --recipe gamma+flip \
      --out $RECOG_WORK/eval/report

Data (identity-labelled, identities disjoint from training — see build_train.py audit):
  * the public identity sets of apps/server/src/eval/datasets.ts (142 photos, 43 identities, 3 families), and
  * their simulated laptop-webcam frames rendered by the vision agent's TypeScript simulator
    (apps/server/src/eval/webcam-sim.ts via webcam-eval.ts, cache $SP_FACESETS_DIR/_frames/v3):
    every photo x {good, typical, dim, backlit, sidelit} x {640x480, 1280x720} x 2 scenes x 3 burst frames,
    plus 5 "check-in" frames (session jitter) of each identity's most frontal photo per enrolment condition.
    Landmarks are the PRODUCTION detector's (TypeScript engine, cached in analysis-*.jsonl), so crops are the
    server's crops (check_parity.py: cosine >= 0.99 to the server embedding).
  * three derived stress conditions made here from the 'typical' probe frames (deterministic seeds):
    lowres (x0.4 area downscale -> bilinear upscale -> JPEG 80), noisy (+ luma sigma 10, chroma sigma 5 -> JPEG 85),
    compressed (JPEG re-encode q 20). Landmarks: those of the source 'typical' frame (geometry is unchanged).

Protocols
  photo    enrol with a CLEAN photo i (every photo of every identity in turn), probe with frames of every OTHER
           photo j != i. Genuine = same identity; impostor = different identity; family = different identity,
           same family (Azure family photos: parents/children/spouses). Near-duplicate photo pairs (clean baseline
           similarity >= 0.97) are excluded from genuine trials.
  checkin[:<cond>]  enrol with the MEAN TEMPLATE of the 5 check-in frames (640x480, session jitter) of the identity's
           enrolment photo rendered in <cond> (default good; >= 3 frames with a face needed, else not enrolled) -- the
           vision agent's v2 recommendation, identity-v2.md §6.1 -- and probe with frames of the identity's other
           photos. checkin:dim / checkin:backlit give the MATCHED-DEGRADATION case (dim room enrolment vs dim room
           probes, where SFace impostor similarity inflates); conditions "<cond>@640x480" restrict probes to 480p.
  "3f"     suffix: probe = normalise(mean of the 3 burst frames' embeddings) of one scene (resume-check style).
  mixed    (--mixed) enrolment templates computed with the BASELINE model (existing stored templates) and probes
           with the candidate: backward compatibility without re-enrolment.

Pooled pseudo-conditions: webcam_all = the 5 simulator conditions together (PRIMARY endpoint), stress_all = the 3
derived stress conditions together.

Metrics per condition: n trials (and identity / photo clusters), genuine mean / 5th pct, impostor 99th pct / max,
EER, TAR @ FAR 1e-2 and 1e-3, family-impostor mean / max. 95 % confidence intervals by an identity-cluster
bootstrap (identities resampled with replacement; trials weighted by identity multiplicity), and PAIRED bootstrap
intervals of the difference to the first model/recipe (same resamples), which is what decides "better".
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path

import numpy as np

from common import FACESETS, SFACE_ONNX, WORK, OrtEmbedder, align_primary, decode_image, encode_jpeg, l2n, load_rgb, Face, sha256_file, write_json
from prep import views

FRAMES = FACESETS / "_frames"
SIM_DIR = "v3"
CONDITIONS = ["clean", "webcam_all", "good", "typical", "dim", "backlit", "sidelit", "stress_all", "lowres", "noisy", "compressed"]
POOLED = {"webcam_all": ("good", "typical", "dim", "backlit", "sidelit"), "stress_all": ("lowres", "noisy", "compressed")}
DERIVED = ("lowres", "noisy", "compressed")
NEAR_DUP = 0.97

# ------------------------------------------------------------------------------------------------ crops


def _safe(key: str) -> str:
    return re.sub(r"[^a-zA-Z0-9_-]+", "_", key)


def _derive(rgb: np.ndarray, kind: str, seed: int) -> np.ndarray:
    import cv2

    rng = np.random.default_rng(seed)
    h, w = rgb.shape[:2]
    if kind == "lowres":
        small = cv2.resize(rgb, (round(w * 0.4), round(h * 0.4)), interpolation=cv2.INTER_AREA)
        return load_rgb(encode_jpeg(cv2.resize(small, (w, h), interpolation=cv2.INTER_LINEAR), 80))
    if kind == "noisy":
        f = rgb.astype(np.float32) + rng.normal(0, 10, (h, w, 1)).astype(np.float32)
        ch = cv2.resize(rng.normal(0, 5, (h // 4 + 1, w // 4 + 1, 3)).astype(np.float32), (w, h), interpolation=cv2.INTER_LINEAR)
        return load_rgb(encode_jpeg(np.clip(np.rint(f + ch), 0, 255).astype(np.uint8), 85))
    if kind == "compressed":
        return load_rgb(encode_jpeg(rgb, 20))
    raise ValueError(kind)


def load_records(frames_dir: Path) -> list[dict]:
    """Records of ONE analysis pipeline key (the one with the most records; shards merged)."""
    by_key = {}
    for f in frames_dir.glob("analysis-*.jsonl"):
        k = f.name.split("-")[1].split(".")[0]
        by_key.setdefault(k, []).append(f)
    key = max(by_key, key=lambda k: sum(sum(1 for _ in open(f)) for f in by_key[k]))
    print(f"analysis pipeline key {key} ({len(by_key)} keys found)")
    recs = {}
    for f in sorted(by_key[key]):
        for line in open(f):
            if not line.strip():
                continue
            try:
                r = json.loads(line)
            except json.JSONDecodeError:
                continue
            recs[r["id"]] = r
    return list(recs.values())


def build_crops(out: Path, frames_dir: Path = FRAMES) -> dict:
    """Align every clean photo and every analysed frame with the production landmarks. Cached."""
    if out.exists():
        d = np.load(out, allow_pickle=False)
        return {k: d[k] for k in d.files}
    t0 = time.time()
    sources = json.load(open(frames_dir / f"sources-{SIM_DIR}.json"))
    records = load_records(frames_dir)
    meta = {k: [] for k in ("kind", "photo", "identity", "family", "condition", "resolution", "scene", "frame", "usable", "default_emb")}
    crops, valids = [], []

    def add(crop_valid, **m):
        c, v = crop_valid
        crops.append(c.astype(np.float16))
        valids.append(v)
        for k in meta:
            meta[k].append(m.get(k, "" if k not in ("scene", "frame") else -1))

    for s in sources:
        dec = decode_image(FACESETS / s["file"])
        f = Face(box=(0, 0, 1, 1), score=1.0, landmarks=np.array([[p["x"], p["y"]] for p in s["landmarks"]]))
        add(_align_valid(dec, f), kind="clean", photo=s["key"], identity=s["identity"], family=s["family"] or "", condition="clean", usable=True,
            default_emb=np.zeros(128, np.float32))
    skipped = 0
    for n, r in enumerate(records):
        if not r.get("faces"):
            skipped += 1
            continue
        file = frames_dir / SIM_DIR / _safe(r["photoKey"]) / f"{r['role']}-{r['condition']}-{r['resolution']}-s{r['scene']}-f{r['frame']}.jpg"
        if not file.exists():
            skipped += 1
            continue
        lm = np.array([[p["x"], p["y"]] for p in r["faces"][0]["landmarks"]])
        f = Face(box=(0, 0, 1, 1), score=1.0, landmarks=lm)
        rgb = load_rgb(file)
        base = dict(kind=r["role"], photo=r["photoKey"], identity=r["identity"], family=r["family"] or "", resolution=r["resolution"],
                    scene=r["scene"], frame=r["frame"], usable=bool(r["quality"].get("usable")))
        emb = r.get("embeddings") or {}
        de = np.frombuffer(__import__("base64").b64decode(emb["default"]), np.float32) if "default" in emb else np.zeros(128, np.float32)
        add(_align_valid(decode_image(rgb), f), condition=r["condition"], default_emb=de, **base)
        if r["role"] == "probe" and r["condition"] == "typical":
            for kind in DERIVED:
                seed = int(hashlib.sha256(f"{r['id']}|{kind}".encode()).hexdigest()[:8], 16)
                add(_align_valid(decode_image(_derive(rgb, kind, seed)), f), condition=kind, default_emb=np.zeros(128, np.float32), **{**base, "usable": True})
        if (n + 1) % 1000 == 0:
            print(f"  crops {n + 1}/{len(records)} ({time.time() - t0:.0f}s)", flush=True)
    d = {k: np.array(v) for k, v in meta.items()}
    d["crops"] = np.stack(crops)
    d["valid"] = np.stack(valids)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(out, **d)
    print(f"crops: {len(crops)} ({skipped} frames without a face / file), {time.time() - t0:.0f}s")
    return d


def _align_valid(dec, face):
    from common import MIN_ALIGN_INTER_EYE, align_face

    if dec.scale < 1 and face.inter_eye * dec.scale < MIN_ALIGN_INTER_EYE:
        # rare (large clean photos with small faces): production re-samples from the original; no valid mask needed
        c = align_primary(dec, face)
        return c, np.ones(c.shape[:2], bool)
    return align_face(dec.rgb, face.landmarks * dec.scale, with_valid=True)


# ------------------------------------------------------------------------------------------- embeddings


def embed_all(d: dict, model_path: str, recipe: str, cache_dir: Path) -> np.ndarray:
    norm, _, flip = recipe.partition("+")
    key = f"{sha256_file(model_path)[:16]}_{recipe}_{len(d['crops'])}"
    f = cache_dir / f"emb_{key}.npy"
    if f.exists():
        return np.load(f)
    emb = OrtEmbedder(model_path, threads=2)
    out = np.zeros((len(d["crops"]), 128), np.float32)
    bs = 256
    for i in range(0, len(out), bs):
        xs = [views(c.astype(np.float32), v, norm, flip == "flip") for c, v in zip(d["crops"][i : i + bs], d["valid"][i : i + bs])]
        nv = len(xs[0])
        batch = np.stack([x for vs in xs for x in vs]).transpose(0, 3, 1, 2)
        e = emb(np.ascontiguousarray(batch)).reshape(len(xs), nv, 128).sum(1)
        out[i : i + bs] = l2n(e)
    cache_dir.mkdir(parents=True, exist_ok=True)
    np.save(f, out)
    return out


# ---------------------------------------------------------------------------------------------- trials


def build_trials(d: dict, E_enrol: np.ndarray, E_probe: np.ndarray, base_clean: np.ndarray, protocol: str, cond: str, three: bool, usable_only: bool):
    """Returns dict(genuine scores, genuine identity idx, impostor scores, (enrol id idx, probe id idx), family mask)."""
    ids = sorted(set(d["identity"]))
    idx = {k: i for i, k in enumerate(ids)}
    kind, photo, ident, fam, condition = d["kind"], d["photo"], d["identity"], d["family"], d["condition"]
    # --- probes
    cname, _, res = cond.partition("@")
    if cname == "clean":
        pm = kind == "clean"
    else:
        pm = (kind == "probe") & np.isin(condition, POOLED.get(cname, (cname,)))
        if res:
            pm &= d["resolution"] == res
        if usable_only:
            pm &= d["usable"]
    pidx = np.nonzero(pm)[0]
    if three and cname != "clean":
        groups = {}
        for i in pidx:
            groups.setdefault((photo[i], condition[i], d["resolution"][i], d["scene"][i]), []).append(i)
        P = np.stack([l2n(E_probe[g].mean(0)) for g in groups.values()])
        p_photo = np.array([k[0] for k in groups])
        p_first = np.array([g[0] for g in groups.values()])
    else:
        P = E_probe[pidx]
        p_photo = photo[pidx]
        p_first = pidx
    p_id, p_fam = ident[p_first], fam[p_first]
    # --- enrolment templates
    clean_idx = np.nonzero(kind == "clean")[0]
    clean_of = {photo[i]: i for i in clean_idx}
    if protocol == "photo":
        enrol = [(photo[i], ident[i], fam[i], E_enrol[i][None]) for i in clean_idx]
    else:  # checkin[:<enrolment condition>], default good light
        econd = protocol.partition(":")[2] or "good"
        em = (kind == "enrol") & (condition == econd)
        enrol = []
        for ph in sorted(set(photo[em])):
            g = np.nonzero(em & (photo == ph))[0]
            if len(g) < 3:  # production needs >= 3 frames with a face to enrol (CALIBRATION.minFramesForDecision)
                continue
            enrol.append((ph, ident[g[0]], fam[g[0]], l2n(E_enrol[g].mean(0))[None]))  # mean template (identity-v2 §6.1)
    # --- scores
    gs, gid, is_, ie, ip, ifam = [], [], [], [], [], []
    for ph, idn, fm, T in enrol:
        s = (P @ T.T).max(1)
        other = p_photo != ph
        same = (p_id == idn) & other
        if same.any():
            # exclude near-duplicate photo pairs (clean baseline similarity >= NEAR_DUP)
            dup = np.array([float(base_clean[clean_of[ph]] @ base_clean[clean_of[q]]) >= NEAR_DUP for q in p_photo[same]])
            gs.append(s[same][~dup])
            gid.append(np.full((~dup).sum(), idx[idn]))
        diff = p_id != idn
        is_.append(s[diff])
        ie.append(np.full(diff.sum(), idx[idn]))
        ip.append(np.array([idx[x] for x in p_id[diff]]))
        ifam.append((p_fam[diff] == fm) & (fm != ""))
    cat = lambda xs, dt=np.float32: np.concatenate(xs).astype(dt) if xs else np.zeros(0, dt)  # noqa: E731
    return dict(g=cat(gs), gid=cat(gid, np.int64), i=cat(is_), ie=cat(ie, np.int64), ip=cat(ip, np.int64), fam=cat(ifam, bool), n_ids=len(ids),
                n_probe_photos=len(set(p_photo)), n_enrol=len(enrol))


# ---------------------------------------------------------------------------------------------- metrics

BINS = np.linspace(-1.0, 1.0, 4001)


def _hist(scores, groups, n_groups):
    b = np.clip(np.searchsorted(BINS, scores, side="right") - 1, 0, len(BINS) - 2)
    H = np.zeros((n_groups, len(BINS) - 1))
    np.add.at(H, (groups, b), 1.0)
    return H


def _metrics_from_hist(hg: np.ndarray, hi: np.ndarray) -> dict:
    """hg, hi: (R, bins) weighted histograms -> EER, TAR@FAR arrays of shape (R,)."""
    tg = hg.sum(1, keepdims=True)
    ti = hi.sum(1, keepdims=True)
    # at threshold = lower edge of bin k: accept scores in bins >= k
    far = np.cumsum(hi[:, ::-1], 1)[:, ::-1] / np.maximum(ti, 1e-12)
    tar = np.cumsum(hg[:, ::-1], 1)[:, ::-1] / np.maximum(tg, 1e-12)
    frr = 1 - tar
    k = np.argmin(np.abs(far - frr), 1)
    r = np.arange(len(hg))
    out = {"eer": (far[r, k] + frr[r, k]) / 2}
    for name, target in (("tar_far1e-2", 1e-2), ("tar_far1e-3", 1e-3)):
        ok = far <= target
        kk = np.where(ok.any(1), ok.argmax(1), far.shape[1] - 1)
        out[name] = tar[r, kk]
    return out


def point_metrics(t: dict, thresholds: dict | None = None) -> dict:
    g, i = t["g"], t["i"]
    res = {"n_genuine": int(len(g)), "n_impostor": int(len(i)), "n_family": int(t["fam"].sum()), "n_identities_genuine": int(len(set(t["gid"].tolist()))),
           "n_probe_photos": t["n_probe_photos"], "n_enrol": t["n_enrol"]}
    if len(g) == 0 or len(i) == 0:
        return res
    hg = np.histogram(g, BINS)[0][None].astype(float)
    hi = np.histogram(i, BINS)[0][None].astype(float)
    m = {k: float(v[0]) for k, v in _metrics_from_hist(hg, hi).items()}
    res.update(m)
    res.update(genuine_mean=float(g.mean()), genuine_p05=float(np.quantile(g, 0.05)), impostor_mean=float(i.mean()),
               impostor_p99=float(np.quantile(i, 0.99)), impostor_max=float(i.max()))
    thr = float(np.quantile(i, 1 - 1e-3))
    res["thr_far1e-3"] = thr
    for name, th in (thresholds or {}).items():
        res[f"fmr_at_{name}"] = float((i >= th).mean())
        res[f"fnmr_at_{name}"] = float((g < th).mean())
    f = i[t["fam"]]
    if len(f):
        res.update({"family_mean": float(f.mean()), "family_max": float(f.max()), "family_fmr_at_thr1e-3": float((f >= thr).mean())})
    return res


def bootstrap(trials: list[dict], reps: int = 400, seed: int = 0, thresholds: list[dict] | None = None) -> list[dict]:
    """Identity-cluster bootstrap for several trial sets over the SAME identities (paired). Returns per set the
    (R,) arrays of EER / TAR metrics."""
    n_ids = trials[0]["n_ids"]
    rng = np.random.default_rng(seed)
    cnt = rng.multinomial(n_ids, np.full(n_ids, 1 / n_ids), size=reps).astype(float)  # (R, n_ids)
    out = []
    for k, t in enumerate(trials):
        if len(t["g"]) == 0 or len(t["i"]) == 0:
            out.append(None)
            continue
        Hg = _hist(t["g"], t["gid"], n_ids)  # (ids, bins)
        Hi = _hist(t["i"], t["ie"] * n_ids + t["ip"], n_ids * n_ids)  # (ids*ids, bins)
        wg = cnt @ Hg
        wi = np.einsum("ra,rb->rab", cnt, cnt).reshape(reps, -1) @ Hi
        m = _metrics_from_hist(wg, wi)
        for name, th in ((thresholds[k] if thresholds else None) or {}).items():
            b = int(np.clip(np.searchsorted(BINS, th, side="right") - 1, 0, len(BINS) - 2))
            m[f"fmr_at_{name}"] = wi[:, b:].sum(1) / np.maximum(wi.sum(1), 1e-12)
            m[f"fnmr_at_{name}"] = wg[:, :b].sum(1) / np.maximum(wg.sum(1), 1e-12)
        out.append(m)
    return out


def ci(a: np.ndarray) -> list[float]:
    return [float(np.quantile(a, 0.025)), float(np.quantile(a, 0.975))]


# ------------------------------------------------------------------------------------------------ main


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", required=True, help="name=path.onnx (first = reference for deltas)")
    ap.add_argument("--recipe", action="append", default=None, help="none | none+flip | stretch | gamma+flip | clahe+flip ...")
    ap.add_argument("--protocol", action="append", default=None, help="photo | checkin")
    ap.add_argument("--conditions", default=",".join(CONDITIONS))
    ap.add_argument("--mixed", action="store_true", help="also evaluate baseline enrolment vs candidate probes")
    ap.add_argument("--usable-only", action="store_true", help="only probes that passed the production quality gate")
    ap.add_argument("--reps", type=int, default=400)
    ap.add_argument("--embed-only", action="store_true", help="only fill the embedding cache (run several in parallel), then exit")
    ap.add_argument("--out", default=str(WORK / "eval" / "report"))
    ap.add_argument("--crops", default=str(WORK / "eval" / "crops.npz"))
    args = ap.parse_args()
    t0 = time.time()
    d = build_crops(Path(args.crops))
    models = [m.split("=", 1) for m in args.model]
    recipes = args.recipe or ["none"]
    protocols = args.protocol or ["photo", "checkin", "checkin:dim", "checkin:backlit"]
    conds = args.conditions.split(",")
    cache = WORK / "eval" / "emb"
    base_path = str(SFACE_ONNX)
    if args.embed_only:
        for _, path in models:
            for rc in recipes:
                embed_all(d, path, rc, cache)
        print(f"embeddings cached ({time.time() - t0:.0f}s)")
        return
    base_raw = embed_all(d, base_path, "none", cache)
    # parity with the server: our baseline embeddings vs the TS engine's cached 'default' embeddings
    has = np.abs(d["default_emb"]).sum(1) > 0
    par = (base_raw[has] * d["default_emb"][has]).sum(1)
    parity = {"frames": int(has.sum()), "cos_min": float(par.min()), "cos_p01": float(np.quantile(par, 0.01)), "cos_median": float(np.median(par))}
    print("parity vs server embeddings:", parity, flush=True)
    variants = []  # (label, enrol embeddings, probe embeddings)
    for name, path in models:
        for rc in recipes:
            E = embed_all(d, path, rc, cache)
            variants.append((f"{name}|{rc}", E, E))
            if args.mixed and path != base_path:
                Eb = embed_all(d, base_path, rc, cache)
                variants.append((f"{name}|{rc}|mixed", Eb, E))
    report = {"generated": time.strftime("%Y-%m-%d %H:%M"), "parity": parity, "models": {n: {"path": p, "sha256": sha256_file(p)} for n, p in models},
              "usable_only": args.usable_only, "near_duplicate_threshold": NEAR_DUP, "results": {}}
    # Operating points per variant: its OWN good-light threshold (check-in in good light vs good-light probes,
    # FAR 1e-3) and the fixed product match threshold 0.45. FMR at these on matched-degradation pairs = inflation.
    op = []
    for _, Ee, Ep in variants:
        ti = build_trials(d, Ee, Ep, base_raw, "checkin", "good", False, args.usable_only)["i"]
        op.append({"own_good_thr": float(np.quantile(ti, 1 - 1e-3)), "0.45": 0.45})
    report["operating_points"] = {lab: o for (lab, _, _), o in zip(variants, op)}
    print("operating points:", report["operating_points"], flush=True)
    for proto in protocols:
        pconds = conds
        if proto.startswith("checkin:") and proto != "checkin:good":
            ec = proto.split(":")[1]
            pconds = [c for c in (ec, f"{ec}@640x480", "webcam_all", "good") if c.split("@")[0] in conds or c == f"{ec}@640x480"]
        for three in (False, True):
            for cond in pconds:
                if three and cond == "clean":
                    continue
                key = f"{proto}{'-3f' if three else ''}|{cond}"
                trials = [build_trials(d, Ee, Ep, base_raw, proto, cond, three, args.usable_only) for _, Ee, Ep in variants]
                boots = bootstrap(trials, args.reps, thresholds=op)
                row = {}
                for (label, _, _), t, b, o in zip(variants, trials, boots, op):
                    m = point_metrics(t, o)
                    if b is not None:
                        m["ci"] = {k: ci(v) for k, v in b.items()}
                        if boots[0] is not None and label != variants[0][0]:
                            m["delta_vs_ref"] = {k: {"mean": float(np.mean(v - boots[0][k])), "ci": ci(v - boots[0][k])} for k, v in b.items()}
                    row[label] = m
                report["results"][key] = row
                r0 = row[variants[0][0]]
                print(f"{key:28s} n_g={r0.get('n_genuine')} n_i={r0.get('n_impostor')} " + "  ".join(
                    f"{lab.split('|', 1)[0] + ('/' + lab.split('|', 1)[1] if len(recipes) > 1 or args.mixed else '')}: EER {m.get('eer', float('nan')):.3f} TAR3 {m.get('tar_far1e-3', float('nan')):.3f}"
                    for lab, m in row.items()), flush=True)
    write_json(Path(args.out + ".json"), report)
    print(f"wrote {args.out}.json ({time.time() - t0:.0f}s)")


if __name__ == "__main__":
    main()
