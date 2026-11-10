"""Create allowlisted public M2Fig source snapshots and Windows release archives."""

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import sys
import zipfile


ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIRS = {
    "ReceiveFromMasterGo", "SendToFigma", "shared", "tools", "desktop", "pythonParser"
}
ROOT_FILES = {
    "README.md", "LICENSE", "ATTRIBUTION.md", "requirements.txt", ".gitignore",
    ".gitattributes", "SetupMg2Fig.cmd", "启动迁移工具.cmd",
}
PUBLIC_DOCS = {
    "BRIDGE_VERIFICATION.md", "CACHED_IMAGE_VALIDATION.md", "LOCAL_EXPORT_GUI.md",
    "R4_PIPELINE_REVIEW.md", "RESTORE_PERFORMANCE_ACCEPTANCE.md", "SOP.md", "USAGE.md",
}
EXCLUDED_DIRS = {
    "node_modules", ".venv", "__pycache__", ".git", ".cache", "cache", "caches",
    "logs", "log", "tmp", "temp", "artifacts", "dist", "output", ".agents",
    ".codex", ".trae", ".antigravitycli", "测试集", "黑名单证据",
}
EXCLUDED_FILES = {"tools/createBridgeFixture.js", "tools/checkBridgeFixture.js"}
SOURCE_EXTENSIONS = {
    ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".html", ".css", ".py",
    ".ps1", ".cs", ".cmd", ".bat", ".md", ".txt", ".yml", ".yaml",
}
PLUGIN_SOURCES = {
    "code.js": "ReceiveFromMasterGo/code.js",
    "ui.html": "ReceiveFromMasterGo/ui.html",
    "THIRD_PARTY_NOTICES.md": "ReceiveFromMasterGo/THIRD_PARTY_NOTICES.md",
    "LICENSE": "LICENSE",
    "USAGE.md": "docs/public/USAGE.md",
    "BRIDGE_VERIFICATION.md": "docs/public/BRIDGE_VERIFICATION.md",
    "docs/RESTORE_PERFORMANCE_ACCEPTANCE.md": "docs/public/RESTORE_PERFORMANCE_ACCEPTANCE.md",
    "docs/R4_PIPELINE_REVIEW.md": "docs/public/R4_PIPELINE_REVIEW.md",
    "docs/LOCAL_EXPORT_GUI.md": "docs/public/LOCAL_EXPORT_GUI.md",
    "docs/CACHED_IMAGE_VALIDATION.md": "docs/public/CACHED_IMAGE_VALIDATION.md",
    "SOP.md": "docs/public/SOP.md",
    "SendToFigma/code.js": "SendToFigma/code.js",
    "SendToFigma/ui.html": "SendToFigma/ui.html",
    "licenses/heic-to-LGPL-3.0.txt": "ReceiveFromMasterGo/licenses/heic-to-LGPL-3.0.txt",
    "licenses/GPL-3.0.txt": "ReceiveFromMasterGo/licenses/GPL-3.0.txt",
}
PLUGIN_MANIFESTS = {"manifest.json", "SendToFigma/manifest.json"}
SOURCE_MANIFEST = "source-manifest.json"
GIT_ATTRIBUTES = "* -text\n"
UTF8_BOM = b"\xef\xbb\xbf"
AGENTS = """# Mg2Fig contributor guide

Read README.md, ATTRIBUTION.md and LICENSE before changing or redistributing this project.
Mg2Fig is derived from Aaron Xu / AaronXu-Lab's MasterGo2Figma at
commit d6d93574b1c695906300d60712697a03b795877e; retain attribution and CC BY-NC-SA 4.0.
Third-party dependencies keep their own license notices.

- Preserve the v2/v3 data format, source/component identities and retained-import failure semantics.
- Keep Figma plugin ID 2712095548761342 unless an intentional release migration is requested.
- Edit ReceiveFromMasterGo/ui-src, then build; do not hand-edit generated ui.html.
- Test: node --test tools/tests/*.test.js; cd desktop and run npm test.
- Build both plugins with npm ci and npm run build in their respective directories.
- Package: powershell -File tools/packageMg2FigV3.ps1.
- Desktop setup: SetupMg2Fig.cmd. Runtime paths are generated locally; never commit them.
- Use synthetic test fixtures. Never commit design files, client names, caches, logs or credentials.
- Preserve local work; do not reset or recursively delete user directories.
- Do not claim a real GUI or design migration test from static checks alone.

Upstream format documentation is available at:
https://github.com/AaronXu-Lab/MasterGo2Figma/tree/d6d93574b1c695906300d60712697a03b795877e/docs
"""
ASSET_README = """# M2Fig brand assets

These M2Fig brand assets are supplied by this project's maintainer.
The dark and light SVG/PNG originals are retained for editing. No system font files
are distributed here. Third-party trademarks remain with their respective owners.

The Windows application uses mg2fig.ico, generated from mg2fig-dark.png.
From the repository root run python tools/buildMg2FigIcons.py to regenerate
16, 20, 24, 32, 48, 64, 128 and 256 pixel ICO entries, then rebuild the desktop app.
"""


