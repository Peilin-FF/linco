---
name: html-kit
description: Design kit + boilerplate for producing self-contained HTML artifacts (the "unreasonable effectiveness of HTML" Anthropic style). Use when building an HTML artifact/report/comparison/diagram/explainer/editor and you want the consistent house style, or when the user asks for the html-vibe design tokens.
---

# HTML 产物设计套件

产出单个自包含 `.html` 文件（内联全部 CSS/JS/SVG，无外部依赖、无构建步骤），写到当前项目的 `artifacts/` 目录。产物一次性、用完即弃，可复用简单文件名。

**解释入 HTML、终端从简**：所有解释性内容（论证、对比、权衡、步骤、原理、代码讲解）写进 HTML 文件本身，不要在终端复述。写完后终端只回一句：路径 + 一句话要点（必要时加一条操作提示）。用户在 VS Code Simple Browser 打开 `http://localhost:8000/` 查看，热刷新自动生效。

**默认用 Notebook 骨架（重要，内容型产物的标准形态）**：报告/讲解/对比/计划/实验记录等内容型产物，默认基于 `templates/notebook.html`（与本 SKILL.md 同目录）改造，而不是从零写。它是一个 Jupyter 式可编辑 notebook，且**引擎与内容分离**——产物 HTML 只是薄壳（壳 + 内容数据），渲染/编辑/表格/保存引擎是插件静态资源，由预览服务器在 `/__assets/notebook.{css,js}` 提供。所以产物文件很小、只含内容，Claude 读它时不会被几百行样板淹没，引擎也能在插件里统一升级。

- **三种 cell（含核心分工约定 [[user-md-cell-convention]]）**：
  - `{type:'html', html:'…'}` — **富 HTML 块，这是 Claude 产出内容的默认形态**：卡片/callout/并排 `.flex`/彩色表/深色代码面板（class 见 notebook.css：`card` `callout` `callout olive` `flex` `tag` `why` `note` `win` `bad`）。所有结论、对比、说明、代码讲解都用 html 块渲染，**不要用 md cell 装 Claude 的产出，也不要把产出留成 markdown**。
  - `{type:'table', head:[…], rows:[[…]]}` — 可编辑 TBL 网格（点单元格、拖 `⠿` 换行列、`×` 删行列、`+行/+列`、底部 MD/CSV/JSON 单独复制）。**所有表格一律用 TBL cell** —— 不要用 markdown 表、也不要在 html 块里塞 `<table>`，这样表格才始终可编辑。
  - `{type:'md', text:'…'}` — **是用户提需求/补充内容的频道，不是交付物**。用户在 md cell 里写需求，Claude 的职责是**把这个需求用 HTML 块/TBL 实现**（不是回显或重排 markdown）。Claude 生成产物时默认**不放** md cell（除非用户明确要求）。
- **数学公式（LaTeX）**：在 html 块或 md cell 的文字里直接写 `$...$`（行内）或 `$$...$$`（块级），由 KaTeX（插件资源 `/__assets/katex.min.{js,css}`，~270KB、同步、快）渲染成公式；极少数 KaTeX 不支持的冷门宏会自动回退到 MathJax 渲染（按需懒加载，常见文档不加载）。**源码里存的是 LaTeX**（`data-tex`），编辑时还原为 `$...$` 可改,存盘也是 LaTeX 而非 SVG。例：`训练目标 $\mathcal{L}=-\sum_i \log p(y_i)$`。
  - **公式里只放纯数学，不要把代码标识符塞进 LaTeX**：带下划线的变量名/函数名（如 `couple_lambda`、`beta_bias`、`score_one_candidate`）用 `\texttt{a\_b}` 在 MathJax 里转义易出错、渲染失败。正确做法是把这类代码名移到公式**外面**用 HTML `<code>` 标签，公式内只用单字母/标准记号（如把 `beta_bias` 记为 $b$，再在正文说明"$b$ 即 `beta_bias`"）。
