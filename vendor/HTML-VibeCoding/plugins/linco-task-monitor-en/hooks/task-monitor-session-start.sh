#!/usr/bin/env bash
# linco-task-monitor (EN) SessionStart hook: inject the "background task monitor" workflow rule.
# Pure guidance, no side effects (no server, touches no files). Tells the agent: when running
# long background tasks inside Linco, start them with "-u + redirect to an in-project .log + &"
# so Linco's terminal monitor panel can show them live.
set -euo pipefail

CTX="[Linco background task monitor] You are very likely running inside Linco (a desktop app that drives code agents). Its Terminal view has a background-task monitor panel that automatically surfaces the long tasks you launch (training / eval / data processing) as live, scrolling terminal tabs, so the user can watch progress and logs in real time. For your background task to be captured and visualized, it must satisfy three conditions:\
1) Output goes to a file — redirect stdout/stderr to a log file under the working directory, e.g. \`python -u train.py > train.log 2>&1 &\` (always use -u or flush, otherwise output is buffered and the user sees no live updates); never let a long task's output go straight to a pipe (a bare \`cmd &\` with no redirect), as there is then no file to read and nothing to monitor.\
2) Working directory is inside the project — the task's cwd must be the current project directory (or a subdirectory); the monitor anchors on this. Just launch it from within the project directory.\
3) Use a real program name — the monitor filters out pure shell wrappers and short-lived tools (sh/head/grep/sleep, etc.); real long tasks like training/eval show up normally with no special handling.\
Therefore: whenever you run training, eval, or long data processing in the background, default to launching with '\`-u\` + redirect to an in-project .log file + background &', so the user can see in the Linco terminal, in real time, what you are doing in the background. This is the key to turning the background black box transparent — please follow it proactively."

# Emit additionalContext as valid JSON.
if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$CTX" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$ctx}}'
else
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$CTX"
fi
