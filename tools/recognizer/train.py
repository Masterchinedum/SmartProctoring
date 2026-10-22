"""
Label-free robustness training of SFace (no identity labels are used anywhere in training).

  python tools/recognizer/train.py --method A --name A_upto7 --train-upto conv_7 --steps 1500
  python tools/recognizer/train.py --method B --name B_enh --steps 1500

Teacher = the frozen original SFace on the CLEAN aligned crop of a portrait (targets precomputed, both
orientations). Student input = a DEGRADED crop of the same portrait (webcam.py frame-level render -> YuNet on the
degraded frame -> alignment), optionally with extra crop-level degradation (torch, below).

Method A  self-distillation: a copy of SFace whose layers up to --train-upto are fine-tuned (conv weights, BN affine
          parameters, PReLU slopes); BN running statistics stay frozen (eval mode) and deeper layers + FC are frozen.
Method B  enhancement front-end E (small U-Net, ~60 k parameters, zero-initialised residual => identity at start)
          in front of the FROZEN SFace; exported together as one SFace-compatible model.

Loss (L2-normalised embeddings s = student, t = teacher target, over a batch of distinct portraits):
    L = mean(1 - <s(deg_i), t_i>)                                   degraded -> clean
      + w_clean * mean(1 - <s(clean_i), t_i>)                       stay compatible on clean input
      + w_rel * mean_{i != j} (<s(deg_i), t_j> - <t_i, t_j>)^2      keep the teacher's impostor geometry
      + w_rel * mean_{i != j} (<s(clean_i), t_j> - <t_i, t_j>)^2
      (+ w_pix * mean|E(clean) - clean| / 255 for method B)
      (+ w_dd * mean_{i != j} (<s(deg_i), s(deg_j)> - <t_i, t_j>)^2      degraded-vs-degraded geometry (MATCHED
         degradation: a dim-room reference vs dim-room probes), with --p-homog condition-homogeneous batches
       + w_mean * [(mean <s(deg_i), t_j> - mean <t_i, t_j>)^2 + (mean <s(deg_i), s(deg_j)> - mean <t_i, t_j>)^2]
         first-moment (impostor-mean) penalties)
      (+ w_nce * InfoNCE(s(deg_i) vs the teacher's clean embeddings of ALL training portraits, both orientations,
         temperature tau): instance discrimination against fixed prototypes, still label-free; counteracts the
         regression-to-the-mean of the cosine term, which raises impostor similarity on uninformative inputs)

Validation (early stopping; never the evaluation identities): held-out portraits, degraded crops vs clean teacher
embeddings: mean cosine, rank-1 identification among the validation gallery, TAR at FAR 1e-2 / 1e-3 (degraded probe
vs clean template), 99th-percentile impostor similarity, and clean-input compatibility <s(clean), t(clean)>.
"""
from __future__ import annotations

import argparse
import json
import math
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from torch import nn

from common import WORK, fold_bn, sface_torch, write_json

# features index of the PReLU block that ends each named layer (conv_1 = 0, conv_k_dw = 2k-3, conv_k = 2k-2)
LAYER_END = {f"conv_{k}": 2 * k - 2 for k in range(2, 15)} | {"conv_1": 0}


class Enhancer(nn.Module):
    """Small U-Net predicting a residual correction of the aligned crop (input/output RGB 0..255)."""

    def __init__(self, c1: int = 16, c2: int = 32, blocks: int = 2):
        super().__init__()
        self.h1 = nn.Sequential(nn.Conv2d(3, c1, 3, 1, 1), nn.PReLU(c1))
        self.h2 = nn.Sequential(nn.Conv2d(c1, c2, 3, 2, 1), nn.PReLU(c2))
        self.h3 = nn.Sequential(nn.Conv2d(c2, c2, 3, 2, 1), nn.PReLU(c2))
        self.body = nn.ModuleList(
            nn.Sequential(nn.Conv2d(c2, c2, 3, 1, 1), nn.PReLU(c2), nn.Conv2d(c2, c2, 3, 1, 1)) for _ in range(blocks)
        )
        self.u2 = nn.Sequential(nn.Conv2d(2 * c2, c1, 3, 1, 1), nn.PReLU(c1))
        self.u1 = nn.Sequential(nn.Conv2d(2 * c1, c1, 3, 1, 1), nn.PReLU(c1))
        self.out = nn.Conv2d(c1, 3, 3, 1, 1)
        nn.init.zeros_(self.out.weight)
        nn.init.zeros_(self.out.bias)

    def forward(self, x):
        xn = x * (1 / 127.5) - 1
        h1 = self.h1(xn)
        h2 = self.h2(h1)
        h = self.h3(h2)
        for b in self.body:
            h = h + b(h)
        h = F.interpolate(h, scale_factor=2, mode="bilinear", align_corners=False)
        h = self.u2(torch.cat([h, h2], 1))
        h = F.interpolate(h, scale_factor=2, mode="bilinear", align_corners=False)
        h = self.u1(torch.cat([h, h1], 1))
        return x + 127.5 * self.out(h)


