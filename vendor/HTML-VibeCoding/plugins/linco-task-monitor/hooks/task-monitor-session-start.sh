#!/usr/bin/env bash
# linco-task-monitor SessionStart hook:注入「后台任务监控」工作流指令。
# 纯说明,无副作用(不起服务器、不碰文件)。让 agent 知道:在 Linco 里跑后台长任务时,
# 用「-u + 重定向到项目内 .log + 后台 &」启动,Linco 终端的监控面板才能实时显示。
set -euo pipefail

CTX="【Linco 后台任务监控】你很可能运行在 Linco（一个驱动 code agent 的桌面端）里——它的「终端」视图有一个后台任务监控面板,会自动把你起的长任务(训练/评测/数据处理)显示成实时滚动的终端 tab,让用户能实时看到进度与日志。要让你的后台任务被它捕获并可视化,起任务时必须满足三个条件:\
1) 输出落盘成文件——把 stdout/stderr 重定向到工作目录下的日志文件,如 \`python -u train.py > train.log 2>&1 &\`(务必带 -u 或 flush,否则输出被缓冲、用户看不到实时更新);绝不要让长任务的输出直接进管道(裸 \`cmd &\` 不重定向),那样无文件可读、监控不到。\
2) 工作目录在项目内——任务的 cwd 必须落在当前项目目录(或其子目录)下,监控靠此锚定;在项目目录里启动即可。\
3) 用真实程序名——监控会过滤掉纯 shell 外壳与一闪而过的短命工具(sh/head/grep/sleep 等);训练/评测这类真实长任务正常显示,无需特殊处理。\
因此:每当你要在后台跑训练、评测、长数据处理时,默认用「\`-u\` + 重定向到项目内 .log 文件 + 后台 &」的方式启动,这样用户在 Linco 终端里就能实时看到你在后台干什么。这是把后台盲盒变透明的关键,请主动遵循。"

# Emit additionalContext as valid JSON.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CTX"
fi