def digest(file_path):
    value = hashlib.sha256()
    with file_path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(block)
    return value.hexdigest()


def relative_path(value):
    path = PurePosixPath(value)
    if not value or "\\" in value or ":" in value or "\0" in value or path.is_absolute():
        raise ValueError("Invalid relative path in source manifest.")
    if ".." in path.parts or str(path) != value:
        raise ValueError("Non-normalized path in source manifest.")
    return path


def excluded(path):
    if any(part.casefold() in EXCLUDED_DIRS for part in path.parts):
        return True
    name = path.name.casefold()
    return (
        str(path) in EXCLUDED_FILES
        or name in {".ds_store", ".dsstore"}
        or name.startswith(".env")
        or (name.startswith("bridge-runtime") and name.endswith(".json"))
        or path.suffix.casefold() in {".pyc", ".exe", ".zip", ".mg", ".log", ".cache", ".db", ".sqlite", ".sqlite3"}
    )


def source_allowed(path):
    name = str(path)
    if excluded(path):
        return False
    if len(path.parts) == 1:
        return name in ROOT_FILES or name == "AGENTS.md"
    if path.parts[:2] == ("docs", "public"):
        return len(path.parts) == 3 and path.name in PUBLIC_DOCS
    if name in {"assets/mg2fig-readme-banner.png", "assets/mg2fig-r5-v3-preview.png"}:
        return True
    if path.parts[0] not in SOURCE_DIRS:
        return False
    if path.suffix.casefold() in SOURCE_EXTENSIONS or path.name == "code.ts.legacy":
        return True
    return (
        path.parts[:2] == ("desktop", "assets")
        or path.parts[:3] == ("desktop", "renderer", "assets")
    ) and path.suffix.casefold() in {".svg", ".png", ".ico", ".woff", ".woff2", ".ttf", ".otf"}


def ensure_not_link(path, relative):
    if path.is_symlink() or getattr(path, "is_junction", lambda: False)():
        raise ValueError(f"Links are not allowed in release input: {relative}")


def walk_files(base, relative_dir):
    directory = base.joinpath(*relative_dir.parts)
    ensure_not_link(directory, str(relative_dir))
    for current, dirs, files in os.walk(directory, followlinks=False):
        current_path = Path(current)
        kept = []
        for name in sorted(dirs):
            child = current_path / name
            relative = PurePosixPath(child.relative_to(base).as_posix())
            if excluded(relative):
                continue
            ensure_not_link(child, str(relative))
            kept.append(name)
        dirs[:] = kept
        for name in sorted(files):
            child = current_path / name
            relative = PurePosixPath(child.relative_to(base).as_posix())
            if excluded(relative):
                continue
            ensure_not_link(child, str(relative))
            yield relative


def record(base, relative):
    file_path = base.joinpath(*relative.parts)
    if not file_path.is_file():
        raise ValueError(f"Required release file is missing: {relative}")
    ensure_not_link(file_path, str(relative))
    return {"path": str(relative), "sha256": digest(file_path), "size": file_path.stat().st_size}


