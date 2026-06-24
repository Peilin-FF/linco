#!/usr/bin/env bash
# linco-task-monitor PreToolUse hook:强制后台/任意 python 命令无缓冲输出。
#
# 痛点:agent 跑 `python x.py > log &` 不带 -u 时,Python 检测到 stdout 不是终端 → 块缓冲,
# 输出攒在进程内存里不写盘 → Linco 后台任务监控面板 tail 不到、一直冻住,直到进程结束才刷出。
#
# 做法:Bash 工具命令里含 python/python3、且尚未无缓冲时,给整条命令加前缀 `PYTHONUNBUFFERED=1 `。
# 该环境变量让命令内所有 python 子进程行缓冲、立即写盘;对非 python 命令无副作用。
# 不解析/重写命令里的 python(变体太多易误伤),只加前缀,零误伤。
#
# 输出 PreToolUse 的 updatedInput 改写 command;不命中则原样放行。用 python3 解析/生成 JSON
# (命令含引号/中文也不会坏)。

set -euo pipefail

INPUT="$(cat)"

python3 - "$INPUT" <<'PY'
import sys, json, re

try:
    data = json.loads(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1] else {}
except Exception:
    data = {}

def passthrough():
    # 不改写:输出空的 allow(等价于放行,不带 updatedInput)
    print(json.dumps({
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "allow"
        }
    }))
    sys.exit(0)

if data.get("tool_name") != "Bash":
    passthrough()

cmd = (data.get("tool_input") or {}).get("command")
if not isinstance(cmd, str) or not cmd.strip():
    passthrough()

# 命中条件:含 python / python3 这个词(独立词,避免误匹配 pythonic 之类)
if not re.search(r"\bpython3?\b", cmd):
    passthrough()

# 已经无缓冲了就别重复处理:
#  - 已设 PYTHONUNBUFFERED(任意位置)
#  - python 带 -u(python -u / python3 -u)
if "PYTHONUNBUFFERED" in cmd or re.search(r"\bpython3?\s+(?:-\w+\s+)*-u\b", cmd):
    passthrough()

new_cmd = "PYTHONUNBUFFERED=1 " + cmd

print(json.dumps({
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "allow",
        "updatedInput": {"command": new_cmd}
    },
    "systemMessage": "已为 python 命令注入 PYTHONUNBUFFERED=1(让后台输出实时写盘,Linco 监控面板可见)"
}))
PY
