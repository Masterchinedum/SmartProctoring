"""
Download the LABEL-FREE training images: official portraits of members of the US Congress
(github.com/unitedstates/images, pinned commit), which are US-government works in the PUBLIC DOMAIN
(Government Publishing Office Member Guide; the repository's own files are CC0-1.0).

  python tools/recognizer/fetch_data.py            # -> $RECOG_WORK/train/congress/<bioguide>.jpg + manifest

Only the image bytes are used; no names or other labels enter training. Identities that also appear in the
evaluation sets are removed by id here (EXCLUDE) and, after cropping, by an embedding audit
(build_train.py --audit): any training portrait whose SFace similarity to any evaluation image reaches
AUDIT_MAX_SIM is dropped.

Evaluation images (identity-labelled, disjoint identities) are NOT downloaded here: they come from the shared cache
of apps/server/src/eval/datasets.ts (`pnpm --filter @sp/server eval:fetch-faces`) and are listed with
tools/recognizer/ts/export_faceset.mts.
"""
from __future__ import annotations

import argparse
import subprocess
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from common import WORK, write_json

REPO = "unitedstates/images"
COMMIT = "aec3e4a88af843b282c0576f420b930f6a9a46ad"
SIZE = "450x550"
LICENSE = "Public domain (US federal government works, GPO Member Guide); repository files CC0-1.0"

#: Bioguide ids of people who are ALSO in the evaluation sets (face_recognition examples): Joe Biden, Barack Obama.
EXCLUDE = {"B000444", "O000167"}


def list_files(tree_dir: Path) -> list[str]:
    """List congress/<SIZE>/*.jpg at COMMIT with a blob-less clone (no GitHub API needed)."""
    if not (tree_dir / ".git").exists():
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", f"https://github.com/{REPO}", str(tree_dir)], check=True)
    subprocess.run(["git", "-C", str(tree_dir), "fetch", "-q", "--filter=blob:none", "origin", COMMIT], check=False)
    out = subprocess.run(
        ["git", "-C", str(tree_dir), "ls-tree", "-r", "--name-only", COMMIT, f"congress/{SIZE}"], check=True, capture_output=True, text=True
    ).stdout
    return [l for l in out.splitlines() if l.endswith(".jpg")]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(WORK / "train" / "congress"))
    ap.add_argument("--workers", type=int, default=8)
    args = ap.parse_args()
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    files = list_files(WORK / "usimages-tree")
    todo = [f for f in files if Path(f).stem not in EXCLUDE]
    print(f"{len(files)} portraits listed, {len(files) - len(todo)} excluded (in eval sets)")

    def get(path: str):
        dst = out / Path(path).name
        if dst.exists() and dst.stat().st_size > 0:
            return path, "cached"
        url = f"https://raw.githubusercontent.com/{REPO}/{COMMIT}/{path}"
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                data = r.read()
            dst.write_bytes(data)
            return path, "downloaded"
        except Exception as e:  # noqa: BLE001
            return path, f"error {e}"

    with ThreadPoolExecutor(args.workers) as ex:
        results = list(ex.map(get, todo))
    errors = [r for r in results if r[1].startswith("error")]
    print(f"done: {sum(r[1] == 'downloaded' for r in results)} downloaded, {sum(r[1] == 'cached' for r in results)} cached, {len(errors)} errors")
    write_json(
        out / "manifest.json",
        {
            "source": f"https://github.com/{REPO}/tree/{COMMIT}/congress/{SIZE}",
            "license": LICENSE,
            "excluded_ids": sorted(EXCLUDE),
            "files": sorted(Path(p).name for p, s in results if not s.startswith("error")),
        },
    )


if __name__ == "__main__":
    main()
