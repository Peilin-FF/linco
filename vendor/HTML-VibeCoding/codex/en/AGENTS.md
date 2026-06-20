<!-- LINCO:BEGIN (managed by Linco — do not edit by hand) -->
# Linco working-environment conventions

You are running inside **Linco** (a desktop app that drives code agents). The three conventions below are always in effect, every session.

## 1. Substantive deliverables default to self-contained HTML
For substantive deliverables (multi-option comparisons, implementation plans, code reviews, charts/flowcharts, status/experiment reports, concept explainers, prototypes), default to producing a **single self-contained `.html` file** in the current project's `artifacts/` directory (all CSS/JS/SVG inlined, no build step, opens directly in a browser). The user views it live in Linco's preview pane (hot reload).
- **The moment the user says "use HTML," default to this notebook template**: when the user explicitly asks to "use HTML," "make a web page," or "produce an HTML intro," this convention takes **unconditional priority** — copy the html-kit `templates/notebook.html` shell and only fill in the JSON content array (cell list) inside `<script id="seed">`. **Never hand-roll a standalone HTML with its own inlined render engine**: such a deliverable cannot be edited / saved / hot-reloaded in place inside Linco, which throws away the entire value of this kit. The litmus test is simple — the deliverable's `<head>` should contain only `/__assets/notebook.css`, the end of `<body>` only `/__assets/notebook.js` + `HtmlVibeNotebook.mount(...)`, with the seed JSON in between; if you wrote a large `<style>` block or a custom render script, you took the wrong path.
- **Prefer the Notebook skeleton**: content deliverables build on the html-kit skill's `templates/notebook.html` — a thin shell + a JSON content array in `<script id="seed">`, with the render engine served by Linco's preview server at `/__assets/notebook.{css,js}`.
- **When producing HTML / a notebook / using design components, first read `~/.codex/skills/html-kit/SKILL.md`**: it has the full design kit (color tokens, typography), the cell conventions, a ready-made component list (card/callout/stat-grid/procon/file-diff/timeline/review/badge, etc. — just write the class), and the "reply in place to the user's md requirement" workflow.
- Put explanatory content into the HTML itself; reply in the terminal with a single line: path + a one-line takeaway.

## 2. "This-turn changes" visualization (shadow diff) must be triggered proactively
Whenever the current turn may edit files, before the first write/format/generate action, take a shadow baseline from the project root:
```bash
if [ -x ~/.codex/skills/html-kit/shadow.sh ]; then
  bash ~/.codex/skills/html-kit/shadow.sh begin
elif [ -x vendor/HTML-VibeCoding/codex/en/skills/html-kit/shadow.sh ]; then
  bash vendor/HTML-VibeCoding/codex/en/skills/html-kit/shadow.sh begin
elif [ -x vendor/HTML-VibeCoding/codex/zh/skills/html-kit/shadow.sh ]; then
  bash vendor/HTML-VibeCoding/codex/zh/skills/html-kit/shadow.sh begin
fi
```
Rules:
- Proactively run `begin` at most once per user turn; do not run it repeatedly mid-turn because it resets the baseline.
- After edits, run `changed` or `status` when useful for self-checking; when the user asks "what changed this turn", you must run `changed`/`diff <file>` for an exact list.
- If `~/.codex/skills/html-kit/shadow.sh` has not been installed, fall back to this repository's `vendor/HTML-VibeCoding/codex/.../shadow.sh`.

## 3. Background long tasks must be monitorable
When running training/eval/long data processing/long dev servers inside Linco, make the background-program watcher able to discover them:
- The cwd must be inside the project.
- Start a real program name; do not hide long tasks inside complex pipelines.
- Python must use `-u`; every long task must redirect output to an in-project `.log` file; append `&` to run it in the background.
- After launch, echo the PID and log path so both the user and Linco's monitor pane can locate it.

Recommended template:
```bash
python -u train.py > train.log 2>&1 &
echo $! > train.pid
```
Never leave long tasks occupying the foreground, and never stream them only to a pipe/stdout (no readable file = nothing for the watcher to monitor).
<!-- LINCO:END -->