class EnhancedSFace(nn.Module):
    def __init__(self, enhancer: nn.Module, sface: nn.Module):
        super().__init__()
        self.enhancer = enhancer
        self.sface = sface

    def forward(self, x):
        return self.sface(self.enhancer(x))


def build_student(method: str, train_upto: str, enh_c1: int = 16, enh_c2: int = 32, enh_blocks: int = 2):
    base = fold_bn(sface_torch())
    for p in base.parameters():
        p.requires_grad_(False)
    if method == "A":
        end = LAYER_END[train_upto]
        trainable = []
        for i, blk in enumerate(base.features):
            if i <= end:
                for p in blk.parameters():
                    p.requires_grad_(True)
                    trainable.append(p)
        return base, trainable
    enh = Enhancer(enh_c1, enh_c2, enh_blocks)
    return EnhancedSFace(enh, base), list(enh.parameters())


# ---------------------------------------------------------------------------------------- crop-level aug


def _gauss_kernel(sigma: float) -> torch.Tensor:
    r = max(1, int(math.ceil(2.5 * sigma)))
    x = torch.arange(-r, r + 1, dtype=torch.float32)
    k = torch.exp(-(x**2) / (2 * sigma**2))
    return k / k.sum()


def crop_degrade(x: torch.Tensor, g: torch.Generator) -> torch.Tensor:
    """Crop-level webcam-like degradation of a batch (N,3,112,112, 0..255) with per-sample random strength."""
    n = x.shape[0]
    r = lambda lo, hi, *shape: lo + (hi - lo) * torch.rand(*(shape or (n,)), generator=g)  # noqa: E731
    lin = (x / 255).clamp(0, 1) ** 2.2
    expo = r(0.12, 1.3).view(n, 1, 1, 1)
    gains = torch.stack([r(0.9, 1.25), torch.ones(n), r(0.7, 1.1)], 1).view(n, 3, 1, 1)
    v = (lin * expo * gains).clamp(0, 1) ** (r(0.85, 1.2).view(n, 1, 1, 1) / 2.2)
    lift = r(0, 30).view(n, 1, 1, 1) / 255
    v = lift + v * (1 - lift)
    m = v.mean((1, 2, 3), keepdim=True)
    v = m + (v - m) * r(0.6, 1.0).view(n, 1, 1, 1)
    y = v * 255
    # blur (shared sigma per call keeps it cheap), optional downscale->upscale
    k = _gauss_kernel(float(r(0.4, 1.4, 1)))
    y = F.conv2d(F.pad(y, (len(k) // 2,) * 4, mode="reflect"), k.view(1, 1, 1, -1).repeat(3, 1, 1, 1), groups=3)
    y = F.conv2d(y, k.view(1, 1, -1, 1).repeat(3, 1, 1, 1), groups=3)
    if float(torch.rand(1, generator=g)) < 0.3:
        s = float(r(0.35, 0.7, 1))
        y = F.interpolate(F.interpolate(y, scale_factor=s, mode="area"), size=(112, 112), mode="bilinear", align_corners=False)
    sig = r(1, 10).view(n, 1, 1, 1)
    y = y + torch.randn(n, 1, 112, 112, generator=g) * sig + torch.randn(n, 3, 112, 112, generator=g) * sig * 0.3
    return y.clamp(0, 255).round()


# ----------------------------------------------------------------------------------------------- data


class Data:
    def __init__(self, path: Path):
        d = np.load(path)
        self.clean = d["clean_float"].astype(np.float32)  # (N,112,112,3)
        self.is_val = d["is_val"]
        self.deg = d["deg"]
        self.deg_src = d["deg_src"]
        self.deg_flip = d["deg_flip"]
        self.deg_tags = d["deg_tags"]
        self.names = d["names"]
        n = len(self.clean)
        cl = torch.from_numpy(self.clean).permute(0, 3, 1, 2).contiguous()
        self.clean_t = torch.stack([cl, cl.flip(3)], 1)  # (N, 2, 3, 112, 112): [orig, mirrored]
        cache = path.with_suffix(".teacher.npy")
        if cache.exists() and cache.stat().st_mtime >= path.stat().st_mtime:
            self.t = torch.from_numpy(np.load(cache))
        else:
            teacher = sface_torch()
            with torch.no_grad():
                t = [F.normalize(teacher(self.clean_t[i : i + 32].reshape(-1, 3, 112, 112)), dim=1).view(-1, 2, 128) for i in range(0, n, 32)]
            self.t = torch.cat(t)  # (N, 2, 128): teacher embedding of the clean crop, [original, mirrored]
            np.save(cache, self.t.numpy())
        assert self.t.shape == (n, 2, 128)
        self.train_src = np.nonzero(~self.is_val)[0]
        self.val_src = np.nonzero(self.is_val)[0]
        by = {}
        for j, s in enumerate(self.deg_src):
            by.setdefault(int(s), []).append(j)
        self.deg_by_src = by
        self.by_cond = {}
        for j, (s_, tg) in enumerate(zip(self.deg_src, self.deg_tags)):
            if not self.is_val[s_]:
                self.by_cond.setdefault(str(tg).split("+")[0], {}).setdefault(int(s_), []).append(j)

    def batch(self, rng: np.random.Generator, b: int, condition: str | None = None):
        """b distinct portraits, one degraded crop each; with `condition`, only crops rendered in that condition
        (matched degradation inside the batch)."""
        if condition is None:
            srcs = rng.choice(self.train_src, size=b, replace=False)
            js = np.array([rng.choice(self.deg_by_src[int(s)]) for s in srcs])
        else:
            pool = self.by_cond[condition]
            srcs = rng.choice(np.array(sorted(pool)), size=b, replace=False)
            js = np.array([rng.choice(pool[int(s)]) for s in srcs])
        deg = torch.from_numpy(self.deg[js]).permute(0, 3, 1, 2).float()
        fl = torch.from_numpy(self.deg_flip[js].astype(np.int64))
        s_t = torch.from_numpy(srcs)
        t = self.t[s_t, fl]
        return deg, t, s_t, fl


# ---------------------------------------------------------------------------------------------- losses


def rel_loss(s: torch.Tensor, t: torch.Tensor) -> torch.Tensor:
    gt = t @ t.T
    gs = s @ t.T
    off = ~torch.eye(len(t), dtype=torch.bool)
    return ((gs - gt)[off] ** 2).mean()


@torch.no_grad()
def validate(model: nn.Module, data: Data, max_items: int = 900) -> dict:
    model.eval()
    js = np.array([j for j, s in enumerate(data.deg_src) if data.is_val[s]])[:max_items]
    embs = []
    for i in range(0, len(js), 64):
        x = torch.from_numpy(data.deg[js[i : i + 64]]).permute(0, 3, 1, 2).float()
        embs.append(F.normalize(model(x), dim=1))
    s = torch.cat(embs)
    src = torch.from_numpy(data.deg_src[js].astype(np.int64))
    fl = torch.from_numpy(data.deg_flip[js].astype(np.int64))
    gal_ids = torch.from_numpy(data.val_src.astype(np.int64))
    gallery = data.t[gal_ids, 0]  # clean, un-mirrored teacher templates
    # probes that are mirrored are compared with the mirrored template for the genuine score
    genuine = (s * data.t[src, fl]).sum(1)
    sims = s @ gallery.T
    pos = {int(g): k for k, g in enumerate(gal_ids)}
    col = torch.tensor([pos[int(v)] for v in src])
    sims_g = sims.clone()
    sims_g[torch.arange(len(js)), col] = genuine
    rank1 = (sims_g.argmax(1) == col).float().mean().item()
    mask = torch.ones_like(sims, dtype=torch.bool)
    mask[torch.arange(len(js)), col] = False
    imp = sims[mask]
    cl = data.clean_t[gal_ids, 0]
    sc = torch.cat([F.normalize(model(cl[i : i + 64]), dim=1) for i in range(0, len(cl), 64)])
    compat = (sc * gallery).sum(1)
    tags_all = np.array([str(t).split("+")[0] for t in data.deg_tags[js]])
    dd = {}
    for c in ("dim", "backlit"):
        m_ = torch.from_numpy(tags_all == c)
        sc_ = s[m_]
        if len(sc_) > 2:
            g_ = sc_ @ sc_.T
            srcc = src[m_]
            off_ = srcc[:, None] != srcc[None, :]
            v_ = g_[off_]
            dd[f"dd_{c}_imp_mean"] = float(v_.mean())
            dd[f"dd_{c}_imp_p99"] = float(torch.quantile(v_, 0.99))
    tar = {}
    for far in (1e-2, 1e-3):
        thr = torch.quantile(imp[torch.randperm(len(imp), generator=torch.Generator().manual_seed(0))[:200000]], 1 - far)
        tar[f"tar_far{far:.0e}"] = float((genuine >= thr).float().mean())
    tags = data.deg_tags[js]
    per = {c: float(genuine[torch.from_numpy(np.char.startswith(tags.astype(str), c))].mean()) for c in ("good", "typical", "dim", "backlit", "sidelit")}
    return {
        "genuine_mean": float(genuine.mean()),
        "genuine_p05": float(torch.quantile(genuine, 0.05)),
        "rank1": rank1,
        "impostor_mean": float(imp.mean()),
        "impostor_p99": float(torch.quantile(imp, 0.99)),
        "clean_compat_mean": float(compat.mean()),
        "clean_compat_min": float(compat.min()),
        "per_condition_genuine": per,
        **tar,
        **dd,
        "n": len(js),
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--method", choices=["A", "B"], required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--data", default=str(WORK / "train" / "dataset.npz"))
    ap.add_argument("--train-upto", default="conv_7")
    ap.add_argument("--steps", type=int, default=1500)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--clean-batch", type=int, default=16)
    ap.add_argument("--lr", type=float, default=None)
    ap.add_argument("--w-clean", type=float, default=1.0)
    ap.add_argument("--w-rel", type=float, default=5.0)
    ap.add_argument("--w-pix", type=float, default=0.1)
    ap.add_argument("--w-nce", type=float, default=0.0, help="InfoNCE of s(deg) against the teacher's clean embeddings of all training portraits")
    ap.add_argument("--tau", type=float, default=0.07)
    ap.add_argument("--w-dd", type=float, default=0.0, help="relational loss between DEGRADED student embeddings: <s(deg_i), s(deg_j)> ~ <t_i, t_j> (matched degradation)")
    ap.add_argument("--w-mean", type=float, default=0.0, help="first-moment penalty: mean impostor similarity (deg-vs-clean and deg-vs-deg) = teacher's clean-clean mean")
    ap.add_argument("--p-homog", type=float, default=0.0, help="probability that a batch's degraded crops all share one condition")
    ap.add_argument("--init", default=None, help="start from this checkpoint (state_dict of the same method)")
    ap.add_argument("--dd-penalty", type=float, default=0.0, help="early-stopping penalty per unit of matched-degradation impostor p99 above the start model")
    ap.add_argument("--p-crop-aug", type=float, default=0.25, help="fraction of the degraded batch replaced by crop-level degradations of clean crops")
    ap.add_argument("--val-every", type=int, default=100)
    ap.add_argument("--patience", type=int, default=5)
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--enh-c1", type=int, default=16)
    ap.add_argument("--enh-c2", type=int, default=32)
    ap.add_argument("--enh-blocks", type=int, default=2)
    args = ap.parse_args()
    torch.set_num_threads(args.threads)
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    g = torch.Generator().manual_seed(args.seed)
    out = WORK / "runs" / args.name
    out.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    data = Data(Path(args.data))
    print(f"data: {len(data.clean)} portraits ({len(data.train_src)} train / {len(data.val_src)} val), {len(data.deg)} degraded crops; teacher targets in {time.time() - t0:.0f}s", flush=True)
    model, params = build_student(args.method, args.train_upto, args.enh_c1, args.enh_c2, args.enh_blocks)
    if args.init:
        model.load_state_dict(torch.load(args.init))
        print(f"initialised from {args.init}", flush=True)
    lr = args.lr if args.lr is not None else (5e-5 if args.method == "A" else 1e-3)
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=0.0)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1.0, (s + 1) / 50) * 0.5 * (1 + math.cos(math.pi * min(1.0, s / args.steps))))
    print(f"method {args.method}: {sum(p.numel() for p in params):,} trainable parameters, lr {lr}", flush=True)
    base_val = validate(model, data)
    print("step 0 val", json.dumps(base_val), flush=True)
    history = [{"step": 0, **base_val}]
    # early-stopping score: verification-relevant (TAR at low FAR on validation portraits), with a penalty when the
    # student drifts from the teacher on clean input (compatibility with existing templates)
    score = lambda v: v["tar_far1e-03"] + 0.5 * v["tar_far1e-02"] + 0.25 * v["genuine_mean"] - max(0.0, 0.985 - v["clean_compat_mean"]) * 10  # noqa: E731
    bank = data.t[torch.from_numpy(data.train_src.astype(np.int64))].reshape(-1, 128)  # (2 * n_train, 128) fixed prototypes
    bank_pos = {int(s_): k for k, s_ in enumerate(data.train_src)}
    ref_val = base_val
    if args.init:  # matched-degradation reference = the ORIGINAL SFace, not the checkpoint we start from
        ref_val = validate(build_student("A", "conv_1")[0], data)
        print("teacher val", json.dumps(ref_val), flush=True)
    dd0 = max(ref_val.get("dd_dim_imp_p99", 0.0), ref_val.get("dd_backlit_imp_p99", 0.0))
    if args.dd_penalty:
        _score0 = score
        score = lambda v: _score0(v) - args.dd_penalty * max(0.0, max(v.get("dd_dim_imp_p99", 0.0), v.get("dd_backlit_imp_p99", 0.0)) - dd0)  # noqa: E731
    best = score(base_val)
    best_step, bad = 0, 0
    torch.save({k: v for k, v in model.state_dict().items()}, out / "best.pt")
    for step in range(1, args.steps + 1):
        model.eval()  # BN statistics frozen (eval mode) for every method
        cond = None
        if args.p_homog and rng.random() < args.p_homog:
            cond = str(rng.choice(["dim", "backlit", "typical", "sidelit", "good"], p=[0.35, 0.35, 0.1, 0.1, 0.1]))
        deg, t, srcs, fl = data.batch(rng, args.batch, cond)
        if cond is not None:
            n_aug_override = 0
        else:
            n_aug_override = None
        n_aug = int(round(args.p_crop_aug * args.batch)) if n_aug_override is None else n_aug_override
        if n_aug:
            cl = data.clean_t[srcs[:n_aug], fl[:n_aug]]
            deg[:n_aug] = crop_degrade(cl, g)
        cb = args.clean_batch
        ci = srcs[:cb]
        clean = data.clean_t[ci, fl[:cb]]
        x = torch.cat([deg, clean])
        if args.method == "B":
            enhanced = model.enhancer(x)
            e = model.sface(enhanced)
        else:
            e = model(x)
        e = F.normalize(e, dim=1)
        sd, sc = e[: args.batch], e[args.batch :]
        tc = t[:cb]
        l_cos = (1 - (sd * t).sum(1)).mean()
        l_clean = (1 - (sc * tc).sum(1)).mean()
        l_rel = rel_loss(sd, t) + rel_loss(sc, tc)
        loss = l_cos + args.w_clean * l_clean + args.w_rel * l_rel
        if args.w_dd or args.w_mean:
            off = ~torch.eye(len(t), dtype=torch.bool)
            gt = (t @ t.T)[off]
            gdd = (sd @ sd.T)[off]
            if args.w_dd:
                loss = loss + args.w_dd * ((gdd - gt) ** 2).mean()
            if args.w_mean:
                gdt = (sd @ t.T)[off]
                loss = loss + args.w_mean * ((gdt.mean() - gt.mean()) ** 2 + (gdd.mean() - gt.mean()) ** 2)
        if args.w_nce:
            target = torch.tensor([2 * bank_pos[int(s_)] for s_ in srcs]) + fl
            l_nce = F.cross_entropy(sd @ bank.T / args.tau, target)
            loss = loss + args.w_nce * l_nce
        if args.method == "B" and args.w_pix:
            l_pix = (enhanced[args.batch :] - clean).abs().mean() / 255
            loss = loss + args.w_pix * l_pix
        opt.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(params, 5.0)
        opt.step()
        sched.step()
        if step % 20 == 0:
            print(f"step {step} loss {loss.item():.4f} cos {l_cos.item():.4f} clean {l_clean.item():.4f} rel {l_rel.item():.5f} ({(time.time() - t0) / 60:.1f} min)", flush=True)
        if step % args.val_every == 0 or step == args.steps:
            v = validate(model, data)
            history.append({"step": step, **v})
            sc_ = score(v)
            print(f"step {step} val {json.dumps(v)} score {sc_:.4f} (best {best:.4f} @ {best_step})", flush=True)
            torch.save(model.state_dict(), out / "last.pt")
            if sc_ > best:
                best, best_step, bad = sc_, step, 0
                torch.save(model.state_dict(), out / "best.pt")
            else:
                bad += 1
                if bad >= args.patience:
                    print("early stop", flush=True)
                    break
            write_json(out / "history.json", {"args": vars(args), "best_step": best_step, "history": history})
    write_json(out / "history.json", {"args": vars(args), "best_step": best_step, "history": history})
    print(f"done: best step {best_step} score {best:.4f}; {(time.time() - t0) / 60:.1f} min", flush=True)


if __name__ == "__main__":
    main()
