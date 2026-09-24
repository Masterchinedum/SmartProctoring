"""
Laptop-webcam degradation model for TRAINING (Python / OpenCV / PIL).

An independent re-implementation of the capture model in apps/server/src/eval/webcam-sim.ts, with the same
condition ranges (CONDITION_PARAMS below is a copy; keep them in sync), so that training and evaluation share the
physics but not the code: evaluation frames are rendered by the TypeScript simulator (sharp/libvips resampling,
JPEG encoder and noise generator), training frames by this one (PIL/OpenCV). A model that only learned the quirks
of one implementation would not transfer to the other.

Per sample (`render_frame`), in this order, as a real camera would:
  scene      the subject's head + shoulders cut from the source photo with a feathered ellipse mask, scaled to an
             inter-eye distance of 35-90 px at 720p (x 2/3 at 640x480), rolled +/-3 deg, placed in a synthetic room
             (wall with vertical gradient and texture, desk, optional bright WINDOW for backlight)
  light      side-lighting ramp across the face (linear light), exposure to the target face luma
  ISP        tone curve (gamma variation), colour-temperature gains, flare lift, contrast loss about the face mean
  optics     Gaussian PSF + linear motion blur
  sensor     luma noise (per pixel) + low-frequency chroma noise, then a mild noise-reduction blur
  codec      JPEG 4:2:0 at the sampled quality
Training-only extensions (probabilities in `sample_params(extra=True)`): ranges widened by up to +/-35 % beyond
the simulator's, a low-resolution sensor (downscale x0.3-0.6 then bilinear upscale), and heavy JPEG (q 25-60).

Only a window around the face is rendered (the rest of the frame does not affect the aligned crop); the detector is
then run on that window at the scale production would use for the full frame (640 / frame width), and the face is
aligned from the window at native resolution, exactly like the server does for a 640x480 / 1280x720 frame.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

import cv2
import numpy as np

from common import jpeg_roundtrip, resize_rgb

CONDITIONS = ("good", "typical", "dim", "backlit", "sidelit")
RESOLUTIONS = ((640, 480), (1280, 720))
INTER_EYE_720 = (35.0, 90.0)

# Copied from apps/server/src/eval/webcam-sim.ts CONDITION_PARAMS (SIM_VERSION 3).
CONDITION_PARAMS = {
    "good": dict(faceLuma=(115, 165), lumaNoise=(1.5, 3), chromaNoise=(1, 2), contrast=(0.95, 1.05), lift=(0, 4), gamma=(0.95, 1.05),
                 blur=(0.5, 0.9), motion=(0, 1), nr=(0, 0.4), red=(0.96, 1.04), blue=(0.96, 1.04), jpeg=(85, 92), sideRatio=(1, 1), window=(0, 0)),
    "typical": dict(faceLuma=(85, 130), lumaNoise=(3, 6), chromaNoise=(2, 4), contrast=(0.8, 0.95), lift=(4, 10), gamma=(0.9, 1.1),
                    blur=(0.7, 1.3), motion=(0, 2), nr=(0.3, 0.6), red=(1.03, 1.12), blue=(0.88, 0.97), jpeg=(75, 90), sideRatio=(0.7, 1), window=(0, 0)),
    "dim": dict(faceLuma=(35, 75), lumaNoise=(6, 12), chromaNoise=(4, 8), contrast=(0.6, 0.8), lift=(8, 18), gamma=(0.9, 1.2),
                blur=(1, 1.8), motion=(0.5, 3), nr=(0.5, 0.9), red=(1.1, 1.25), blue=(0.75, 0.9), jpeg=(70, 85), sideRatio=(0.6, 1), window=(0, 0)),
    "backlit": dict(faceLuma=(40, 85), lumaNoise=(4, 8), chromaNoise=(2, 5), contrast=(0.6, 0.8), lift=(15, 35), gamma=(0.9, 1.1),
                    blur=(0.8, 1.3), motion=(0, 1.5), nr=(0.4, 0.7), red=(0.9, 1.0), blue=(1.0, 1.1), jpeg=(75, 90), sideRatio=(0.8, 1), window=(4, 8)),
    "sidelit": dict(faceLuma=(70, 130), lumaNoise=(3, 7), chromaNoise=(2, 4), contrast=(0.85, 1.0), lift=(2, 8), gamma=(0.9, 1.1),
                    blur=(0.7, 1.2), motion=(0, 1.5), nr=(0.3, 0.6), red=(1.0, 1.12), blue=(0.88, 1.0), jpeg=(75, 90), sideRatio=(0.12, 0.35), window=(0, 0)),
}
#: Hard limits when ranges are widened for training.
LIMITS = dict(faceLuma=(22, 200), lumaNoise=(0.5, 18), chromaNoise=(0, 12), contrast=(0.45, 1.1), lift=(0, 45), gamma=(0.8, 1.35),
              blur=(0.3, 2.4), motion=(0, 4.5), nr=(0, 1.2), red=(0.85, 1.35), blue=(0.65, 1.15), jpeg=(55, 95), sideRatio=(0.08, 1), window=(0, 10))

_TO_LIN = ((np.arange(256) / 255.0) ** 2.2).astype(np.float32)


@dataclass
class Params:
    condition: str
    W: int
    H: int
    ie720: float
    faceLuma: float
    lumaNoise: float
    chromaNoise: float
    contrast: float
    lift: float
    gamma: float
    blur: float
    motion: float
    motionAngle: float
    nr: float
    red: float
    blue: float
    jpeg: int
    sideRatio: float
    sideDir: int
    window: float
    cxf: float
    cyf: float
    roll: float
    wall: float
    wallTint: tuple
    windowX: float
    lowres: float = 1.0  # < 1: downscale factor of a low-resolution sensor (then bilinear upscale)
    extra_jpeg: int = 0  # > 0: re-encode at this (low) quality
    tags: list = field(default_factory=list)


def sample_params(rng: np.random.Generator, condition: str | None = None, extra: bool = False) -> Params:
    """Scene parameters. With extra=True (training) ranges may be widened and low-res / heavy-JPEG added."""
    if condition is None:
        condition = str(rng.choice(CONDITIONS, p=[0.2, 0.25, 0.22, 0.17, 0.16]))
    cond = CONDITION_PARAMS[condition]
    W, H = RESOLUTIONS[int(rng.integers(0, 2))]
    widen = float(rng.uniform(0, 0.35)) if (extra and rng.random() < 0.35) else 0.0
    tags = [condition] + (["widened"] if widen else [])

    def u(name):
        lo, hi = cond[name]
        span = hi - lo
        lo2, hi2 = lo - widen * max(span, 0.1 * abs(lo) if name not in ("sideRatio", "window") else 0), hi + widen * max(span, 0.1 * abs(hi))
        if name in ("sideRatio",) and hi == 1:
            hi2 = 1
        if name == "window" and hi == 0:
            lo2 = hi2 = 0
        L = LIMITS[name]
        return float(np.clip(rng.uniform(lo2, hi2), L[0], L[1]))

    res_scale = H / 720
    p = Params(
        condition=condition, W=W, H=H, ie720=float(rng.uniform(*INTER_EYE_720)),
        faceLuma=u("faceLuma"), lumaNoise=u("lumaNoise"), chromaNoise=u("chromaNoise"), contrast=u("contrast"), lift=u("lift"),
        gamma=u("gamma"), blur=u("blur") * res_scale, motion=u("motion") * res_scale, motionAngle=float(rng.uniform(0, math.pi)),
        nr=u("nr"), red=u("red"), blue=u("blue"), jpeg=int(round(u("jpeg"))), sideRatio=u("sideRatio"), sideDir=-1 if rng.random() < 0.5 else 1,
        window=u("window"), cxf=float(0.5 + (rng.random() - 0.5) * 0.16), cyf=float(0.4 + (rng.random() - 0.5) * 0.12),
        roll=float((rng.random() - 0.5) * 6), wall=float(100 + rng.random() * 90),
        wallTint=(float(0.9 + rng.random() * 0.2), 1.0, float(0.85 + rng.random() * 0.25)), windowX=0.0 if rng.random() < 0.5 else 0.45, tags=tags,
    )
    if extra and rng.random() < 0.2:
        p.lowres = float(rng.uniform(0.3, 0.6))
        p.tags.append("lowres")
    if extra and rng.random() < 0.15:
        p.extra_jpeg = int(rng.integers(25, 61))
        p.tags.append("heavy_jpeg")
    return p


def _motion_kernel(length: float, angle: float) -> np.ndarray:
    ln = max(2, int(round(length)))
    size = ln + 1 if ln % 2 == 0 else ln
    k = np.zeros((size, size), np.float32)
    c = (size - 1) / 2
    for t in range(4 * size):
        r = (t / (4 * size - 1) - 0.5) * (ln - 1)
        k[int(round(c + r * math.sin(angle))), int(round(c + r * math.cos(angle)))] += 1
    return k / k.sum()


def render_frame(src: np.ndarray, landmarks: np.ndarray, p: Params, rng: np.random.Generator):
    """Render the window of a simulated webcam frame around the face.

    src: RGB uint8 source photo; landmarks: (5, 2) YuNet landmarks in src.
    Returns (window RGB uint8 after JPEG, det_scale, true landmarks in window coordinates)."""
    W, H = p.W, p.H
    res_scale = H / 720
    ieT = p.ie720 * res_scale
    le, re = landmarks[0], landmarks[1]
    ieS = float(np.hypot(*(re - le)))
    # Pre-downscale large sources so the warp never decimates by more than ~1.5x (as the TS simulator does).
    ds = min(1.0, 1.5 * ieT / ieS)
    if ds < 1:
        w0 = src.shape[1]
        src = resize_rgb(src, max(1, round(src.shape[1] * ds)), max(1, round(src.shape[0] * ds)))
        ds = src.shape[1] / w0
    lm = landmarks * ds
    sh, sw = src.shape[:2]
    eye_mid = (lm[0] + lm[1]) / 2
    ieD = ieS * ds
    roll_src = math.atan2(lm[1, 1] - lm[0, 1], lm[1, 0] - lm[0, 0])
    k = ieT / ieD
    theta = roll_src - p.roll * math.pi / 180
    cosT, sinT = math.cos(theta) / k, math.sin(theta) / k
    ox, oy = W * p.cxf, H * p.cyf
    # Window: the face and enough context for detection (clipped to the frame).
    half = 3.6 * ieT
    x0, x1 = int(max(0, math.floor(ox - half))), int(min(W, math.ceil(ox + half)))
    y0, y1 = int(max(0, math.floor(oy - 0.8 * half))), int(min(H, math.ceil(oy + 1.3 * half)))
    ww, wh = x1 - x0, y1 - y0
    yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float32)
    dx, dy = xx - ox, yy - oy
    sx = (eye_mid[0] + cosT * dx - sinT * dy).astype(np.float32)
    sy = (eye_mid[1] + sinT * dx + cosT * dy).astype(np.float32)

    # Background (linear radiance relative to the face = 1).
    wall_lin = (p.wall / 255) ** 2.2 * 1.4
    vgrad = 0.8 + 0.4 * (1 - yy / H)
    bg = wall_lin * vgrad * (0.9 + 0.2 * np.sin((xx / W) * 5.3 + p.wallTint[0] * 7) * np.cos((yy / H) * 3.1))
    bg = np.where(yy > H * 0.82, bg * 0.45, bg)
    if p.window > 0:
        wx0 = p.windowX * W
        bg = np.where((xx >= wx0) & (xx < wx0 + 0.55 * W) & (yy < H * 0.75), p.window, bg)
    lin = np.stack([bg * p.wallTint[0], bg * p.wallTint[1], bg * p.wallTint[2]], -1).astype(np.float32)

    # Person: feathered head ellipse + neck/shoulders in the source face frame.
    cr, sr = math.cos(roll_src), math.sin(roll_src)
    fu = (sx - eye_mid[0]) * cr + (sy - eye_mid[1]) * sr
    fv = -(sx - eye_mid[0]) * sr + (sy - eye_mid[1]) * cr
    headA, headB, headCy = 1.25 * ieD, 1.75 * ieD, 0.55 * ieD
    neckHalf, neckTop, neckBottom, feather = 1.9 * ieD, 1.6 * ieD, 3.6 * ieD, 0.35 * ieD
    er = np.hypot(fu / headA, (fv - headCy) / headB)
    m = np.where(er <= 1, 1.0, np.maximum(0, 1 - (er - 1) * headA / feather))
    neck = (fv > neckTop) & (fv < neckBottom + feather)
    mx = np.clip((neckHalf - np.abs(fu)) / feather, 0, 1)
    my = np.clip((neckBottom + feather - fv) / feather, 0, 1)
    m = np.where(neck, np.maximum(m, np.minimum(mx, my)), m)
    edge = np.minimum(np.minimum(sx, sy), np.minimum(sw - 1 - sx, sh - 1 - sy))
    m = np.where(edge < 3, m * np.clip(edge / 3, 0, 1), m)
    m = np.where((sx < 0) | (sy < 0) | (sx > sw - 1) | (sy > sh - 1), 0, m).astype(np.float32)
    src_lin = _TO_LIN[src]
    person = cv2.remap(src_lin, sx, sy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    lin = lin * (1 - m[..., None]) + person * m[..., None]

    # Side light ramp.
    if p.sideRatio < 0.999:
        t = np.clip(0.5 + p.sideDir * (xx - ox) / (2.2 * ieT), 0, 1)
        f = p.sideRatio + (1 - p.sideRatio) * t * t * (3 - 2 * t)
        lin *= f[..., None]

    # Exposure on the inner face ellipse.
    target = max(4.0, (p.faceLuma - p.lift) * 255 / (255 - p.lift))
    gamma_enc = (1 / 2.2) * p.gamma
    fcy = oy + 0.55 * ieT
    fm = ((xx - ox) / (0.9 * ieT)) ** 2 + ((yy - fcy) / (1.2 * ieT)) ** 2 <= 1
    face_lin = float((0.299 * lin[..., 0] * p.red + 0.587 * lin[..., 1] + 0.114 * lin[..., 2] * p.blue)[fm].mean()) if fm.any() else 0.2
    k_exp = (target / 255) ** (1 / gamma_enc) / max(1e-6, face_lin)
    gains = np.array([p.red, 1.0, p.blue], np.float32)
    v = 255 * np.power(np.minimum(1.0, lin * k_exp * gains), gamma_enc)
    lifted = p.lift + v * ((255 - p.lift) / 255)
    enc = p.faceLuma + (lifted - p.faceLuma) * p.contrast
    img = np.clip(np.rint(enc), 0, 255).astype(np.uint8)

    # Optics.
    if p.blur >= 0.3:
        img = cv2.GaussianBlur(img, (0, 0), p.blur, borderType=cv2.BORDER_REFLECT)
    if p.motion >= 1:
        img = cv2.filter2D(img, -1, _motion_kernel(p.motion, p.motionAngle), borderType=cv2.BORDER_REFLECT)
    if p.lowres < 1:
        small = cv2.resize(img, (max(8, round(ww * p.lowres)), max(8, round(wh * p.lowres))), interpolation=cv2.INTER_AREA)
    else:
        small = img
    # Sensor noise (at the sensor's resolution) + chroma blotches (1/4 resolution, bilinear).
    shh, sww = small.shape[:2]
    cw, ch = sww // 4 + 2, shh // 4 + 2
    chroma = rng.normal(0, p.chromaNoise, (ch, cw, 2)).astype(np.float32)
    chroma = cv2.resize(chroma, (cw * 4, ch * 4), interpolation=cv2.INTER_LINEAR)[:shh, :sww]
    f = small.astype(np.float32)
    nl = rng.normal(0, p.lumaNoise, (shh, sww)).astype(np.float32) * np.where(f[..., 1] > 240, 0.3, 1.0)
    f[..., 0] += nl + chroma[..., 0]
    f[..., 1] += nl - 0.3 * (chroma[..., 0] + chroma[..., 1])
    f[..., 2] += nl + chroma[..., 1]
    small = np.clip(np.rint(f), 0, 255).astype(np.uint8)
    if p.nr >= 0.3:
        small = cv2.GaussianBlur(small, (0, 0), p.nr, borderType=cv2.BORDER_REFLECT)
    img = cv2.resize(small, (ww, wh), interpolation=cv2.INTER_LINEAR) if p.lowres < 1 else small
    img = jpeg_roundtrip(img, p.jpeg)
    if p.extra_jpeg:
        img = jpeg_roundtrip(img, p.extra_jpeg)

    # True landmarks in window coordinates (forward map of the source landmarks).
    rel = lm - eye_mid
    fx_ = (math.cos(-theta) * rel[:, 0] - math.sin(-theta) * rel[:, 1]) * k
    fy_ = (math.sin(-theta) * rel[:, 0] + math.cos(-theta) * rel[:, 1]) * k
    true_lm = np.stack([fx_ + ox - x0, fy_ + oy - y0], 1)
    return img, 640.0 / max(W, H), true_lm


def degrade_crop_numpy(crop: np.ndarray, rng: np.random.Generator) -> np.ndarray:
    """Cheap CROP-LEVEL degradation of an aligned 112x112 RGB crop (float/uint8), used as extra augmentation."""
    x = crop.astype(np.float32) / 255.0
    lin = x**2.2 * rng.uniform(0.15, 1.2) * np.array([rng.uniform(0.9, 1.25), 1, rng.uniform(0.7, 1.1)], np.float32)
    x = np.clip(lin, 0, 1) ** (1 / 2.2 * rng.uniform(0.85, 1.2))
    lift = rng.uniform(0, 30) / 255
    x = lift + x * (1 - lift)
    mean = x.mean()
    x = mean + (x - mean) * rng.uniform(0.6, 1.0)
    img = np.clip(x * 255, 0, 255).astype(np.uint8)
    s = rng.uniform(0.3, 1.6)
    img = cv2.GaussianBlur(img, (0, 0), s)
    f = img.astype(np.float32) + rng.normal(0, rng.uniform(1, 10), img.shape[:2])[..., None]
    img = np.clip(np.rint(f), 0, 255).astype(np.uint8)
    return jpeg_roundtrip(img, int(rng.integers(40, 92)))
