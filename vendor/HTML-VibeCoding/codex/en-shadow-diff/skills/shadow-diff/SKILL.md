---
name: shadow-diff
description: Use when the user asks "what did you change this turn / show me the diff", or when you edit files directly in the terminal and want Linco's file tree to mark them. Provides shadow.sh to track this-turn agent changes.
---

# Linco This-Turn Diff (shadow diff)

Linco has a "this-turn agent changes" visualization: each time the user sends you a message, Linco automatically creates an **independent git shadow repo** at `~/.linco/shadows/<cwd-hash>/` (completely separate from the project's own `.git`) capturing the baseline "before this turn"; then as you edit files, Linco's file tree marks A/M/D and shows red/green diffs on click.

**Most of this is automatic** — user sends a message = baseline taken; you edit files = shown. It only tracks human-editable source/text/config (<1MB), skipping venv, logs, model weights, etc.

## Calling shadow.sh proactively

The script ships with this plugin; the shadow repo is shared with the Linco app. Prefer the installed path, fall back to this repo:

```bash
# Take/reset this-turn baseline (at most once per user turn; don't repeat mid-turn)
bash ~/.codex/skills/shadow-diff/shadow.sh begin 2>/dev/null \
  || bash ~/.codex/skills/html-kit/shadow.sh begin

# List files changed this turn (A/M/D)
bash ~/.codex/skills/shadow-diff/shadow.sh changed

# Show a file's red/green diff this turn
bash ~/.codex/skills/shadow-diff/shadow.sh diff <file>

# Inspect baseline info
bash ~/.codex/skills/shadow-diff/shadow.sh status
```

Runs at the project root by default (or set `LINCO_REPO=<abs>`).

## When to use proactively

1. When the user asks "what did you change this turn / show me the diff", run `changed`/`diff <file>` for an exact list.
2. When you work directly in the terminal (no chat message, so no auto baseline) but want the user to see this turn's marks, run `begin` first, then start editing.
3. To confirm a change was captured, self-check with `status`/`changed`.

Note: `begin` resets the baseline (starts a new turn). Do not run it repeatedly mid-turn or it erases this turn's existing changes from the diff.
