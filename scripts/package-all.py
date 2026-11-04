"""Builds one VSIX per platform, each with only its own DuckDB engine.

The win32-x64 package is built with vsce. Every other platform's package is
that same file with the DuckDB binding folder swapped and the target updated.

Usage: python scripts/package-all.py [target ...]
Output: vsix/sql-notebook-<target>-<version>.vsix
"""

import json
import re
import subprocess
import sys
import tarfile
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGETS = {
    "win32-x64": "win32-x64",
    "win32-arm64": "win32-arm64",
    "linux-x64": "linux-x64",
    "linux-arm64": "linux-arm64",
    "alpine-x64": "linux-x64-musl",
    "alpine-arm64": "linux-arm64-musl",
    "darwin-x64": "darwin-x64",
    "darwin-arm64": "darwin-arm64",
}
BASE = "win32-x64"
TYPES = {".so": "application/octet-stream", ".dylib": "application/octet-stream", ".dll": "application/octet-stream", ".node": "application/octet-stream"}


def sh(cmd: str, **kw) -> str:
    return subprocess.run(cmd, shell=True, check=True, cwd=ROOT, text=True, capture_output=kw.get("capture", False)).stdout


def main() -> None:
    pkg = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    version = pkg["version"]
    bindings = json.loads((ROOT / "node_modules/@duckdb/node-bindings/package.json").read_text(encoding="utf-8"))["version"]
    wanted = sys.argv[1:] or list(TARGETS)
    out_dir = ROOT / "vsix"
    out_dir.mkdir(exist_ok=True)

    base = out_dir / f"{pkg['name']}-{BASE}-{version}.vsix"
    sh(f'npx vsce package --target {BASE} -o "{base}"')

    with tempfile.TemporaryDirectory() as tmp:
        for target in wanted:
            if target == BASE:
                continue
            plat = TARGETS[target]
            name = f"@duckdb/node-bindings-{plat}"
            tgz = sh(f'npm pack {name}@{bindings} --silent --pack-destination "{tmp}"', capture=True).strip().splitlines()[-1]
            retarget(base, out_dir / f"{pkg['name']}-{target}-{version}.vsix", target, plat, Path(tmp) / tgz)
            print(f"Packaged: vsix/{pkg['name']}-{target}-{version}.vsix")


def retarget(src: Path, dst: Path, target: str, plat: str, tgz: Path) -> None:
    old_prefix = f"extension/node_modules/@duckdb/node-bindings-{TARGETS[BASE]}/"
    new_prefix = f"extension/node_modules/@duckdb/node-bindings-{plat}/"
    with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            if item.filename.startswith(old_prefix):
                continue
            data = zin.read(item.filename)
            if item.filename == "extension.vsixmanifest":
                data = re.sub(rb'TargetPlatform="[^"]+"', f'TargetPlatform="{target}"'.encode(), data)
            elif item.filename == "[Content_Types].xml":
                text = data.decode("utf-8")
                for ext, ctype in TYPES.items():
                    if f'Extension="{ext}"' not in text:
                        text = text.replace("</Types>", f'<Default Extension="{ext}" ContentType="{ctype}"/></Types>')
                data = text.encode("utf-8")
            zout.writestr(item, data)
        with tarfile.open(tgz) as tar:
            for member in tar.getmembers():
                if not member.isfile():
                    continue
                rel = member.name.split("/", 1)[1]
                zout.writestr(new_prefix + rel, tar.extractfile(member).read())


if __name__ == "__main__":
    main()
