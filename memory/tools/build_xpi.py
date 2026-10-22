# -*- coding: utf-8 -*-
"""Build Memory XPI (Zotero 7-10 requires applications.zotero.update_url)."""
import json
import os
import shutil
import struct
import subprocess
import time
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ADDON = ROOT / "addon"
BUILD = ROOT / "build"
OUT = BUILD / "memory.xpi"
ADDON_ID = "memory@jsg.local"
# Override with MEMORY_VERSION=1.4.2 when rebuilding an older release XPI.
VERSION = os.environ.get("MEMORY_VERSION", "1.5.7").strip() or "1.5.7"
# Skip rewriting updates.json when packaging an older version via MEMORY_VERSION.
WRITE_UPDATES = os.environ.get(
    "MEMORY_WRITE_UPDATES",
    "0" if os.environ.get("MEMORY_VERSION") else "1",
) == "1"
HOMEPAGE = "https://github.com/JiangShuguo/zotero-memory"
UPDATE_URL = (
    "https://raw.githubusercontent.com/JiangShuguo/zotero-memory/main/memory/updates.json"
)
UPDATE_LINK = (
    f"https://github.com/JiangShuguo/zotero-memory/releases/download/v{VERSION}/memory.xpi"
)
MIN_VERSION = "6.999"
MAX_VERSION = "10.*"

ADDON_FILES = (
    "bootstrap.js",
    "prefs.js",
    "content/preferences.xhtml",
    "content/preferences.css",
    "content/changelog.json",
    "content/icons/icon.png",
    "content/icons/icon@2x.png",
)
BUNDLE_NAME = "content/memory.js"
TEXT_SUFFIXES = {".js", ".json", ".xhtml", ".css"}


def make_manifest():
    return {
        "manifest_version": 2,
        "name": "Memory",
        "version": VERSION,
        "description": "Comment cards beside Zotero PDF pages, kept in sync with annotation notes",
        "homepage_url": HOMEPAGE,
        "author": "jsg",
        "icons": {
            "48": "content/icons/icon.png",
            "96": "content/icons/icon@2x.png",
        },
        "applications": {
            "zotero": {
                "id": ADDON_ID,
                "update_url": UPDATE_URL,
                "strict_min_version": MIN_VERSION,
                "strict_max_version": MAX_VERSION,
            }
        },
    }


def make_updates():
    return {
        "addons": {
            ADDON_ID: {
                "updates": [
                    {
                        "version": VERSION,
                        "update_link": UPDATE_LINK,
                        "applications": {
                            "zotero": {
                                "strict_min_version": MIN_VERSION,
                                "strict_max_version": MAX_VERSION,
                            }
                        },
                    }
                ]
            }
        }
    }


def to_json(value) -> bytes:
    return json.dumps(value, indent=2, ensure_ascii=True).encode("utf-8") + b"\n"


def bundle() -> bytes:
    """Bundles src/index.ts into one script that defines the global `Memory`."""
    esbuild = ROOT / "node_modules" / "esbuild" / "bin" / "esbuild"
    if not esbuild.exists():
        raise SystemExit("esbuild is missing; run `npm install` first")
    node = shutil.which("node")
    if not node:
        raise SystemExit("node is not on PATH")
    result = subprocess.run(
        [
            node,
            str(esbuild),
            "src/index.ts",
            "--bundle",
            "--format=iife",
            "--global-name=Memory",
            "--target=firefox115",
            "--charset=utf8",
            "--legal-comments=none",
            "--log-level=warning",
            f"--define:__MEMORY_VERSION__={json.dumps(VERSION)}",
        ],
        cwd=ROOT,
        capture_output=True,
    )
    if result.returncode != 0:
        raise SystemExit(result.stderr.decode("utf-8", "replace"))
    if result.stderr:
        print(result.stderr.decode("utf-8", "replace"))
    return result.stdout


def patch_zip_utf8_flags(path: Path):
    data = bytearray(path.read_bytes())
    eocd = data.rfind(b"PK\x05\x06")
    if eocd < 0:
        return
    cd_size = struct.unpack_from("<I", data, eocd + 12)[0]
    cd_off = struct.unpack_from("<I", data, eocd + 16)[0]
    pos = cd_off
    end = cd_off + cd_size
    while pos < end:
        if data[pos : pos + 4] != b"PK\x01\x02":
            break
        flags = struct.unpack_from("<H", data, pos + 8)[0] | 0x800
        struct.pack_into("<H", data, pos + 8, flags)
        local_off = struct.unpack_from("<I", data, pos + 42)[0]
        name_len = struct.unpack_from("<H", data, pos + 28)[0]
        extra_len = struct.unpack_from("<H", data, pos + 30)[0]
        comment_len = struct.unpack_from("<H", data, pos + 32)[0]
        if data[local_off : local_off + 4] == b"PK\x03\x04":
            lflags = struct.unpack_from("<H", data, local_off + 6)[0] | 0x800
            struct.pack_into("<H", data, local_off + 6, lflags)
        pos += 46 + name_len + extra_len + comment_len
    path.write_bytes(data)


def check_package_version():
    # When rebuilding an older XPI via MEMORY_VERSION, package.json may stay on tip.
    if os.environ.get("MEMORY_VERSION"):
        return
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    if package.get("version") != VERSION:
        raise SystemExit(f"package.json version {package.get('version')} != {VERSION}")


def build():
    check_package_version()
    manifest_bytes = to_json(make_manifest())
    (ADDON / "manifest.json").write_bytes(manifest_bytes)
    if WRITE_UPDATES:
        (ROOT / "updates.json").write_bytes(to_json(make_updates()))

    files = {"manifest.json": manifest_bytes}
    for name in ADDON_FILES:
        files[name] = (ADDON / name).read_bytes()
    files[BUNDLE_NAME] = bundle()
    for name, data in files.items():
        if Path(name).suffix.lower() in TEXT_SUFFIXES:
            try:
                data.decode("utf-8")
            except UnicodeDecodeError as e:
                raise SystemExit(f"Non-UTF8 payload {name}: {e}")

    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)

    with zipfile.ZipFile(OUT, "w") as z:
        for name, data in files.items():
            info = zipfile.ZipInfo(name, time.localtime(time.time())[:6])
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 3
            info.external_attr = 0x81A40000
            info.flag_bits = 0x800
            z.writestr(info, data)
            print("+", name)

    patch_zip_utf8_flags(OUT)
    print("Built", OUT, OUT.stat().st_size)
    with zipfile.ZipFile(OUT) as z:
        manifest_text = z.read("manifest.json").decode("utf-8")
        print(manifest_text)
        print("entries:", z.namelist())
        for info in z.infolist():
            if info.flag_bits & 0x800 == 0:
                raise SystemExit(f"UTF-8 flag missing on {info.filename}")
        packed = json.loads(manifest_text)
        zotero = packed["applications"]["zotero"]
        if zotero.get("id") != ADDON_ID or not zotero.get("update_url"):
            raise SystemExit("manifest is missing id or update_url")
        if packed.get("version") != VERSION:
            raise SystemExit(f"manifest version {packed.get('version')} != {VERSION}")
    return files


if __name__ == "__main__":
    build()
    print("Install from:", OUT)
    print("Zotero: Tools -> Plugins -> Install Plugin From File")
