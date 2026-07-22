#!/usr/bin/env python3
"""Reject iOS SwiftPM lock drift before Xcode is allowed to resolve packages."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path


EXPECTED_PINS = {
    "runestone": (
        "https://github.com/simonbs/Runestone.git",
        "0.5.2",
        "592434a103a4d1ab83e14f87ac6eef569dd7a99d",
    ),
    "swift-argument-parser": (
        "https://github.com/apple/swift-argument-parser",
        "1.7.0",
        "c5d11a805e765f52ba34ec7284bd4fcd6ba68615",
    ),
    "swift-docc-plugin": (
        "https://github.com/apple/swift-docc-plugin",
        "1.4.6",
        "e977f65879f82b375a044c8837597f690c067da6",
    ),
    "swift-docc-symbolkit": (
        "https://github.com/swiftlang/swift-docc-symbolkit",
        "1.0.0",
        "b45d1f2ed151d057b54504d653e0da5552844e34",
    ),
    "swiftterm": (
        "https://github.com/migueldeicaza/SwiftTerm.git",
        "1.14.0",
        "849e8a4f3d6f79ddee07152400137f1370c32621",
    ),
    "tree-sitter": (
        "https://github.com/tree-sitter/tree-sitter",
        "0.20.9",
        "98be227227af10cc7a269cb3ffb23686c0610b17",
    ),
    "treesitterlanguages": (
        "https://github.com/simonbs/TreeSitterLanguages.git",
        "0.1.10",
        "15cf3a9ec3ab95e0d058b7df9f35619123c9e02d",
    ),
}

DIRECT_PROJECT_MARKERS = {
    "SwiftTerm": (
        "url: https://github.com/migueldeicaza/SwiftTerm.git",
        "exactVersion: 1.14.0",
    ),
    "Runestone": (
        "url: https://github.com/simonbs/Runestone.git",
        "exactVersion: 0.5.2",
    ),
    "TreeSitterLanguages": (
        "url: https://github.com/simonbs/TreeSitterLanguages.git",
        "exactVersion: 0.1.10",
    ),
}


def fail(message: str) -> None:
    print(f"package-lock error: {message}", file=sys.stderr)
    raise SystemExit(1)


def main() -> None:
    script_dir = Path(__file__).resolve().parent
    ios_root = script_dir.parent
    lock_path = ios_root / "Package.resolved"
    project_path = ios_root / "project.yml"

    try:
        document = json.loads(lock_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot parse {lock_path}: {error}")

    if document.get("version") not in (2, 3):
        fail("Package.resolved must use a SwiftPM v2/v3 schema")
    pins = document.get("pins")
    if not isinstance(pins, list):
        fail("Package.resolved has no pins array")

    indexed = {}
    for pin in pins:
        if not isinstance(pin, dict) or not isinstance(pin.get("identity"), str):
            fail("every pin must have a string identity")
        identity = pin["identity"]
        if identity in indexed:
            fail(f"duplicate pin identity {identity}")
        indexed[identity] = pin

    if set(indexed) != set(EXPECTED_PINS):
        missing = sorted(set(EXPECTED_PINS) - set(indexed))
        unexpected = sorted(set(indexed) - set(EXPECTED_PINS))
        fail(f"pin set drifted; missing={missing}, unexpected={unexpected}")

    for identity, (location, version, revision) in EXPECTED_PINS.items():
        pin = indexed[identity]
        state = pin.get("state")
        if pin.get("kind") != "remoteSourceControl":
            fail(f"{identity} is not a remote source-control pin")
        if pin.get("location") != location:
            fail(f"{identity} location drifted")
        if not isinstance(state, dict):
            fail(f"{identity} has no state")
        if state.get("version") != version or state.get("revision") != revision:
            fail(f"{identity} version/revision drifted")
        if not re.fullmatch(r"[0-9a-f]{40}", revision):
            fail(f"{identity} revision is not a full lowercase Git commit")
        if state.get("branch") is not None:
            fail(f"{identity} must not use a branch pin")

    try:
        project = project_path.read_text(encoding="utf-8")
    except OSError as error:
        fail(f"cannot read {project_path}: {error}")
    project_lines = project.splitlines()
    for package, markers in DIRECT_PROJECT_MARKERS.items():
        heading = f"  {package}:"
        try:
            block_start = project_lines.index(heading)
        except ValueError:
            fail(f"project.yml is missing direct package {package}")
        body = []
        for line in project_lines[block_start + 1 :]:
            if not line.startswith("    "):
                break
            body.append(line.strip())
        block = "\n".join(body)
        if any(marker not in block for marker in markers):
            fail(f"project.yml direct requirement drifted for {package}")

    direct = {
        "runestone": "0.5.2",
        "swiftterm": "1.14.0",
        "treesitterlanguages": "0.1.10",
    }
    for identity, version in direct.items():
        if indexed[identity]["state"]["version"] != version:
            fail(f"direct pin {identity} is not locked to {version}")

    print("Verified 3 direct and 4 transitive SwiftPM pins with full revisions.")


if __name__ == "__main__":
    main()
