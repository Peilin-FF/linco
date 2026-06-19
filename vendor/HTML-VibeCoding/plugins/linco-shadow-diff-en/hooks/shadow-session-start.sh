#!/usr/bin/env bash
# linco-shadow-diff (EN) SessionStart hook: inject the "this-turn agent changes diff" guidance.
# Pure guidance + pointer to this plugin's shadow.sh CLI. The shadow repo is shared between the
# Linco app (automatic) and shadow.sh (manual) and fully interoperable. No side effects (no
# server, does not create a baseline; the baseline is taken automatically by Linco when the user sends a message).
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHADOW="$PLUGIN_ROOT/hooks/shadow.sh"

CTX="[Linco this-turn changes diff (shadow diff)] Linco has a 'this-turn agent changes' visualization: every time the user sends you a message in the chat box, Linco automatically creates an **independent git shadow repo** under ~/.linco/shadows/<workdir-hash>/ (completely separate from the project's own .git) and snapshots the 'before this turn' baseline; after you edit files, Linco's file tree auto-marks A/M/D and shows a red/green diff when a file is opened. **This is automatic — normally you need to do nothing**: user sends a message = baseline auto-taken, you edit files = changes auto-shown. It only includes source/text/config files humans actually edit (<1MB) and automatically skips venv, logs, model weights and other artifacts, so it won't choke on large directories.\
You can also **invoke it manually** (script: ${SHADOW}; the shadow repo is shared with the Linco app and fully interoperable): \`bash \"${SHADOW}\" begin\` take/reset this-turn baseline; \`bash \"${SHADOW}\" changed\` list files changed this turn (A/M/D); \`bash \"${SHADOW}\" diff <file>\` show a file's this-turn red/green diff; \`bash \"${SHADOW}\" status\` show baseline info. Runs in the project root by default (or set \`LINCO_REPO=<abs>\`).\
When to invoke proactively: (1) when the user asks 'what did you change this turn / show me the diff', run changed/diff to give an exact list; (2) when you work directly in the terminal (bypassing the chat box, so no baseline was auto-taken) but want the user to see this turn's marks in the file tree, run begin first, then start editing; (3) use status/changed to self-check whether a change was captured. Note: begin resets the baseline (starts a new turn) — do not run begin repeatedly mid-turn, or you will wipe this turn's existing changes from the diff."

# Emit additionalContext as valid JSON.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CTX"
fi
