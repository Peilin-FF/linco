#!/usr/bin/env bash
# html-vibe SessionStart hook: ensure the artifacts preview server is running
# for the current project, and inject the "default to HTML artifacts" workflow
# instruction (+ design kit pointer) into session context.
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

CTX="HTML 交互工作流已启用（html-vibe 插件）。\
对于实质性产物（多方案对比、实现计划、代码审查、图表/流程图、状态/实验报告、概念讲解、原型、自定义编辑器等），\
默认产出单个自包含的 .html 文件到 ${ARTIFACTS}/，内联所有 CSS/JS/SVG，使其能直接在浏览器打开（无构建步骤）。\
设计套件：背景 #FAF9F5(ivory)，正文 #3D3D3A，强调色 #D97757(clay)，深色 #141413(slate)，好/对用 #788C5D(olive)、坏/错用 clay；\
标题用 serif(Georgia)、正文 system-ui sans、代码 ui-monospace；卡片白底 1.5px #D1CFC5 边框、圆角 12-14px；\
代码面板深色 slate 底 #E8E6DE 字。常用组件：并排对比网格、pro/con 表、指标 chips、左边框 clay 的推荐 callout、内联 SVG 模块图/流程图、<details> 折叠、<section>+JS 幻灯片；\
自定义编辑器务必带'导出'按钮把 UI 状态转回可粘贴的 markdown/diff/JSON。\
默认用 Notebook 骨架：内容型产物(报告/讲解/对比/计划/实验记录)默认基于 html-kit 技能里的 templates/notebook.html 改造。引擎与内容分离——产物 HTML 是薄壳，渲染/编辑/表格/保存引擎由预览服务器在 /__assets/notebook.{css,js} 提供，所以产物文件小、只含内容，读它时不会被样板淹没。三种 cell（核心分工约定）：{type:html,html} 富 HTML 块(卡片/callout/并排.flex/彩表/代码面板)是 Claude 产出内容的默认形态，所有结论/对比/说明/代码讲解都用 html 块；{type:table,head,rows} 可编辑 TBL 网格，所有表格一律用 TBL cell(不要 markdown 表、不要在 html 块里塞 table)；{type:md,text} 是用户提需求/补充内容的频道、不是交付物——用户在 md cell 写需求，Claude 的职责是把需求用 HTML 块/TBL 实现(不是回显或重排 markdown)，且默认不放 md cell、绝不把自己的产出留成 markdown。编辑模型=Jupyter：cell 默认渲染，双击/✎ 进入编辑，失焦或 Shift+Enter 渲染回去，Ctrl+S 保存；右上角仅 × 删除，左侧 ⠿ 拖动重排；加 cell 是 Jupyter 式——cell 间平时只有细线，双击该处才弹出 +Markdown/+表格(无 +HTML，用户不手写 HTML)，顶部工具栏只有保存/复制。数学公式：文字里直接写 $...$ 行内或 $$...$$ 块级，由 MathJax(插件资源 /__assets，离线)渲染；源码存 LaTeX、编辑可改、存盘也是 LaTeX。公式内只放纯数学，带下划线的代码变量名(如 couple_lambda/beta_bias)不要塞进 LaTeX(\texttt 转义易失败)，移到公式外用 <code> 标签。\
所见即所得落盘：顶部「保存到文件」把当前内容 POST 到 /__save({path,seed:[...]})，服务器只替换文件里 <script id=\"seed\" type=\"application/json\"> 的 JSON。用户改完点保存，磁盘 HTML 即更新，你直接读该文件即可、无需用户复制粘贴。用法：复制模板，只改 <script id=seed> 里的 JSON 数组为真实内容，其余壳与 /__assets/ 引用原样保留。引擎要改进就改插件 assets/notebook.{js,css}，所有产物自动生效。需要纯静态单图时才不套 notebook。\
产物是一次性的，用完即弃，可复用简单文件名。\
重要——把解释性内容放进 HTML：所有论证、对比、权衡、步骤、原理、代码讲解等说明性文字都写进 HTML 文件里（用标题、callout、注释、折叠块等承载），不要在终端里重复复述。\
写完后终端只回一句话：文件名/路径 + 一句话要点（最多再加一条需要用户操作的提示，如复制导出或转发端口）。终端不要列要点、不要粘代码、不要重述 HTML 里已写明的内容。\
预览服务器状态：${SERVING}（端口 ${PORT}）。用户在 VS Code Simple Browser 打开 http://localhost:${PORT}/ 查看，文件改动会自动热刷新（约 1 秒）。\
若预览空白，多半是 VS Code 的 PORTS 面板未转发该端口，简短提示用户转发即可。\
只有极短的对话式问答、或用户明确要求用文字时，才用纯 markdown 回复终端。"

# Emit additionalContext as valid JSON.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  # Fallback without jq: escape minimally (the CTX has no quotes/backslashes/newlines).
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CTX"
fi
