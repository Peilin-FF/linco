---
name: html-kit
description: Use whenever producing a self-contained HTML artifact/report/comparison/diagram/explainer/prototype/editor, or a Linco notebook, or using the HTML design components (cards, callouts, stat cards, pro/con, file-diff, timeline, badges). Provides the design kit (color tokens, typography), the notebook template, the component list, and the in-place-reply workflow.
---

# HTML artifact design kit

Produce a single self-contained `.html` file (all CSS/JS/SVG inlined, no external deps, no build step), written to the current project's `artifacts/` directory. Artifacts are disposable, use-and-discard, and may reuse simple filenames.

**Explanation goes INTO the HTML, terminal stays terse**: all explanatory content (reasoning, comparisons, trade-offs, steps, principles, code walkthroughs) goes into the HTML file itself — do not restate it in the terminal. After writing, reply in the terminal with one line: path + a one-line takeaway (plus one action hint if needed). The user opens `http://localhost:8000/` in VS Code Simple Browser; hot reload applies automatically.

**Default to the Notebook skeleton (important — the standard form for content deliverables)**: reports / explainers / comparisons / plans / experiment logs and other content deliverables default to building on `templates/notebook.html` (same dir as this SKILL.md), not writing from scratch. It is a Jupyter-style editable notebook, and **engine and content are separated** — the artifact HTML is just a thin shell (shell + content data); the render/edit/table/save engine is a plugin static asset served by the preview server at `/__assets/notebook.{css,js}`. So the artifact file is small, holds only content, isn't drowned in hundreds of lines of boilerplate when Claude reads it, and the engine can be upgraded centrally in the plugin.

- **Three cell types (incl. the core division of labor [[user-md-cell-convention]])**:
  - `{type:'html', html:'…'}` — **rich HTML block, the default form of Claude's output**: cards/callouts/side-by-side/colored labels/code panels/diff/timeline, etc. Component classes are in notebook.css and the "Reusable components" list below (`card` `callout`/`callout rec`/`olive` `flex` `grid` `eyebrow` `lede` `badge`/`chip` `stat-grid`/`stat-card` `procon` `toc` `file-diff`/`pre.diff` `review` `summary-band` `risk-dot` `timeline` `tag` `note` `win` `bad`, etc.). All conclusions, comparisons, explanations and code walkthroughs render via html blocks. **Write the class directly, styling is applied automatically — no inline style**; **do not put Claude's output in an md cell, and never leave the output as markdown.**
  - `{type:'table', head:[…], rows:[[…]]}` — the editable TBL grid (click cells, drag `⠿` to reorder rows/cols, `×` to delete rows/cols, `+row/+col`, copy MD/CSV/JSON separately at the bottom). **All tables must use a TBL cell** — no markdown tables, do not stuff a `<table>` into an html block, so tables stay editable.
  - `{type:'md', text:'…'}` — **the channel for the USER to state requirements/add content, NOT a deliverable**. The user writes requirements in an md cell, and Claude's job is to **implement that requirement with HTML blocks/TBL** (not echo or reflow markdown). When generating, Claude by default places **no** md cell (unless the user explicitly asks).
- **Reply in place to the user's md requirement (important workflow)**: users often **insert an md cell themselves to state a requirement** (possibly anywhere in the middle, possibly several at once). What you read on disk is the **JSON array in `<script id="seed">`** inside the `.html` (ordered; order = top-to-bottom in the UI). Rules:
  1. **Locate**: scan the seed array for `{"type":"md"}` items — those are the user's requirements/questions. Handle each; the ones to answer are typically md cells not yet followed by an `.answer` block.
  2. **Insert in place, do NOT append to the end**: add the reply as a new `{"type":"html"}` cell **right after that requirement md cell** (immediately following it in the array), keeping Q&A adjacent. **Keep the original requirement md cell intact — never delete, edit, or reorder it** — that is the user's input.
  3. **Wrap the reply in the dedicated "response" style**: outermost `<div class="answer">…</div>` (olive left border + an auto "⤷ RESPONSE" label, distinct from the user requirement). Fill the inside with normal components: simple reply → text/`card`; comparison → `procon`/`grid`; data → `stat-grid`/TBL; code changes → `file-diff`. Example: `{"type":"html","html":"<div class=\"answer\"><p>Conclusion first.</p><div class=\"callout rec\">Recommend…</div></div>"}`. **The "RESPONSE" label is added by CSS — do not write "response/answer" yourself.**
  4. **Multiple turns**: when the user later inserts a new md cell, again insert its own `.answer` below it, independently; do not move or merge old replies.

