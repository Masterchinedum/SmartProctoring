"""
Python port of apps/server/src/vision/embed-prep.ts (the vision agent's NON-LEARNED baselines), so the learned
recogniser can be evaluated with and without them:

  normalize 'none' | 'stretch' | 'gamma' | 'clahe'   illumination normalisation of the aligned crop
  flip                                               test-time augmentation: embed the mirrored crop too and use
                                                     normalize(sum of the unit embeddings)

Crops are HxWx3 float32 RGB 0..255 with a `valid` mask (align_face(..., with_valid=True)).
Keep in sync with embed-prep.ts (constants: inner region 24..88 x 36..104, stretch to 16..240, gain <= 4, gamma
target median 118 in [0.45, 2.2], CLAHE 4x4 tiles / 64 bins / clip 2.5 / gain <= 6).
"""
from __future__ import annotations

import numpy as np

R_X0, R_X1, R_Y0, R_Y1 = 24, 88, 36, 104


def _luma(x: np.ndarray) -> np.ndarray:
    return 0.299 * x[..., 0] + 0.587 * x[..., 1] + 0.114 * x[..., 2]


def _region(x: np.ndarray, valid: np.ndarray):
    r = x[R_Y0:R_Y1, R_X0:R_X1]
    v = valid[R_Y0:R_Y1, R_X0:R_X1]
    px = r[v]
    if len(px) == 0:
        return np.zeros(0, np.float32), np.zeros(3)
    return np.sort(_luma(px).astype(np.float32)), px.mean(0)


def _pct(s: np.ndarray, q: float) -> float:
    if len(s) == 0:
        return 0.0
    return float(s[min(len(s) - 1, max(0, int(round(q * (len(s) - 1)))))])


def stretch(x: np.ndarray, valid: np.ndarray, with_gamma: bool) -> np.ndarray:
    _, mean = _region(x, valid)
    grey = mean.mean()
    gains = np.array([min(1.33, max(0.75, grey / m)) if m > 1 else 1.0 for m in mean], np.float32)
    out = np.minimum(255, x * gains)
    if with_gamma:
        lum, _ = _region(out, valid)
        med = _pct(lum, 0.5)
        g = 1.0
        if 2 < med < 253:
            g = min(2.2, max(0.45, np.log(118 / 255) / np.log(med / 255)))
        if abs(g - 1) > 1e-3:
            out = 255 * np.power(out / 255, g)
    lum, _ = _region(out, valid)
    lo, hi = _pct(lum, 0.01), _pct(lum, 0.99)
    span = hi - lo
    if span < 4:
        return out.astype(np.float32)
    a = min(4.0, max(1.0, (240 - 16) / span))
    mid = (lo + hi) / 2
    return np.clip(128 + (out - mid) * a, 0, 255).astype(np.float32)


def clahe(x: np.ndarray, tiles: int = 4, clip: float = 2.5) -> np.ndarray:
    size = x.shape[0]
    lum = _luma(x)
    bins = 64
    ts = size / tiles
    maps = []
    for ty in range(tiles):
        for tx in range(tiles):
            t = lum[int(np.floor(ty * ts)) : int(np.floor((ty + 1) * ts)), int(np.floor(tx * ts)) : int(np.floor((tx + 1) * ts))]
            idx = np.minimum(bins - 1, np.floor(t / 256 * bins).astype(int)).ravel()
            hist = np.bincount(idx, minlength=bins).astype(np.float64)
            n = idx.size
            limit = max(1.0, clip * n / bins)
            excess = np.maximum(0, hist - limit).sum()
            hist = np.minimum(hist, limit) + excess / bins
            maps.append(np.cumsum(hist) / max(1, n) * 255)
    maps = np.array(maps)
    g = np.clip((np.arange(size) + 0.5) / ts - 0.5, 0, tiles - 1)
    i0 = np.floor(g).astype(int)
    i1 = np.minimum(tiles - 1, i0 + 1)
    f = g - i0
    b = np.minimum(bins - 1, np.floor(lum / 256 * bins).astype(int))
    y0, y1, fy = i0[:, None], i1[:, None], f[:, None]
    x0, x1, fx = i0[None, :], i1[None, :], f[None, :]
    v = (1 - fy) * ((1 - fx) * maps[y0 * tiles + x0, b] + fx * maps[y0 * tiles + x1, b]) + fy * (
        (1 - fx) * maps[y1 * tiles + x0, b] + fx * maps[y1 * tiles + x1, b]
    )
    gain = np.where(lum > 1, np.minimum(6, v / np.maximum(lum, 1e-6)), 1.0)
    return np.minimum(255, x * gain[..., None]).astype(np.float32)


def normalized(x: np.ndarray, valid: np.ndarray, mode: str) -> np.ndarray:
    if mode == "none":
        return x
    if mode == "stretch":
        return stretch(x, valid, False)
    if mode == "gamma":
        return stretch(x, valid, True)
    if mode == "clahe":
        return clahe(x)
    raise ValueError(mode)


def views(x: np.ndarray, valid: np.ndarray, mode: str, flip: bool) -> list[np.ndarray]:
    base = normalized(x, valid, mode)
    return [base, base[:, ::-1]] if flip else [base]
