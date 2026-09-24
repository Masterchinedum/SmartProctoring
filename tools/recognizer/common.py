"""
Shared code for the recogniser tooling (tools/recognizer).

Everything here mirrors the production TypeScript pipeline in apps/server/src/vision so that crops and
embeddings produced in Python are the ones the server would produce:

  * image decode: EXIF orientation, RGB 8-bit, max side 1280 (image.ts `decodeImage`; sharp's default
    Lanczos-3 resampling ~ PIL LANCZOS)
  * YuNet 2023mar: longer side resized to 640, letterboxed into the TOP-LEFT of 640x640 (zero pad), BGR planar
    float 0..255, anchor-free decode, score sqrt(cls*obj) >= 0.6, greedy NMS IoU 0.3, faces ranked by
    area x score (detect.ts)
  * alignment: least-squares similarity (no reflection) onto the ArcFace 112x112 template, inverse bilinear
    sampling with a zero border (align.ts); small faces in downscaled images are re-sampled from the
    full-resolution original (engine.ts `alignPrimary`)
  * SFace: planar RGB float 0..255 in, 128-d out, L2-normalised by the caller.

`sface_torch()` re-implements the SFace network (MobileNetV1-style, 9.67 M parameters) in PyTorch and loads
its weights from the Apache-2.0 ONNX file, so it can be fine-tuned and re-exported with the same I/O.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from PIL import Image, ImageOps

REPO = Path(__file__).resolve().parents[2]
MODELS_DIR = REPO / "apps" / "server" / "models"
SFACE_ONNX = MODELS_DIR / "face_recognition_sface_2021dec.onnx"
YUNET_ONNX = MODELS_DIR / "face_detection_yunet_2023mar.onnx"

#: Working directory for downloaded images, crops, checkpoints and reports (never committed).
WORK = Path(os.environ.get("RECOG_WORK", "/tmp/claude-0/recognizer"))
#: Evaluation image cache shared with apps/server/src/eval/datasets.ts.
FACESETS = Path(os.environ.get("SP_FACESETS_DIR", "/tmp/claude-0/facesets"))

ALIGNED_SIZE = 112
ARCFACE_TEMPLATE_112 = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float64,
)
DEFAULT_MAX_DECODE_SIDE = 1280
MIN_ALIGN_INTER_EYE = 40
MAX_ALIGN_INTER_EYE = 120


def sha256_file(path: Path | str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path | str, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, default=float))


# ----------------------------------------------------------------------------------------------- images


def load_rgb(src: Path | str | bytes) -> np.ndarray:
    """Decode to an oriented RGB uint8 array (EXIF orientation applied, alpha dropped, full resolution)."""
    im = Image.open(io.BytesIO(src) if isinstance(src, (bytes, bytearray)) else src)
    im = ImageOps.exif_transpose(im)
    if im.mode != "RGB":
        im = im.convert("RGB")
    return np.asarray(im, dtype=np.uint8).copy()


def resize_rgb(rgb: np.ndarray, width: int, height: int) -> np.ndarray:
    """Lanczos resize (sharp's default kernel), uint8 in/out."""
    if rgb.shape[1] == width and rgb.shape[0] == height:
        return rgb
    return np.asarray(Image.fromarray(rgb).resize((int(width), int(height)), Image.LANCZOS), dtype=np.uint8)


def encode_jpeg(rgb: np.ndarray, quality: int, subsampling: int = 2) -> bytes:
    """JPEG encode (subsampling 2 = 4:2:0, like browsers / sharp defaults)."""
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=int(quality), subsampling=subsampling)
    return buf.getvalue()


def jpeg_roundtrip(rgb: np.ndarray, quality: int) -> np.ndarray:
    return load_rgb(encode_jpeg(rgb, quality))


@dataclass
class Decoded:
    rgb: np.ndarray  # working image (max side <= max_side)
    full: np.ndarray  # full-resolution oriented image
    scale: float  # working / original


