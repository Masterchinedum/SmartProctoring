"""
Markdown tables from eval.py JSON reports (used to write docs/accuracy/recognizer.md).

  python tools/recognizer/report.py $RECOG_WORK/eval/report.json [--protocol photo] [--variants base|none,A|none]
"""
from __future__ import annotations

import argparse
import json

COND_ORDER = ["clean", "webcam_all", "good", "typical", "dim", "backlit", "sidelit", "stress_all", "lowres", "noisy", "compressed"]


def pct(v):
    return "–" if v is None else f"{100 * v:.1f}"


def fmt_ci(m, k, scale=100):
    if "ci" not in m or k not in m["ci"]:
        return ""
    lo, hi = m["ci"][k]
    return f" [{scale * lo:.1f}, {scale * hi:.1f}]"


def fmt_delta(m, k, scale=100):
    d = m.get("delta_vs_ref", {}).get(k)
    if not d:
        return "ref"
    lo, hi = d["ci"]
    sig = "**" if (lo > 0 or hi < 0) else ""
    return f"{sig}{scale * d['mean']:+.1f} [{scale * lo:+.1f}, {scale * hi:+.1f}]{sig}"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("json")
    ap.add_argument("--protocol", default="photo")
    ap.add_argument("--variants", default=None, help="comma-separated labels to show (default all)")
    ap.add_argument("--conditions", default=",".join(COND_ORDER))
    args = ap.parse_args()
    rep = json.load(open(args.json))
    res = rep["results"]
    labels = None
    for proto in (args.protocol, args.protocol + "-3f"):
        print(f"\n#### protocol `{proto}`\n")
        print("| condition | variant | n gen / imp | genuine mean | impostor p99 | EER % [95 % CI] | TAR@FAR1e-3 % [CI] | TAR@FAR1e-2 % | Δ EER (pts) vs ref | Δ TAR@1e-3 (pts) vs ref |")
        print("|---|---|--:|--:|--:|--:|--:|--:|--:|--:|")
        for c in args.conditions.split(","):
            key = f"{proto}|{c}"
            if key not in res:
                continue
            row = res[key]
            labels = args.variants.split(",") if args.variants else list(row)
            for lab in labels:
                m = row.get(lab)
                if not m or "eer" not in m:
                    continue
                print(
                    f"| {c} | {lab} | {m['n_genuine']} / {m['n_impostor']} | {m['genuine_mean']:.3f} | {m['impostor_p99']:.3f} | "
                    f"{pct(m['eer'])}{fmt_ci(m, 'eer')} | {pct(m['tar_far1e-3'])}{fmt_ci(m, 'tar_far1e-3')} | {pct(m['tar_far1e-2'])} | "
                    f"{fmt_delta(m, 'eer')} | {fmt_delta(m, 'tar_far1e-3')} |"
                )
    print("\n#### family impostors (protocol photo, different identity in the same family)\n")
    print("| condition | variant | n family pairs | family mean | family max | family FMR at the condition's FAR=1e-3 threshold |")
    print("|---|---|--:|--:|--:|--:|")
    for c in args.conditions.split(","):
        key = f"{args.protocol}|{c}"
        if key not in res:
            continue
        for lab in labels or res[key]:
            m = res[key].get(lab)
            if m and m.get("n_family"):
                print(f"| {c} | {lab} | {m['n_family']} | {m['family_mean']:.3f} | {m['family_max']:.3f} | {pct(m['family_fmr_at_thr1e-3'])} % |")


if __name__ == "__main__":
    main()
