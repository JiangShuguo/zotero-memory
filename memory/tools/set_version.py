"""Set MEMORY package version strings. Usage: python tools/set_version.py 1.5.5"""
import json
import pathlib
import re
import sys

version = sys.argv[1] if len(sys.argv) > 1 else ""
if not re.fullmatch(r"\d+\.\d+\.\d+", version):
    raise SystemExit("usage: set_version.py X.Y.Z")

root = pathlib.Path(__file__).resolve().parent.parent
for name in ("package.json", "package-lock.json"):
    path = root / name
    data = json.loads(path.read_text(encoding="utf-8-sig"))
    data["version"] = version
    if "packages" in data and "" in data["packages"]:
        data["packages"][""]["version"] = version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")

build = root / "tools" / "build_xpi.py"
text = build.read_text(encoding="utf-8")
text2, n = re.subn(
    r'(os\.environ\.get\("MEMORY_VERSION", ")\d+\.\d+\.\d+("\)\.strip\(\) or ")\d+\.\d+\.\d+(")',
    rf"\g<1>{version}\g<2>{version}\g<3>",
    text,
    count=1,
)
if n != 1:
    raise SystemExit(f"build_xpi VERSION replace failed: {n}")
build.write_text(text2, encoding="utf-8", newline="\n")
print(version)