def decode_image(src: Path | str | bytes | np.ndarray, max_side: int = DEFAULT_MAX_DECODE_SIDE) -> Decoded:
    full = src if isinstance(src, np.ndarray) else load_rgb(src)
    h, w = full.shape[:2]
    s = min(1.0, max_side / max(w, h))
    if s < 1:
        rgb = resize_rgb(full, max(1, round(w * s)), max(1, round(h * s)))
    else:
        rgb = full
    return Decoded(rgb=rgb, full=full, scale=rgb.shape[1] / w)


# ------------------------------------------------------------------------------------------------ YuNet


@dataclass
class Face:
    box: tuple[float, float, float, float]  # x, y, w, h (original-image coordinates)
    score: float
    landmarks: np.ndarray  # (5, 2): right-eye-in-image-left, other eye, nose, mouth L, mouth R

    @property
    def inter_eye(self) -> float:
        return float(np.hypot(*(self.landmarks[1] - self.landmarks[0])))


def _ort_session(path: Path | str, threads: int = 1):
    import onnxruntime as ort

    so = ort.SessionOptions()
    so.intra_op_num_threads = max(1, int(threads))
    so.inter_op_num_threads = 1
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    so.log_severity_level = 3
    so.add_session_config_entry("session.intra_op.allow_spinning", "0")
    return ort.InferenceSession(str(path), sess_options=so, providers=["CPUExecutionProvider"])


def _iou(a, b) -> float:
    x1, y1 = max(a[0], b[0]), max(a[1], b[1])
    x2, y2 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = a[2] * a[3] + b[2] * b[3] - inter
    return inter / union if union > 0 else 0.0


class YuNet:
    """Port of apps/server/src/vision/detect.ts on onnxruntime (same letterbox / decode / NMS / ranking)."""

    SIZE = 640
    STRIDES = (8, 16, 32)

    def __init__(self, path: Path | str = YUNET_ONNX, threads: int = 1, threshold: float = 0.6, nms_iou: float = 0.3):
        self.sess = _ort_session(path, threads)
        self.input = self.sess.get_inputs()[0].name
        self.threshold = threshold
        self.nms_iou = nms_iou

    def detect(self, img: np.ndarray, orig_size: tuple[int, int] | None = None, scale: float | None = None) -> list[Face]:
        """Detect in `img` (RGB uint8). Coordinates are returned in `orig_size` (w, h) space if given.

        `scale` overrides the letterbox scale (used to detect in a window cut from a larger frame at the scale
        the full frame would have been resized with)."""
        h, w = img.shape[:2]
        ow, oh = orig_size or (w, h)
        s = scale if scale is not None else self.SIZE / max(w, h)
        nw, nh = max(1, min(self.SIZE, round(w * s))), max(1, min(self.SIZE, round(h * s)))
        det = resize_rgb(img, nw, nh) if (nw != w or nh != h) else img
        t = np.zeros((1, 3, self.SIZE, self.SIZE), np.float32)
        t[0, :, :nh, :nw] = det[:, :, ::-1].transpose(2, 0, 1)  # BGR planar
        names = [o.name for o in self.sess.get_outputs()]
        out = dict(zip(names, self.sess.run(None, {self.input: t})))
        dets = []
        for st in self.STRIDES:
            cols = rows = self.SIZE // st
            cls = out[f"cls_{st}"].reshape(-1)
            obj = out[f"obj_{st}"].reshape(-1)
            bbox = out[f"bbox_{st}"].reshape(-1, 4)
            kps = out[f"kps_{st}"].reshape(-1, 10)
            score = np.sqrt(np.clip(cls, 0, 1) * np.clip(obj, 0, 1))
            for i in np.nonzero(score >= self.threshold)[0]:
                r, c = divmod(int(i), cols)
                cx, cy = (c + bbox[i, 0]) * st, (r + bbox[i, 1]) * st
                bw, bh = np.exp(bbox[i, 2]) * st, np.exp(bbox[i, 3]) * st
                k = np.empty((5, 2), np.float64)
                k[:, 0] = (kps[i, 0::2] + c) * st
                k[:, 1] = (kps[i, 1::2] + r) * st
                dets.append(((cx - bw / 2, cy - bh / 2, bw, bh), float(score[i]), k))
        dets.sort(key=lambda d: -d[1])
        keep = []
        for d in dets[:2000]:
            if all(_iou(k[0], d[0]) <= self.nms_iou for k in keep):
                keep.append(d)
        sx, sy = nw / ow, nh / oh
        faces = [
            Face(box=(b[0] / sx, b[1] / sy, b[2] / sx, b[3] / sy), score=sc, landmarks=k / np.array([sx, sy]))
            for b, sc, k in keep
        ]
        faces.sort(key=lambda f: -(f.box[2] * f.box[3] * f.score))
        return faces


