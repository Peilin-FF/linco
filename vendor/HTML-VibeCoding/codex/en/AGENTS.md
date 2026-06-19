<!-- LINCO:BEGIN (managed by Linco — do not edit by hand) -->
# Linco working-environment conventions

You are running inside **Linco** (a desktop app that drives code agents). The three conventions below are always in effect, every session.

## 1. Substantive deliverables default to self-contained HTML
For substantive deliverables (multi-option comparisons, implementation plans, code reviews, charts/flowcharts, status/experiment reports, concept explainers, prototypes), default to producing a **single self-contained `.html` file** in the current project's `artifacts/` directory (all CSS/JS/SVG inlined, no build step, opens directly in a browser). The user views it live in Linco's preview pane (hot reload).
- **Prefer the Notebook skeleton**: content deliverables build on the html-kit skill's `templates/notebook.html` — a thin shell + a JSON content array in `<script id="seed">`, with the render engine served by Linco's preview server at `/__assets/notebook.{css,js}`.
- **When producing HTML / a notebook / using design components, first read `~/.codex/skills/html-kit/SKILL.md`**: it has the full design kit (color tokens, typography), the cell conventions, a ready-made component list (card/callout/stat-grid/procon/file-diff/timeline/review/badge, etc. — just write the class), and the "reply in place to the user's md requirement" workflow.
- Put explanatory content into the HTML itself; reply in the terminal with a single line: path + a one-line takeaway.

## 2. "This-turn changes" visualization (shadow diff)
Every time the user sends you a message, Linco automatically takes a "before this turn" baseline using an independent shadow git (separate from the project .git); after you edit files, Linco's file tree auto-marks A/M/D and shows a red/green diff. **Usually fully automatic — you need do nothing.** When needed, invoke the CLI: `bash ~/.codex/skills/html-kit/shadow.sh begin|changed|diff <file>|status` (run in the project root). When the user asks "what did you change this turn", run `changed`/`diff` for an exact list. Note: `begin` resets the baseline — don't call it repeatedly mid-turn.

## 3. Background long tasks must be monitorable
When running training/eval/long data processing inside Linco, launch with "`-u` + redirect to an in-project `.log` file + background `&`" (e.g. `python -u train.py > train.log 2>&1 &`) so Linco's terminal monitor panel can show progress live; the cwd must be inside the project; use a real program name. Never pipe a long task's output directly (no file to read = nothing to monitor).
<!-- LINCO:END -->
