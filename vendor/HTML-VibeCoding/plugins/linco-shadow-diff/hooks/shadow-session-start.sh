#!/usr/bin/env bash
# linco-shadow-diff SessionStart hook:注入「本轮 agent 改动 diff」工作流说明。
# 纯说明 + 指向同插件的 shadow.sh CLI。影子仓库逻辑由 Linco 应用(自动)与 shadow.sh(手动)
# 共用,完全互通。无副作用(不起服务器、不建基线;基线由用户发消息时 Linco 自动拍)。
set -euo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
SHADOW="$PLUGIN_ROOT/hooks/shadow.sh"

CTX="【Linco 本轮改动 diff(shadow diff)】Linco 有一个「本轮 agent 改动」可视化:用户每次在对话框给你发消息时,Linco 会自动在 ~/.linco/shadows/<工作目录哈希>/ 建一个**独立 git 影子仓库**(与项目自己的 .git 完全无关)拍下「这一轮开始前」的基线;之后你改文件,Linco 文件树就自动标 A/M/D、点开文件显红绿 diff。**这套是自动的,正常情况下你无需做任何事**——用户发消息=自动建基线,你改文件=自动显示。它只收人类会手改的源码/文本/配置(<1MB),自动跳过 venv、日志、模型权重等产物,所以不会因大目录卡顿。\
你也可以**主动调用**这个能力(脚本:${SHADOW},影子仓库与 Linco 应用共用、完全互通):\`bash \"${SHADOW}\" begin\` 拍/重置本轮基线;\`bash \"${SHADOW}\" changed\` 列出本轮改过的文件(A/M/D);\`bash \"${SHADOW}\" diff <文件>\` 看某文件本轮的红绿 diff;\`bash \"${SHADOW}\" status\` 查基线信息。默认在项目根目录运行(或用 \`LINCO_REPO=<abs>\` 指定)。\
何时主动用:① 用户问「这一轮你改了什么/给我看 diff」时,跑 changed/diff 给出确切清单;② 你在终端里直接干活(没走对话框、因而没自动建基线)、却希望用户能在文件树看到本轮标记时,先 begin 再开始改;③ 想确认某次改动是否被正确捕获时用 status/changed 自查。注意 begin 会重置基线(开启新一轮),不要在用户一轮对话中途反复 begin,否则会把本轮已有的改动从 diff 里抹掉。"

# Emit additionalContext as valid JSON.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CTX"
fi