# -------------------------------------------------------------------------------------------- alignment


def estimate_similarity(src: np.ndarray, dst: np.ndarray) -> tuple[float, float, float, float]:
    """Least-squares similarity (a, b, tx, ty): x' = a x - b y + tx, y' = b x + a y + ty (align.ts)."""
    src = np.asarray(src, np.float64)
    dst = np.asarray(dst, np.float64)
    ms, md = src.mean(0), dst.mean(0)
    p, q = src - ms, dst - md
    norm = (p**2).sum()
    if norm < 1e-12:
        raise ValueError("degenerate landmarks")
    a = (p * q).sum() / norm
    b = (p[:, 0] * q[:, 1] - p[:, 1] * q[:, 0]).sum() / norm
    return a, b, md[0] - (a * ms[0] - b * ms[1]), md[1] - (b * ms[0] + a * ms[1])


def warp_similarity(img: np.ndarray, fwd: tuple[float, float, float, float], size: int = ALIGNED_SIZE, with_valid: bool = False):
    """Inverse bilinear warp with a zero border, identical to align.ts `warpSimilarity`.

    Returns HxWx3 float32 RGB 0..255 (not rounded, as in production), plus the `valid` mask (1 where the output
    pixel maps inside the source image) when with_valid=True."""
    a, b, tx, ty = fwd
    d = a * a + b * b
    ia, ib = a / d, -b / d
    itx, ity = -(ia * tx - ib * ty), -(ib * tx + ia * ty)
    v, u = np.mgrid[0:size, 0:size].astype(np.float64)
    x = ia * u - ib * v + itx
    y = ib * u + ia * v + ity
    h, w = img.shape[:2]
    pad = np.zeros((h + 2, w + 2, 3), np.float32)
    pad[1:-1, 1:-1] = img
    inside = (x > -1) & (y > -1) & (x < w) & (y < h)
    xs, ys = np.where(inside, x, -1.0) + 1, np.where(inside, y, -1.0) + 1
    x0, y0 = np.floor(xs).astype(np.int64), np.floor(ys).astype(np.int64)
    x0 = np.clip(x0, 0, w)
    y0 = np.clip(y0, 0, h)
    fx, fy = (xs - x0)[..., None], (ys - y0)[..., None]
    out = (
        (1 - fx) * (1 - fy) * pad[y0, x0]
        + fx * (1 - fy) * pad[y0, x0 + 1]
        + (1 - fx) * fy * pad[y0 + 1, x0]
        + fx * fy * pad[y0 + 1, x0 + 1]
    )
    out[~inside] = 0
    if with_valid:
        valid = (x >= 0) & (y >= 0) & (x <= w - 1) & (y <= h - 1)
        return out.astype(np.float32), valid
    return out.astype(np.float32)


def align_face(img: np.ndarray, landmarks: np.ndarray, size: int = ALIGNED_SIZE, with_valid: bool = False):
    tpl = ARCFACE_TEMPLATE_112 * (size / ALIGNED_SIZE)
    return warp_similarity(img, estimate_similarity(landmarks, tpl), size, with_valid)


