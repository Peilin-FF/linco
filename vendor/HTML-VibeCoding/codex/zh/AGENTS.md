<!-- LINCO:BEGIN (由 Linco 管理,请勿手动编辑此区块) -->
# Linco 工作环境约定

你正运行在 **Linco**(一个驱动 code agent 的桌面端)里。下面三条约定每次会话都生效。

## 1. 实质性产物默认产出自包含 HTML
对于实质性产物(多方案对比、实现计划、代码审查、图表/流程图、状态/实验报告、概念讲解、原型),默认产出**单个自包含的 `.html` 文件**到当前项目的 `artifacts/` 目录(内联全部 CSS/JS/SVG,无构建步骤,可直接在浏览器打开)。用户在 Linco 预览页实时查看(热刷新)。
- **优先用 Notebook 骨架**:内容型产物基于 html-kit skill 的 `templates/notebook.html` —— 薄壳 + `<script id="seed">` 里的 JSON 内容数组,渲染引擎由 Linco 预览服务器在 `/__assets/notebook.{css,js}` 提供。
- **当要产出 HTML / 做 notebook / 用设计组件时,先读 `~/.codex/skills/html-kit/SKILL.md`**:里面有完整设计套件(配色 token、排版)、cell 约定、现成组件清单(card/callout/stat-grid/procon/file-diff/timeline/review/badge 等,直接写 class 即可)、以及「就地答复用户 md 需求」的工作流。
- 解释性内容写进 HTML 本身;终端只回一句:路径 + 一句话要点。

## 2.「本轮改动」可视化(shadow diff)
用户每次给你发消息时,Linco 会用独立影子 git(与项目 .git 无关)自动拍「本轮开始前」基线;你改文件后,Linco 文件树自动标 A/M/D、点开显红绿 diff。**通常全自动,你无需做任何事。** 需要时可调 CLI:`bash ~/.codex/skills/html-kit/shadow.sh begin|changed|diff <文件>|status`(在项目根目录跑)。用户问「这一轮改了什么」时跑 `changed`/`diff` 给确切清单。注意 `begin` 会重置基线,别在一轮中途反复调。

## 3. 后台长任务必须可监控
在 Linco 里跑训练/评测/长数据处理时,用「`-u` + 重定向到项目内 `.log` 文件 + 后台 `&`」启动(如 `python -u train.py > train.log 2>&1 &`),Linco 终端监控面板才能实时显示进度;cwd 必须在项目内;用真实程序名。绝不让长任务输出直接进管道(无文件可读=监控不到)。
<!-- LINCO:END -->
