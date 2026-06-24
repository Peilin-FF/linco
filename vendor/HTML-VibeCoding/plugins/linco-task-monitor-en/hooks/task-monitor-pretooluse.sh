#!/usr/bin/env bash
# linco-task-monitor PreToolUse hook: force unbuffered output for python commands.
#
# Problem: when the agent runs `python x.py > log &` without -u, Python block-buffers stdout
# (not a TTY), so output stays in process memory and never hits the file → Linco's background
# task monitor tails nothing and looks frozen until the process exits.
#
# Fix: if a Bash command contains python/python3 and isn't already unbuffered, prepend
# `PYTHONUNBUFFERED=1 ` to the whole command. The env var makes all python subprocesses
# line-buffer and flush immediately; harmless for non-python commands. We don't parse/rewrite
# the python invocation (too many variants) — just prepend, zero collateral.

set -euo pipefail

INPUT="$(cat)"

python3 - "$INPUT" <<'PY'
import sys, json, re

try:
    data = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}
except Exception:
    data = {}

def passthrough():
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow"
        }
    }))
    sys.exit(0)

if data.get("tool_name") != "Bash":
    passthrough()

cmd = (data.get("tool_input") or {}).get("command")
if not isinstance(cmd, str) or not cmd.strip():
    passthrough()

if not re.search(r"\bpython3?\b", cmd):
    passthrough()

if "PYTHONUNBUFFERED" in cmd or re.search(r"\bpython3?\s+(?:-\w+\s+)*-u\b", cmd):
    passthrough()

new_cmd = "PYTHONUNBUFFERED=1 " + cmd

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "updatedInput": {"command": new_cmd}
    },
    "systemMessage": "Injected PYTHONUNBUFFERED=1 so background output flushes live (visible in Linco's task monitor)"
}))
PY