def make_source(output):
    if output.exists():
        raise ValueError("Source output already exists; choose a new directory.")
    for directory in SOURCE_DIRS:
        if output.is_relative_to((ROOT / directory).resolve()):
            raise ValueError("Source output must be outside the published source directories.")
    names = set(ROOT_FILES)
    names.update(f"docs/public/{name}" for name in PUBLIC_DOCS)
    names.add("assets/mg2fig-readme-banner.png")
    names.add("assets/mg2fig-r5-v3-preview.png")
    for directory in SOURCE_DIRS:
        if not (ROOT / directory).is_dir():
            raise ValueError(f"Required source directory is missing: {directory}")
        names.update(str(path) for path in walk_files(ROOT, PurePosixPath(directory)) if source_allowed(path))
    planned = [record(ROOT, relative_path(name)) for name in sorted(names)]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.mkdir()
    records = []
    for item in planned:
        relative = relative_path(item["path"])
        destination = output.joinpath(*relative.parts)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if item["path"] == ".gitattributes":
            destination.write_text(GIT_ATTRIBUTES, encoding="utf-8", newline="\n")
        elif relative.suffix.casefold() == ".ps1":
            content = ROOT.joinpath(*relative.parts).read_bytes()
            if hashlib.sha256(content).hexdigest() != item["sha256"]:
                raise ValueError(f"Source changed during snapshot: {relative}")
            content.decode("utf-8-sig")
            destination.write_bytes(content if content.startswith(UTF8_BOM) else UTF8_BOM + content)
        elif item["path"] == "desktop/assets/README.md" and "figma.com/design/" in ROOT.joinpath(*relative.parts).read_text(encoding="utf-8"):
            destination.write_text(ASSET_README, encoding="utf-8", newline="\n")
        else:
            shutil.copyfile(ROOT.joinpath(*relative.parts), destination)
            if digest(destination) != item["sha256"]:
                raise ValueError(f"Source changed during snapshot: {relative}")
        records.append(record(output, relative))
    (output / "AGENTS.md").write_text(AGENTS, encoding="utf-8", newline="\n")
    records.append(record(output, PurePosixPath("AGENTS.md")))
    manifest = {
        "format": "m2fig-source-v1",
        "upstream": "AaronXu-Lab/MasterGo2Figma@d6d93574b1c695906300d60712697a03b795877e",
        "files": sorted(records, key=lambda item: item["path"]),
    }
    (output / SOURCE_MANIFEST).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    return {"command": "source", "files": len(records), "manifest": record(output, PurePosixPath(SOURCE_MANIFEST))}


def validated_snapshot(source):
    manifest_path = source / SOURCE_MANIFEST
    ensure_not_link(manifest_path, SOURCE_MANIFEST)
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("format") != "m2fig-source-v1" or not isinstance(manifest.get("files"), list):
        raise ValueError("Invalid M2Fig source manifest.")
    expected = {}
    for item in manifest["files"]:
        relative = relative_path(item["path"])
        if not source_allowed(relative) or str(relative).casefold() in expected:
            raise ValueError(f"Unexpected or duplicate source manifest entry: {relative}")
        if record(source, relative) != item:
            raise ValueError(f"Source snapshot hash or size changed: {relative}")
        expected[str(relative).casefold()] = str(relative)
    actual = {SOURCE_MANIFEST}
    for path in walk_files(source, PurePosixPath(".")):
        if str(path) == SOURCE_MANIFEST:
            continue
        if not source_allowed(path):
            raise ValueError(f"Unapproved file in source snapshot: {path}")
        actual.add(str(path))
    if actual != set(expected.values()) | {SOURCE_MANIFEST}:
        raise ValueError("Source snapshot differs from its exact manifest.")
    if (source / "AGENTS.md").read_text(encoding="utf-8") != AGENTS:
        raise ValueError("Source snapshot does not contain the public contributor guide.")
    if (source / ".gitattributes").read_text(encoding="utf-8") != GIT_ATTRIBUTES:
        raise ValueError("Source snapshot must preserve manifest bytes across Git checkouts.")
    for relative in actual:
        if PurePosixPath(relative).suffix.casefold() == ".ps1":
            content = source.joinpath(*PurePosixPath(relative).parts).read_bytes()
            if not content.startswith(UTF8_BOM):
                raise ValueError(f"PowerShell source must have a UTF-8 BOM: {relative}")
            content.decode("utf-8-sig")
    if "figma.com/design/" in (source / "desktop/assets/README.md").read_text(encoding="utf-8"):
        raise ValueError("Source snapshot contains an unreviewed brand-source document.")
    return sorted(actual)


