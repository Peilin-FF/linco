#!/usr/bin/env bash
# Linco shadow-diff CLI (EN) — lets the agent operate the "this-turn changes" shadow repo.
#
# Background: the Linco desktop app has a "this-turn agent changes" feature: the moment the user
#   sends a message in the chat box, Linco automatically creates an **independent git shadow repo**
#   under ~/.linco/shadows/<workdir-hash>/ (completely separate from the project's own .git) and
#   snapshots the "before this turn" baseline; after you edit files, Linco's file tree marks
#   A/M/D and shows a red/green diff when a file is opened.
# This script exposes the same logic on the command line so you (the agent) can also begin /
#   changed / diff in scenarios that did NOT go through the Linco chat box (e.g. you work directly
#   in the terminal, or want to refresh/inspect this turn's changes). It operates on the SAME
#   shadow repo the Linco app uses (same hash dir, same filter rules), fully interoperable.
#
# Usage:
#   shadow.sh begin              # take the "this-turn baseline" (start a new turn; overwrites the previous baseline)
#   shadow.sh changed            # list files changed this turn:  <status A/M/D>\t<relative path>
#   shadow.sh diff <file path>   # a file's unified this-turn diff (red/green)
#   shadow.sh status             # print shadow repo location / baseline info (for debugging)
# Working dir defaults to $PWD; override with LINCO_REPO=<abs>.
#
# Design notes (identical to Linco's built-in implementation):
#   - Does NOT read the project .gitignore; only includes source/text/config files humans edit + <1MB
#     (model weights / logs / venv excluded).
#   - venv detection: a directory containing pyvenv.cfg is skipped whole (.venv / .venv312 / env, etc.).
#   - Incremental reset: after the baseline commit it keeps the warm index; changed/diff use
#     incremental git add hashing, so even large directories stay sub-second.
set -euo pipefail

REPO="${LINCO_REPO:-$PWD}"
REPO="${REPO%/}"

# FNV-1a 64-bit hash identical to linco_agent.py, so the shadow dir is the SAME as the Linco app's.
shadow_dir() {
  python3 - "$REPO" <<'PY'
import sys, os
repo = sys.argv[1]
h = 0xcbf29ce484222325
for b in repo.encode("utf-8"):
    h ^= b
    h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
print(os.path.join(os.environ.get("HOME", "/tmp"), ".linco", "shadows", "%016x" % h))
PY
}

GD="$(shadow_dir)"

sgit() { git --git-dir="$GD" --work-tree="$REPO" -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }

ensure_init() {
  if [ ! -e "$GD/HEAD" ]; then
    mkdir -p "$GD"
    sgit init -q
    sgit config user.email linco@local
    sgit config user.name Linco
  fi
}

# Walk the working dir and collect files to include in the snapshot (NUL-separated into $1).
# Rules mirror linco_agent.py.
collect() {
  python3 - "$REPO" "$1" <<'PY'
import sys, os
repo, out_path = sys.argv[1], sys.argv[2]
SKIP = {".git","node_modules","target","__pycache__",".venv","venv","env","dist","build",
        ".tox",".mypy_cache",".pytest_cache",".ruff_cache",".idea",".vscode",".cache",
        "site-packages","swanlog","wandb","outputs","checkpoints","logs",
        ".ipynb_checkpoints",".conda",".eggs","__MACOSX"}
EXT = {".py",".pyi",".pyx",".ipynb",".json",".jsonl",".md",".markdown",".rst",".txt",
       ".yaml",".yml",".toml",".cfg",".ini",".conf",".env",".properties",
       ".sh",".bash",".zsh",".fish",".ps1",".bat",
       ".ts",".tsx",".js",".jsx",".mjs",".cjs",".vue",".svelte",
       ".css",".scss",".less",".html",".htm",".xml",".svg",
       ".c",".h",".cpp",".cc",".hpp",".rs",".go",".java",".kt",".rb",".php",".lua",
       ".sql",".graphql",".proto",".tex",".csv",".tsv",".gradle",".cmake",".mk",
       ".r",".jl",".scala",".swift",".m",".mm"}
NAMES = {"Dockerfile","Makefile","makefile","CMakeLists.txt","Justfile","justfile",
         "README","LICENSE","Procfile",".gitignore",".dockerignore",".env","requirements.txt"}
MAX = 1024*1024
files = []
for dp, dn, fn in os.walk(repo):
    if "pyvenv.cfg" in fn:
        dn[:] = []; continue
    dn[:] = [d for d in dn if d not in SKIP and not d.endswith(".egg-info")]
    for n in fn:
        if os.path.splitext(n)[1].lower() not in EXT and n not in NAMES:
            continue
        fp = os.path.join(dp, n)
        try:
            if os.path.islink(fp) or os.path.getsize(fp) > MAX:
                continue
        except OSError:
            continue
        files.append(os.path.relpath(fp, repo))
        if len(files) > 100000:
            break
with open(out_path, "wb") as f:
    f.write(b"\0".join(p.encode("utf-8") for p in files))
PY
}

# Incrementally refresh the index to the current working tree (no clear -> keeps stat cache, sub-second on big dirs).
stage() {
  local list; list="$GD/linco-stage-cli.$$"
  collect "$list"
  if [ -s "$list" ]; then
    sgit add -f --pathspec-from-file="$list" --pathspec-file-nul || true
  fi
  rm -f "$list"
  sgit add -u || true   # detect deleted files -> D
}

rel_of() {  # turn an absolute path into one relative to repo
  case "$1" in
    "$REPO"/*) printf '%s' "${1#"$REPO"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  begin)
    ensure_init
    stage
    sgit commit -q --allow-empty -m linco-turn-baseline
    echo "This-turn baseline taken (shadow repo: $GD). Inspect changes with 'shadow.sh changed' / 'shadow.sh diff <file>'."
    ;;
  changed)
    [ -e "$GD/HEAD" ] || { echo "(no baseline yet; run shadow.sh begin first)"; exit 0; }
    stage
    sgit diff --cached --name-status HEAD
    ;;
  diff)
    [ -n "${2:-}" ] || { echo "usage: shadow.sh diff <file path>" >&2; exit 2; }
    [ -e "$GD/HEAD" ] || { echo "(no baseline yet; run shadow.sh begin first)"; exit 0; }
    stage
    sgit diff --cached --no-color HEAD -- "$(rel_of "$2")"
    ;;
  status)
    echo "working dir: $REPO"
    echo "shadow repo: $GD"
    if [ -e "$GD/HEAD" ]; then
      echo -n "current baseline: "; sgit log --oneline -1 2>/dev/null || echo "(no commit)"
    else
      echo "current baseline: (none; run shadow.sh begin)"
    fi
    ;;
  *)
    cat >&2 <<EOF
Linco shadow-diff — inspect "this-turn agent changes" (independent shadow git, separate from the project .git)
Usage:
  shadow.sh begin            take this-turn baseline (start a new turn)
  shadow.sh changed          list files changed this turn (A/M/D \\t path)
  shadow.sh diff <file>      a file's unified this-turn diff
  shadow.sh status           shadow repo / baseline info
Env: LINCO_REPO=<abs> overrides the working dir (default \$PWD)
EOF
    exit 2
    ;;
esac
