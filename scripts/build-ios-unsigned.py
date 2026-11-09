#!/usr/bin/env python3
"""Build an unsigned arm64 iPhone IPA, or verify an IPA on any desktop OS."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]
TAURI = ROOT / "src-tauri"
ARTIFACTS = ROOT / "artifacts"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def run(arguments, cwd=ROOT, env=None, capture=False):
    print("+ " + shlex.join(map(str, arguments)), flush=True)
    result = subprocess.run(
        list(map(str, arguments)), cwd=cwd, env=env, check=True,
        text=True, stdout=subprocess.PIPE if capture else None,
    )
    return result.stdout.strip() if capture else None


def merge_plist(base, extra):
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            merge_plist(base[key], value)
        else:
            base[key] = value
    return base


def configure_ios_plist(path):
    # `tauri ios build` normally merges this file. Our direct Xcode build must do it too.
    config = json.loads((TAURI / "tauri.ios.conf.json").read_text(encoding="utf-8"))
    overlay = TAURI / config["bundle"]["iOS"]["infoPlist"]
    info = merge_plist(plistlib.loads(path.read_bytes()), plistlib.loads(overlay.read_bytes()))
    path.write_bytes(plistlib.dumps(info, fmt=plistlib.FMT_XML))


def macho_metadata(binary):
    require(len(binary) >= 32, "Mach-O header is missing")
    header = struct.unpack_from("<8I", binary)
    magic, cpu, _, filetype, command_count, command_bytes, _, _ = header
    require(magic == 0xFEEDFACF, "Expected a thin little-endian 64-bit Mach-O")
    require(cpu == 0x0100000C, "Expected an arm64 device executable")
    require(filetype == 2, "Expected MH_EXECUTE")
    require(32 + command_bytes <= len(binary), "Truncated Mach-O load commands")
    offset, platform, minimum, signature_bytes = 32, None, None, 0
    for _ in range(command_count):
        require(offset + 8 <= 32 + command_bytes, "Invalid load command offset")
        command, size = struct.unpack_from("<II", binary, offset)
        require(size >= 8 and offset + size <= 32 + command_bytes,
                "Invalid Mach-O load command size")
        if command == 0x32:
            require(size >= 24, "Truncated LC_BUILD_VERSION")
            platform, encoded = struct.unpack_from("<II", binary, offset + 8)
            minimum = f"{encoded >> 16}.{(encoded >> 8) & 255}.{encoded & 255}"
        elif command == 0x1D:
            require(size >= 16, "Truncated LC_CODE_SIGNATURE")
            signature_bytes = struct.unpack_from("<I", binary, offset + 12)[0]
        offset += size
    require(platform == 2, "Expected IOS platform 2, rather than an iOS simulator")
    require(signature_bytes == 0, "The executable still contains a code signature")
    return {"architecture": "arm64", "platform": "IOS", "minimum_os": minimum,
            "main_executable_signed": False}


def verify(ipa):
    ipa = Path(ipa).resolve()
    with zipfile.ZipFile(ipa) as archive:
        require(archive.testzip() is None, "IPA ZIP integrity check failed")
        names = archive.namelist()
        plists = [name for name in names
                  if re.fullmatch(r"Payload/[^/]+\.app/Info\.plist", name)]
        require(len(plists) == 1, "Expected exactly one Payload/*.app/Info.plist")
        app = plists[0].rsplit("/", 1)[0]
        info = plistlib.loads(archive.read(plists[0]))
        ats = info.get("NSAppTransportSecurity", {})
        require(ats.get("NSAllowsLocalNetworking") is True, "iOS loopback networking is not enabled")
        require(ats.get("NSAllowsArbitraryLoadsForMedia") is True, "Native HTTP media transport is not enabled")
        require(info.get("CFBundleIdentifier") == "com.hghub.huangguo",
                "Unexpected bundle identifier")
        require(float(".".join(info.get("MinimumOSVersion", "0").split(".")[:2])) >= 15,
                "Expected minimum iOS version 15 or newer")
        executable = app + "/" + info["CFBundleExecutable"]
        executable_info = archive.getinfo(executable)
        require((executable_info.external_attr >> 16) & 0o111,
                "Executable permissions were lost during packaging")
        binary = archive.read(executable)
        metadata = macho_metadata(binary)
        require(b"http://127.0.0.1:*" in binary, "Embedded iOS media CSP is missing")
        require(b"ios.http.request" in binary, "Native HTTP media bridge is missing")
        require(b"assets/index-" in binary, "Embedded frontend assets are missing")
        expected_assets = sorted((ROOT / "dist" / "assets").glob("index-*"))
        for asset in expected_assets:
            require(asset.name.encode() in binary,
                    f"Expected embedded frontend asset is missing: {asset.name}")
        require(app + "/embedded.mobileprovision" not in names,
                "Unexpected provisioning profile in unsigned package")
        metadata.update({
            "ipa": ipa.name,
            "bundle_identifier": info["CFBundleIdentifier"],
            "version": info.get("CFBundleShortVersionString"),
            "minimum_os_plist": info.get("MinimumOSVersion"),
            "zip_integrity": "passed",
            "frontend_assets_embedded": True,
            "expected_assets": [asset.name for asset in expected_assets],
            "file_count": len(names),
            "bytes": ipa.stat().st_size,
            "sha256": hashlib.sha256(ipa.read_bytes()).hexdigest(),
            "iphone_installation_tested": False,
            "ios_loopback_transport_configured": True,
            "ios_loopback_csp_embedded": True,
            "ios_http_bridge_embedded": True,
        })
    return metadata


def build():
    require(sys.platform == "darwin", "Build this target on the macOS cloud runner")
    for executable in ("pnpm", "cargo", "rustup", "xcodebuild", "xcrun", "zip"):
        require(shutil.which(executable), f"Required build tool missing: {executable}")
    ARTIFACTS.mkdir(exist_ok=True)
    run(["pnpm", "build"])
    run(["pnpm", "tauri", "ios", "init", "--ci"])
    apple = TAURI / "gen" / "apple"
    project = apple / "huangguo-client.xcodeproj"
    pbx = project / "project.pbxproj"
    require(pbx.is_file(), "Generated Xcode project is missing")
    original_pbx = pbx.read_bytes()
    configure_ios_plist(apple / "huangguo-client_iOS" / "Info.plist")

    with tempfile.TemporaryDirectory(prefix="hghub-ios-") as temporary:
        temporary = Path(temporary)
        environment = os.environ.copy()
        environment["CARGO_TARGET_DIR"] = str(TAURI / "target")
        # SwiftPM sandboxes can fail inside hosted/virtualized build environments.
        shim_directory = temporary / "bin"
        shim_directory.mkdir()
        environment["HGHUB_REAL_SWIFT"] = run(["xcrun", "--find", "swift"], capture=True)
        shim = shim_directory / "swift"
        shim.write_text(
            '#!/bin/bash\nset -e\ncase "${1:-}" in\n'
            'build|package|test|run) exec "$HGHUB_REAL_SWIFT" "$@" --disable-sandbox ;;\n'
            '*) exec "$HGHUB_REAL_SWIFT" "$@" ;;\nesac\n', encoding="utf-8")
        shim.chmod(0o755)
        environment["PATH"] = str(shim_directory) + os.pathsep + environment["PATH"]
        run(["cargo", "build", "--locked", "--target", "aarch64-apple-ios",
             "--release", "--lib", "--features", "tauri/custom-protocol"],
            cwd=TAURI, env=environment)
        library = TAURI / "target/aarch64-apple-ios/release/libhuangguo_client_lib.a"
        require(library.is_file(), "Rust static library was not produced")
        destination = apple / "Externals/arm64/release/libapp.a"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(library, destination)

        # Xcode's generated Rust phase expects a running Tauri CLI WebSocket.
        # The device library above is already built with embedded release assets.
        patched, count = re.subn(
            r"(?m)^(\s*shellScript = ).*ios xcode-script.*$",
            r'\1"echo Using prebuilt device libapp.a";',
            original_pbx.decode("utf-8"),
        )
        require(count == 1, f"Expected one Tauri Rust build phase, found {count}")
        try:
            pbx.write_text(patched, encoding="utf-8")
            derived = temporary / "derived"
            run(["xcodebuild", "-project", project, "-scheme", "huangguo-client_iOS",
                 "-configuration", "release", "-sdk", "iphoneos",
                 "-destination", "generic/platform=iOS", "-derivedDataPath", derived,
                 "CODE_SIGNING_ALLOWED=NO", "CODE_SIGNING_REQUIRED=NO",
                 "CODE_SIGN_IDENTITY=", "CODE_SIGN_STYLE=Manual",
                 "ENABLE_DEBUG_DYLIB=NO", "build"], cwd=apple, env=environment)
            application = derived / "Build/Products/release-iphoneos/HGhub.app"
            require((application / "HGhub").is_file(), "HGhub.app was not produced")
            staging = temporary / "package"
            payload = staging / "Payload"
            payload.mkdir(parents=True)
            shutil.copytree(application, payload / application.name, symlinks=True)
            for debris in staging.rglob(".DS_Store"):
                debris.unlink()
            version = json.loads((ROOT / "package.json").read_text())["version"]
            ipa = ARTIFACTS / f"HGhub_{version}_ios_playback_api_fix_arm64_unsigned.ipa"
            if ipa.exists():
                ipa.unlink()
            run(["zip", "-q", "-r", "-y", ipa, "Payload"], cwd=staging)
            report = verify(ipa)
            report["source_commit"] = run(["git", "rev-parse", "HEAD"], capture=True)
            report["xcode"] = run(["xcodebuild", "-version"], capture=True)
            report["rustc"] = run(["rustc", "--version"], capture=True)
            report["build_script_sha256"] = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
            (ARTIFACTS / "build-report.json").write_text(
                json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            (ARTIFACTS / (ipa.name + ".sha256")).write_text(
                report["sha256"] + "  " + ipa.name + "\n", encoding="utf-8")
            print(json.dumps(report, ensure_ascii=False, indent=2), flush=True)
        finally:
            pbx.write_bytes(original_pbx)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", metavar="IPA", help="Verify an existing IPA without building")
    arguments = parser.parse_args()
    try:
        if arguments.verify:
            print(json.dumps(verify(arguments.verify), ensure_ascii=False, indent=2))
        else:
            build()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