def make_bundle(source, output):
    if output.exists():
        raise ValueError("Bundle output already exists; choose a new ZIP path.")
    source_paths = validated_snapshot(source)
    plugin_root = ROOT / "dist/Mg2Fig-v3-local"
    if not plugin_root.is_dir():
        plugin_root = ROOT / "dist/M2Fig-r4-local"
    plugin_paths = sorted(PLUGIN_SOURCES.keys() | PLUGIN_MANIFESTS)
    actual_plugin = {path.relative_to(plugin_root).as_posix() for path in plugin_root.rglob("*") if path.is_file()}
    if actual_plugin != set(plugin_paths):
        raise ValueError("Prebuilt Figma plugin differs from its 17-entry allowlist.")
    for name, source_name in PLUGIN_SOURCES.items():
        if record(plugin_root, relative_path(name))["sha256"] != record(source, relative_path(source_name))["sha256"]:
            raise ValueError(f"Prebuilt plugin differs from reviewed source: {name}")
    receiver = json.loads((plugin_root / "manifest.json").read_text(encoding="utf-8-sig"))
    if receiver.get("id") != "2712095548761342" or receiver.get("name") not in {"Mg2Fig V3", "M2Fig（本地 r4）"}:
        raise ValueError("Prebuilt plugin has the wrong Mg2Fig identity.")
    exporter = json.loads((plugin_root / "SendToFigma/manifest.json").read_text(encoding="utf-8-sig"))
    if "id" in exporter or not (exporter.get("name", "").startswith("Mg2Fig Export ") or exporter.get("name", "").startswith("M2Fig Export ")):
        raise ValueError("MasterGo exporter contains a private development identity.")
    entries = [(relative, source.joinpath(*PurePosixPath(relative).parts)) for relative in source_paths]
    exe = ROOT / "dist/desktop-v3/Mg2Fig.exe"
    if not exe.is_file():
        exe = ROOT / "dist/desktop-r4/M2Fig.exe"
    with exe.open("rb") as stream:
        if stream.read(2) != b"MZ":
            raise ValueError("Mg2Fig.exe is not a Windows executable.")
    entries.append(("Mg2Fig.exe", exe))
    entries.extend((f"dist/Mg2Fig-v3-local/{name}", plugin_root.joinpath(*PurePosixPath(name).parts)) for name in plugin_paths)
    unpacked_dir = ROOT / "dist/desktop-v3/win-unpacked"
    if not unpacked_dir.is_dir():
        unpacked_dir = ROOT / "dist/desktop-r4/win-unpacked"
    for name in ("LICENSE.electron.txt", "LICENSES.chromium.html"):
        entries.append((f"licenses/{name}", unpacked_dir / name))
    checks = []
    for relative, file_path in entries:
        ensure_not_link(file_path, relative)
        if not file_path.is_file():
            raise ValueError(f"Required bundle file is missing: {relative}")
        checks.append({"path": relative, "sha256": digest(file_path), "size": file_path.stat().st_size})
    output.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(output, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
        for (relative, file_path), expected in zip(entries, checks):
            with file_path.open("rb") as input_stream, archive.open(f"M2Fig/{relative}", "w") as output_stream:
                shutil.copyfileobj(input_stream, output_stream, length=1024 * 1024)
            with archive.open(f"M2Fig/{relative}") as stream:
                value = hashlib.sha256()
                for block in iter(lambda: stream.read(1024 * 1024), b""):
                    value.update(block)
            if value.hexdigest() != expected["sha256"]:
                raise ValueError(f"Bundle input changed while writing: {relative}")
        archive.writestr("M2Fig/release-manifest.json", json.dumps({"format": "m2fig-windows-release-v1", "files": checks}, ensure_ascii=False, indent=2) + "\n")
    with zipfile.ZipFile(output) as archive:
        if archive.testzip() is not None:
            raise ValueError("Bundle ZIP CRC check failed.")
    return {"command": "bundle", "files": len(checks) + 1, "sha256": digest(output), "size": output.stat().st_size}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    source_command = commands.add_parser("source", help="Create a new public source snapshot.")
    source_command.add_argument("--output", required=True, type=Path)
    bundle_command = commands.add_parser("bundle", help="Package reviewed source and the prebuilt Windows app/plugins.")
    bundle_command.add_argument("--source", required=True, type=Path)
    bundle_command.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        if args.command == "source":
            result = make_source(args.output.resolve())
        else:
            result = make_bundle(args.source.resolve(), args.output.resolve())
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile) as error:
        parser.exit(1, f"Release packaging failed: {error}\n")
    except OSError as error:
        parser.exit(1, f"Release packaging failed: {error.strerror or type(error).__name__}\n")
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
