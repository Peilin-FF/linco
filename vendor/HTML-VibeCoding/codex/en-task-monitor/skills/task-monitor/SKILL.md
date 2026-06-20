---
name: task-monitor
description: Use when running background long tasks (training/eval/long data processing/dev servers) inside Linco, so Linco's terminal background-task monitor can capture and show them live.
---

# Linco Background Task Monitor

You are likely running inside **Linco** (a desktop app driving code agents). Its "Terminal" view has a **background-task monitor panel** that automatically surfaces your long-running tasks as live, scrolling terminal tabs so the user sees progress and logs in real time.

For your background task to be captured and visualized, satisfy three conditions when launching it:

1. **Redirect output to a file** — send stdout/stderr to a log file in the working directory, e.g. `python -u train.py > train.log 2>&1 &` (always use `-u` or flush, otherwise output is buffered and the user sees no live updates). Never let a long task stream only to a pipe (bare `cmd &` with no redirect) — no readable file means nothing to monitor.
2. **Keep the cwd inside the project** — the task's cwd must be within the current project directory (or a subdir); monitoring anchors on this.
3. **Use a real program name** — the monitor filters out plain shells and short-lived tools (sh/head/grep/sleep…); real long tasks like training/eval show normally.

Recommended template:
```bash
python -u train.py > train.log 2>&1 &
echo $! > train.pid
```

So whenever you run training, eval, or long data processing in the background, **default to launching with `-u` + redirect to an in-project `.log` + trailing `&`**, and echo the PID and log path. This is the key to making the background transparent — follow it proactively.