- **编辑模型 = Jupyter**：cell 默认渲染，双击或点 ✎ 进入编辑，失焦 / Shift+Enter 渲染回去。每 cell 右上角仅 `×` 删除，左侧 `⠿` 拖动重排。**加 cell 是 Jupyter 式**：cell 之间平时只有一条细线，双击该处才弹出 `+ Markdown`/`+ 表格`（无 +HTML，用户不手写 HTML）；顶部工具栏只有「保存到文件」「复制 Markdown」。Ctrl+S 也能保存。
- **所见即所得落盘**：顶部「保存到文件」把当前内容 POST 到预览服务器 `/__save`（`{path, seed:[...]}`），服务器只替换文件里 `<script id="seed" type="application/json">…</script>` 的内容。用户改完点保存，磁盘 HTML 即更新，Claude 直接读该文件即可、无需复制粘贴。顶部「复制 Markdown」导出整本。

用法：复制 `templates/notebook.html`，**只改 `<script id="seed">` 里的 JSON 数组**为本次真实内容（Claude 的产出用 `html` 块 + `table`/TBL，表格一律用 TBL cell，不放 `md`）。用户的 md cell = 需求，要用 HTML 实现它。其余壳与两行 `/__assets/` 引用原样保留。需要纯静态图示/单图时才不套 notebook。引擎本身要改进就改 `assets/notebook.{js,css}`，所有产物自动生效。

## 设计 token（粘进 `<style>:root{}`）

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

## 排版与基调
- `body{background:var(--ivory);color:var(--g700);font-family:var(--sans);line-height:1.55}`；内容包在 `.page{max-width:1120px(网格用1360px);margin:0 auto;padding:56px 32px 96px}`。
- 标题用 `--serif`、weight 500、`letter-spacing:-0.01em`、颜色 `--slate`；代码/标签用 `--mono`。
- 强调色 `--clay`（唯一暖色焦点：激活态、关键数字、左边框 callout）。`--olive`=好/pro，`--clay`=坏/con。边框 `1.5px solid var(--g300)`，圆角 8–14px。
- 卡片：白底、`1.5px solid --g300`、圆角 12–14px、padding 18–24px。
- 代码面板：深色 `--slate` 底、`#E8E6DE` 字、mono；手工高亮 span：`.kw{--clay} .str{--olive} .cm{--g500} .fn{#C9B98A}`。

## 可复用组件
- **eyebrow** — h1 上方的小号 mono 大写 `--g500` 眉标。
- **prompt-box** — `--g100` 圆角盒，回显用户需求，带 mono "PROMPT" 标签。
- **并排对比** — `display:grid;grid-template-columns:repeat(N,1fr);gap:28px`，窄屏(~1100px)塌成 1 列。让用户"指一个"而非记忆。
- **pro/con 表** — 2 列网格，pro 前 olive 圆点、con 前 clay 圆点。
- **chips** — 小号 mono 药丸，放指标（体积、可测性…）。
- **推荐 callout** — `border-left:4px solid var(--clay)`、白底，给结论。
- **toc pills** — 圆角药丸锚点链接，导航长页。
- **模块图 / 流程图** — 内联 `<svg>` 盒子+箭头，热路径用 `--clay`。
- **折叠** — 原生 `<details>/<summary>`，无需 JS。
- **幻灯片** — 每页一个 `<section>` + ~20 行 JS 方向键导航。
- **自定义编辑器** — 必带"导出"按钮，把 UI 状态转回可粘贴的 markdown/diff/JSON。

## 任务 → 形态映射
探索/计划→并排方案+时间线 · 代码审查→带批注 diff / 模块图 svg · 设计→token 色板+组件表 · 原型→带滑块的动效 / 可点击流程 · 图表→内联 svg · 报告→彩色时间线+小柱状图 · 研究→`<details>`+标签页+术语表 · 编辑→一次性编辑器+导出按钮。

出处：https://thariqs.github.io/html-effectiveness/
