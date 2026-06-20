<!-- LINCO:BEGIN (由 Linco 管理,请勿手动编辑此区块) -->
# Linco 工作环境约定

你正运行在 **Linco**(一个驱动 code agent 的桌面端)里。下面三条约定每次会话都生效。

## 1. 实质性产物默认产出自包含 HTML
对于实质性产物(多方案对比、实现计划、代码审查、图表/流程图、状态/实验报告、概念讲解、原型),默认产出**单个自包含的 `.html` 文件**到当前项目的 `artifacts/` 目录(内联全部 CSS/JS/SVG,无构建步骤,可直接在浏览器打开)。用户在 Linco 预览页实时查看(热刷新)。
- **用户一说「用 HTML」就默认走本套 notebook 模板**:当用户显式要求「用 HTML」「做个网页/页面」「出个 HTML 介绍」时,本约定**无条件优先生效**——直接复制 html-kit 的 `templates/notebook.html` 薄壳,只填 `<script id="seed">` 里的 JSON 内容数组(cell 列表)。**严禁手搓自带内联渲染引擎的独立 HTML**:那种产物在 Linco 里无法就地编辑 / 保存 / 热刷新,等于丢掉本套件的全部价值。判断标准很简单——产物 `<head>` 里只该有 `/__assets/notebook.css`,`<body>` 末尾只该有 `/__assets/notebook.js` + `HtmlVibeNotebook.mount(...)`,中间是 seed JSON;若你写了大段 `<style>` 或自定义渲染脚本,就是走错了路。
- **优先用 Notebook 骨架**:内容型产物基于 html-kit skill 的 `templates/notebook.html` —— 薄壳 + `<script id="seed">` 里的 JSON 内容数组,渲染引擎由 Linco 预览服务器在 `/__assets/notebook.{css,js}` 提供。
- **当要产出 HTML / 做 notebook / 用设计组件时,先读 `~/.codex/skills/html-kit/SKILL.md`**:里面有完整设计套件(配色 token、排版)、cell 约定、现成组件清单(card/callout/stat-grid/procon/file-diff/timeline/review/badge 等,直接写 class 即可)、以及「就地答复用户 md 需求」的工作流。
- 解释性内容写进 HTML 本身;终端只回一句:路径 + 一句话要点。

## 2.「本轮改动」可视化(shadow diff)必须主动触发
只要本轮可能会改文件,在第一次写文件/运行格式化/生成产物之前,必须先在项目根目录拍一次 shadow 基线:
```bash
if [ -x ~/.codex/skills/html-kit/shadow.sh ]; then
  bash ~/.codex/skills/html-kit/shadow.sh begin
elif [ -x vendor/HTML-VibeCoding/codex/zh/skills/html-kit/shadow.sh ]; then
  bash vendor/HTML-VibeCoding/codex/zh/skills/html-kit/shadow.sh begin
elif [ -x vendor/HTML-VibeCoding/codex/en/skills/html-kit/shadow.sh ]; then
  bash vendor/HTML-VibeCoding/codex/en/skills/html-kit/shadow.sh begin
fi
```
规则:
- 每个用户回合最多主动 `begin` 一次;不要在一轮中途反复调,否则会重置基线。
- 改完文件后,必要时运行 `changed` 或 `status` 自检;用户问「这一轮改了什么」时必须运行 `changed`/`diff <文件>` 给确切清单。
- 如果 `~/.codex/skills/html-kit/shadow.sh` 尚未安装,优先使用本仓库 `vendor/HTML-VibeCoding/codex/.../shadow.sh` 回退路径。

## 3. 后台长任务必须可监控
在 Linco 里跑训练/评测/长数据处理/长 dev server 时,必须让后台程序 watcher 能发现:
- cwd 必须在项目目录内。
- 使用真实程序名启动,不要把长任务藏在复杂管道里。
- Python 必须加 `-u`;所有长任务输出必须重定向到项目内 `.log` 文件;命令最后加 `&` 放后台。
- 启动后在终端回显 PID 与日志路径,便于用户和 Linco 监控面板定位。

推荐模板:
```bash
python -u train.py > train.log 2>&1 &
echo $! > train.pid
```
不要让长任务以前台方式占住交互,也不要只输出到管道/stdout(无文件可读=watcher 监控不到)。
<!-- LINCO:END -->