def align_primary(dec: Decoded, face: Face) -> np.ndarray:
    """engine.ts `alignPrimary`: align from the working image, or re-sample small faces from the original."""
    lm = face.landmarks
    ie = face.inter_eye
    oh, ow = dec.full.shape[:2]
    if dec.scale < 1 and ie * dec.scale < MIN_ALIGN_INTER_EYE:
        pad = 2.2 * ie
        left = max(0, int(np.floor(lm[:, 0].min() - pad)))
        top = max(0, int(np.floor(lm[:, 1].min() - pad)))
        right = min(ow, int(np.ceil(lm[:, 0].max() + pad)))
        bottom = min(oh, int(np.ceil(lm[:, 1].max() + pad)))
        if right - left >= 8 and bottom - top >= 8:
            want = min(1.0, MAX_ALIGN_INTER_EYE / max(1.0, ie))
            max_side = max(16, round(max(right - left, bottom - top) * want))
            region = dec.full[top:bottom, left:right]
            rs = min(1.0, max_side / max(right - left, bottom - top))
            if rs < 1:
                region = resize_rgb(region, max(1, round((right - left) * rs)), max(1, round((bottom - top) * rs)))
            rscale = region.shape[1] / (right - left)
            return align_face(region, (lm - np.array([left, top])) * rscale)
    return align_face(dec.rgb, lm * dec.scale)


def detect_and_align(det: YuNet, src, max_side: int = DEFAULT_MAX_DECODE_SIDE):
    """Full production path for one image: decode -> detect -> align the primary face. (crop, face) or (None, None)."""
    dec = decode_image(src, max_side)
    faces = det.detect(dec.rgb, orig_size=(dec.full.shape[1], dec.full.shape[0]))
    if not faces:
        return None, None
    return align_primary(dec, faces[0]), faces[0]


def to_planar(crop_hwc: np.ndarray) -> np.ndarray:
    return np.ascontiguousarray(crop_hwc.transpose(2, 0, 1), dtype=np.float32)


def l2n(x: np.ndarray, axis: int = -1) -> np.ndarray:
    return x / np.maximum(np.linalg.norm(x, axis=axis, keepdims=True), 1e-12)


# ------------------------------------------------------------------------------------------ embedders


class OrtEmbedder:
    """Embeds planar RGB crops (N, 3, 112, 112) float 0..255 with an SFace-compatible ONNX model."""

    def __init__(self, path: Path | str = SFACE_ONNX, threads: int = 2):
        import onnx

        self.path = str(path)
        model = onnx.load(self.path)
        # The upstream SFace file lists its weights as graph inputs; drop them so ORT can constant-fold
        # (same trick as apps/server/src/vision/onnx-model.ts) and so we can feed a batch.
        init = {t.name for t in model.graph.initializer}
        keep = [i for i in model.graph.input if i.name not in init]
        del model.graph.input[:]
        model.graph.input.extend(keep)
        inp = model.graph.input[0]
        inp.type.tensor_type.shape.dim[0].dim_param = "N"
        for o in model.graph.output:
            o.type.tensor_type.shape.dim[0].dim_param = "N"
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.log_severity_level = 3
        so.add_session_config_entry("session.intra_op.allow_spinning", "0")  # shared CPU: never spin-wait
        self.sess = ort.InferenceSession(model.SerializeToString(), sess_options=so, providers=["CPUExecutionProvider"])
        self.input = inp.name
        self.output = model.graph.output[0].name

    def __call__(self, x: np.ndarray, batch: int = 64, normalize: bool = True) -> np.ndarray:
        outs = []
        for i in range(0, len(x), batch):
            chunk = np.ascontiguousarray(x[i : i + batch], dtype=np.float32)
            try:
                outs.append(self.sess.run([self.output], {self.input: chunk})[0])
            except Exception:  # models exported with a fixed batch of 1
                outs.append(np.concatenate([self.sess.run([self.output], {self.input: c[None]})[0] for c in chunk]))
        e = np.concatenate(outs).astype(np.float32)
        return l2n(e) if normalize else e


