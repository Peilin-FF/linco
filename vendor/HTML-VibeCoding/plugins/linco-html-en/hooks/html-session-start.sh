#!/usr/bin/env bash
# linco-html (EN) SessionStart hook: ensure the artifacts preview server is running for the
# current project, and inject the "default to HTML artifacts" workflow instruction (+ design kit).
set -euo pipefail

PORT="${HTML_VIBE_PORT:-8000}"
PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SERVER="$PLUGIN_ROOT/hooks/artifacts_server.py"

# Read hook stdin JSON; pull cwd (fall back to $PWD).
INPUT="$(cat 2>/dev/null || true)"
CWD=""
if command -v jq >/dev/null 2>&1; then
  CWD="$(printf '%s' "$INPUT" | jq -r '.cwd // empty' 2>/dev/null || true)"
fi
[ -z "$CWD" ] && CWD="$PWD"

# Artifacts dir: a pinned absolute path via HTML_VIBE_ARTIFACTS_DIR wins;
# otherwise default to the current project's ./artifacts (portable).
if [ -n "${HTML_VIBE_ARTIFACTS_DIR:-}" ]; then
  ARTIFACTS="$HTML_VIBE_ARTIFACTS_DIR"
else
  ARTIFACTS="$CWD/artifacts"
fi
mkdir -p "$ARTIFACTS" 2>/dev/null || true

# Start the server only if nothing is already listening on $PORT.
SERVING=""
if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
  SERVING="already-running"
elif command -v python3 >/dev/null 2>&1; then
  nohup python3 "$SERVER" "$ARTIFACTS" "$PORT" >/tmp/html-vibe-server.log 2>&1 &
  sleep 1
  if curl -s -o /dev/null --max-time 1 "http://127.0.0.1:$PORT/" 2>/dev/null; then
    SERVING="started"
  else
    SERVING="failed"
  fi
else
  SERVING="no-python3"
fi

CTX="HTML interactive workflow is enabled (linco-html plugin). \
For substantive deliverables (multi-option comparisons, implementation plans, code reviews, charts/flowcharts, status/experiment reports, concept explainers, prototypes, custom editors, etc.), \
default to producing a single self-contained .html file in ${ARTIFACTS}/, inlining all CSS/JS/SVG so it opens directly in a browser (no build step). \
Design kit: background #FAF9F5 (ivory), body text #3D3D3A, accent #D97757 (clay), dark #141413 (slate), good/correct uses #788C5D (olive), bad/wrong uses clay; \
headings in serif (Georgia), body in system-ui sans, code in ui-monospace; cards on white with a 1.5px #D1CFC5 border and 12-14px radius; \
code panels on dark slate with #E8E6DE text. Common components: side-by-side comparison grids, pro/con tables, metric chips, a recommendation callout with a clay left border, inline SVG module/flow diagrams, <details> folds, <section>+JS slides; \
custom editors must include an 'Export' button that turns the UI state back into pasteable markdown/diff/JSON. \
Default to the Notebook skeleton: content-type deliverables (reports/explainers/comparisons/plans/experiment logs) default to building on templates/notebook.html from the html-kit skill. Engine and content are separated — the artifact HTML is a thin shell; the render/edit/table/save engine is served by the preview server at /__assets/notebook.{css,js}, so the artifact file is small, holds only content, and isn't drowned in boilerplate when read. Three cell types (core division of labor): {type:html,html} rich HTML blocks (cards/callouts/side-by-side .flex/colored tables/code panels) are the default form of Claude's output — all conclusions/comparisons/explanations/code walkthroughs use html blocks; {type:table,head,rows} the editable TBL grid, all tables MUST use a TBL cell (no markdown tables, do not stuff a table inside an html block); {type:md,text} is the channel for the USER to state requirements/add content, NOT a deliverable — the user writes requirements in an md cell, and Claude's job is to IMPLEMENT them with HTML blocks/TBL (not echo or reflow markdown), and by default place no md cell and never leave its own output as markdown. Edit model = Jupyter: cells render by default, double-click/✎ to edit, blur or Shift+Enter to render back, Ctrl+S to save; top-right has only × delete, left ⠿ drag to reorder; adding a cell is Jupyter-style — between cells there is normally only a thin line, double-click there to pop +Markdown/+Table (no +HTML, users don't hand-write HTML), the top toolbar has only save/copy. Math: write \$...\$ inline or \$\$...\$\$ block directly in text, rendered by MathJax (plugin asset /__assets, offline); source stays LaTeX, editable, saved as LaTeX. Put only pure math inside formulas; code variable names with underscores (e.g. couple_lambda/beta_bias) should not go into LaTeX (\texttt escaping is fragile) — move them outside the formula in a <code> tag. \
WYSIWYG to disk: the top 'Save to file' POSTs the current content to /__save({path,seed:[...]}), and the server only replaces the JSON inside <script id=\"seed\" type=\"application/json\">. After the user edits and clicks save, the on-disk HTML is updated and you can just read that file — no copy/paste needed. Workflow: copy the template, change only the JSON array in <script id=seed> to the real content, keep the shell and the /__assets/ references intact. To improve the engine, edit the plugin's assets/notebook.{js,css}; all artifacts pick it up automatically. Only use a pure static single figure when notebook isn't a fit. \
Artifacts are disposable, use-and-discard, and may reuse simple filenames. \
Important — put explanatory content INTO the HTML: all reasoning, comparisons, trade-offs, steps, principles, code walkthroughs and other explanatory text go into the HTML file (carried by headings, callouts, notes, folds, etc.); do not repeat them in the terminal. \
After writing, reply in the terminal with a single line: filename/path + a one-line takeaway (plus at most one action the user must take, e.g. copy-export or forward a port). Do not list points, paste code, or restate what the HTML already says. \
Preview server status: ${SERVING} (port ${PORT}). The user opens http://localhost:${PORT}/ in VS Code Simple Browser; file changes hot-reload (~1s). \
If the preview is blank, it's usually that VS Code's PORTS panel hasn't forwarded the port — just briefly tell the user to forward it. \
Only for very short conversational Q&A, or when the user explicitly asks for text, reply in the terminal with plain markdown."

# Emit additionalContext as valid JSON.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CTX"
fi