- **Math (LaTeX)**: write `$...$` (inline) or `$$...$$` (block) directly in html-block or md-cell text, rendered by KaTeX (plugin asset `/__assets/katex.min.{js,css}`, ~270KB, synchronous, fast); the rare macros KaTeX can't handle fall back to MathJax (lazy-loaded on demand, not loaded for common docs). **The source stores LaTeX** (`data-tex`); editing restores it to `$...$`, and it saves as LaTeX, not SVG. Example: `training objective $\mathcal{L}=-\sum_i \log p(y_i)$`.
  - **Put only pure math in formulas; do not stuff code identifiers into LaTeX**: variable/function names with underscores (e.g. `couple_lambda`, `beta_bias`, `score_one_candidate`) via `\texttt{a\_b}` escape poorly in MathJax and fail to render. The right approach is to move such code names **outside** the formula in an HTML `<code>` tag and use only single letters/standard notation inside (e.g. write `beta_bias` as $b$, then state in prose "$b$ is `beta_bias`").
- **Edit model = Jupyter**: cells render by default; double-click or click ✎ to edit, blur / Shift+Enter to render back. Each cell has only `×` delete at top-right and `⠿` drag-to-reorder on the left. **Adding a cell is Jupyter-style**: between cells there is normally only a thin line; double-click there to pop `+ Markdown`/`+ Table` (no +HTML, users don't hand-write HTML); the top toolbar has only "Save to file" and "Copy Markdown". Ctrl+S also saves.
- **WYSIWYG to disk**: the top "Save to file" POSTs the current content to the preview server `/__save` (`{path, seed:[...]}`); the server only replaces the content of `<script id="seed" type="application/json">…</script>` in the file. After the user edits and clicks save, the on-disk HTML is updated and Claude can just read that file — no copy/paste. "Copy Markdown" at the top exports the whole notebook.

Workflow: copy `templates/notebook.html`, **change only the JSON array in `<script id="seed">`** to the real content (Claude's output uses `html` blocks + `table`/TBL; all tables use a TBL cell; no `md`). The user's md cell = requirement, implement it with HTML. Keep the shell and the two `/__assets/` references intact. Only skip the notebook for a pure static figure/single image. To improve the engine, edit `assets/notebook.{js,css}`; all artifacts pick it up automatically.

## Design tokens (paste into `<style>:root{}`)

```css
:root{
  --ivory:#FAF9F5; --paper:#FFFFFF; --slate:#141413;
  --clay:#D97757;  --clay-d:#B85C3E; --oat:#E3DACC; --olive:#788C5D;
  --g100:#F0EEE6; --g200:#E6E3DA; --g300:#D1CFC5; --g500:#87867F; --g700:#3D3D3A;
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans:  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:  ui-monospace, "SF Mono", Menlo, Monaco, monospace;
}
```

## Typography & tone
- `body{background:var(--ivory);color:var(--g700);font-family:var(--sans);line-height:1.55}`; wrap content in `.page{max-width:1120px (1360px for grids);margin:0 auto;padding:56px 32px 96px}`.
- Headings use `--serif`, weight 500, `letter-spacing:-0.01em`, color `--slate`; code/labels use `--mono`.
- Accent `--clay` (the only warm focus: active state, key numbers, left-border callouts). `--olive`=good/pro, `--clay`=bad/con. Borders `1.5px solid var(--g300)`, radius 8–14px.
- Cards: white background, `1.5px solid --g300`, radius 12–14px, padding 18–24px.
- Code panels: dark `--slate` background, `#E8E6DE` text, mono; manual highlight spans: `.kw{--clay} .str{--olive} .cm{--g500} .fn{#C9B98A}`.

## Reusable components (write inside an `html` cell: `<div class="...">…</div>`; styles all live in notebook.css — **no inline style, no separate HTML file**)

All components are written by class directly inside a normal html cell; the engine applies styling on render. Colors reuse the tokens (clay=focus/bad, olive=good, g-scale=neutral). List:

**Basics**
- `<div class="eyebrow">category eyebrow</div>` — small mono uppercase eyebrow above the h1.
- `<p class="lede">lede</p>` — large lead paragraph.
- `<span class="badge new">NEW</span>` — label; modifiers: `new`/`add` (olive), `del`/`bad` (clay), `warn` (amber), `info` (slate). `chip` is a synonym.
- Metric cards: `<div class="stat-grid"><div class="stat-card"><div class="stat-num">128</div><div class="stat-label">PASS</div><div class="stat-delta up">+12</div></div>…</div>` (delta modifier `up`/`down`).
- Recommendation: `<div class="callout rec"><div class="callout-h">Recommend</div>…</div>` (`rec`=clay emphasis, `olive`=positive).
- pro/con: `<div class="procon"><div class="pros"><ul><li>pro</li></ul></div><div class="cons"><ul><li>con</li></ul></div></div>` (auto +/− prefix).
- Grid: `<div class="grid col-2">…</div>` / `col-3` (collapses to 1 column on narrow screens); or reuse the older `flex`.

**Navigation / structure**
- toc pills: `<div class="toc"><a href="#x">Section</a>…</div>`.
- Folds: `<details><summary>Title</summary>…</details>` (styled, clay triangle).

**PR / diff** (code-review deliverables)
- File diff card:
  `<div class="file-diff"><div class="fd-head"><span class="fd-path">src/app.ts</span><span class="fd-stat"><span class="a">+12</span> <span class="d">−3</span></span></div><pre class="diff"><span class="dl hunk">@@ -1,5 +1,6 @@</span><span class="dl ctx">unchanged</span><span class="dl del">old line</span><span class="dl add">new line</span></pre></div>`
  — diff line classes: `add` (green, auto +), `del` (red, auto −), `ctx` (context), `hunk` (@@ header). **Do not hand-write +/− prefixes; CSS adds them.**
- review comment: `<div class="review blocking"><div class="avatar">R</div><div class="bubble"><div class="who">Reviewer</div>comment</div></div>` (`blocking`=clay left border).

**Timeline / status report**
- Summary band: `<div class="summary-band"><div><span class="k">Status</span>In progress</div><div><span class="k">Owner</span>Alice</div></div>`.
- Risk dot: `<span class="risk-dot high"></span>High risk` (`high`/`med`/`low`).
- Timeline: `<div class="timeline"><div class="tl-entry"><div class="tl-time">10:32</div><div class="tl-body">event description</div></div>…</div>`.

**Others** (no dedicated class, hand-write as needed)
- Module/flow diagrams — inline `<svg>` boxes + arrows, hot path uses `--clay`.
- Slides — one `<section>` per page + a little JS for arrow-key navigation.
- Custom editors — must include an "Export" button that turns the UI state back into pasteable markdown/diff/JSON.
- Tables — **always use a TBL cell** (`{type:'table'}`), do not stuff a `<table>` into an html block.

## Task → form mapping
Exploration/planning → side-by-side options (`grid`) + timeline · Code review → `file-diff` + `review` comments + module svg · Design → token swatches + component table · Prototype → animation with sliders / clickable flow · Charts → inline svg · Report → `summary-band` + `stat-grid` + `timeline` · PR write-up → `file-diff` + `badge` + `callout rec` · Research → `details` + `toc` + glossary · Editor → one-off editor + export button.

Source: https://thariqs.github.io/html-effectiveness/