def sface_torch(path: Path | str = SFACE_ONNX):
    """PyTorch re-implementation of SFace with the ONNX weights loaded (exact eval-mode equivalent)."""
    import onnx
    import torch
    from onnx import numpy_helper
    from torch import nn

    m = onnx.load(str(path))
    W = {t.name: numpy_helper.to_array(t).copy() for t in m.graph.initializer}
    strides = {}
    for n in m.graph.node:
        if n.op_type == "Conv":
            strides[n.name] = [a.ints for a in n.attribute if a.name == "strides"][0][0]

    class ConvBnPrelu(nn.Module):
        def __init__(self, prefix: str):
            super().__init__()
            w = W[f"{prefix}_conv2d_weight"]
            cout, cin_g, k, _ = w.shape
            groups = cout if (cin_g == 1 and "_dw" in prefix) else 1
            cin = cin_g * groups
            self.conv = nn.Conv2d(cin, cout, k, stride=strides[f"{prefix}_conv2d"], padding=k // 2, groups=groups, bias=False)
            self.bn = nn.BatchNorm2d(cout, eps=1e-3, momentum=0.1)
            self.act = nn.PReLU(cout)
            with torch.no_grad():
                self.conv.weight.copy_(torch.from_numpy(w))
                self.bn.weight.copy_(torch.from_numpy(W[f"{prefix}_batchnorm_gamma"]))
                self.bn.bias.copy_(torch.from_numpy(W[f"{prefix}_batchnorm_beta"]))
                self.bn.running_mean.copy_(torch.from_numpy(W[f"{prefix}_batchnorm_moving_mean"]))
                self.bn.running_var.copy_(torch.from_numpy(W[f"{prefix}_batchnorm_moving_var"]))
                self.act.weight.copy_(torch.from_numpy(W[f"{prefix}_relu_gamma"].reshape(-1)))

        def forward(self, x):
            return self.act(self.bn(self.conv(x)))

    class SFace(nn.Module):
        """Input: (N, 3, 112, 112) RGB float 0..255. Output: (N, 128) raw (un-normalised) embedding."""

        def __init__(self):
            super().__init__()
            layers = [ConvBnPrelu("conv_1")]
            for k in range(2, 15):
                layers += [ConvBnPrelu(f"conv_{k}_dw"), ConvBnPrelu(f"conv_{k}")]
            self.features = nn.Sequential(*layers)
            self.bn1 = nn.BatchNorm2d(1024, eps=2e-5)
            self.fc = nn.Linear(50176, 128)
            self.fc_bn = nn.BatchNorm1d(128, eps=2e-5)
            with torch.no_grad():
                for bn, p in ((self.bn1, "bn1"), (self.fc_bn, "fc1")):
                    bn.weight.copy_(torch.from_numpy(W[f"{p}_gamma"]))
                    bn.bias.copy_(torch.from_numpy(W[f"{p}_beta"]))
                    bn.running_mean.copy_(torch.from_numpy(W[f"{p}_moving_mean"]))
                    bn.running_var.copy_(torch.from_numpy(W[f"{p}_moving_var"]))
                self.fc.weight.copy_(torch.from_numpy(W["pre_fc1_weight"]))
                self.fc.bias.copy_(torch.from_numpy(W["pre_fc1_bias"]))
            self.register_buffer("mean", torch.tensor(float(W["scalar_op1"][0])))
            self.register_buffer("scale", torch.tensor(float(W["scalar_op2"][0])))

        def forward(self, x):
            x = (x - self.mean) * self.scale
            x = self.bn1(self.features(x))
            return self.fc_bn(self.fc(torch.flatten(x, 1)))

    return SFace().eval()


def fold_bn(model):
    """Fold every frozen (eval-mode) BatchNorm2d of the conv blocks into its convolution (conv gets a bias; BN
    becomes Identity). Exactly the same function; ~12 % faster to train, and fine-tuning conv weight + bias spans the
    same functions as fine-tuning conv weight + BN affine with frozen statistics."""
    import torch
    from torch import nn

    for blk in model.features:
        conv, bn = blk.conv, blk.bn
        if isinstance(bn, nn.Identity):
            continue
        std = torch.sqrt(bn.running_var + bn.eps)
        scale = bn.weight / std
        new = nn.Conv2d(conv.in_channels, conv.out_channels, conv.kernel_size, conv.stride, conv.padding, groups=conv.groups, bias=True)
        with torch.no_grad():
            new.weight.copy_(conv.weight * scale.view(-1, 1, 1, 1))
            new.bias.copy_(bn.bias - bn.running_mean * scale)
        blk.conv = new
        blk.bn = nn.Identity()
    return model
