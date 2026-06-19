#!/usr/bin/env bash
# Linco shadow-diff CLI —— 让 agent 能主动操作「本轮改动」影子仓库。
#
# 背景:Linco 桌面端有个「本轮 agent 改动」功能:用户在对话框发消息那一刻,Linco 会自动在
#   ~/.linco/shadows/<工作目录哈希>/ 建一个**独立 git 影子仓库**(与项目自己的 .git 完全无关),
#   拍下「这一轮开始前」的基线;之后你改文件,Linco 文件树就标 M/A/D、点开文件显红绿 diff。
# 这个脚本把同一套逻辑暴露成命令行,让你(agent)在**没有经过 Linco 对话框**的场景下
# (例如你在终端里自己干活、或想主动刷新/查看本轮改动)也能 begin / changed / diff。
# 它操作的影子仓库与 Linco 应用用的是同一个(同一哈希目录、同一筛选规则),完全互通。
#
# 用法:
#   shadow.sh begin              # 拍「本轮基线」(开启新一轮;会覆盖上一轮基线)
#   shadow.sh changed            # 列出本轮改过的文件:  <状态 A/M/D>\t<相对路径>
#   shadow.sh diff <文件路径>     # 某文件本轮的 unified diff(红绿增删)
#   shadow.sh status             # 打印影子仓库位置/基线信息(排障用)
# 工作目录默认取 $PWD;也可用 LINCO_REPO=<abs> 指定。
#
# 设计要点(与 Linco 内置实现一致):
#   - 不读项目 .gitignore;只收人类会手改的源码/文本/配置类型 + <1MB(模型权重/日志/venv 不进)。
#   - venv 探测:含 pyvenv.cfg 的目录整个跳过(.venv/.venv312/env 等变体都挡)。
#   - 增量重置:基线 commit 后保留热 index,changed/diff 用 git add 增量哈希,大目录也秒级。
set -euo pipefail

REPO="${LINCO_REPO:-$PWD}"
REPO="${REPO%/}"

# 与 linco_agent.py 完全一致的 FNV-1a 64 位哈希,保证影子目录与 Linco 应用同一个。
shadow_dir() {
  python3 - "$REPO" <<'PY'
import sys, os
repo = sys.argv[1]
h = 0xcbf29ce484222325
for b in repo.encode("utf-8"):
    h ^= b
    h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
print(os.path.join(os.environ.get("HOME", "/tmp"), ".linco", "shadows", "%016x" % h))
PY
}

GD="$(shadow_dir)"

sgit() { git --git-dir="$GD" --work-tree="$REPO" -c core.hooksPath=/dev/null -c commit.gpgsign=false "$@"; }

ensure_init() {
  if [ ! -e "$GD/HEAD" ]; then
    mkdir -p "$GD"
    sgit init -q
    sgit config user.email linco@local
    sgit config user.name Linco
  fi
}

# 遍历工作目录,收集应纳入快照的文件(NUL 分隔写到 $1)。规则与 linco_agent.py 对称。
collect() {
  python3 - "$REPO" "$1" <<'PY'
import sys, os
repo, out_path = sys.argv[1], sys.argv[2]
SKIP = {".git","node_modules","target","__pycache__",".venv","venv","env","dist","build",
        ".tox",".mypy_cache",".pytest_cache",".ruff_cache",".idea",".vscode",".cache",
        "site-packages","swanlog","wandb","outputs","checkpoints","logs",
        ".ipynb_checkpoints",".conda",".eggs","__MACOSX"}
EXT = {".py",".pyi",".pyx",".ipynb",".json",".jsonl",".md",".markdown",".rst",".txt",
       ".yaml",".yml",".toml",".cfg",".ini",".conf",".env",".properties",
       ".sh",".bash",".zsh",".fish",".ps1",".bat",
       ".ts",".tsx",".js",".jsx",".mjs",".cjs",".vue",".svelte",
       ".css",".scss",".less",".html",".htm",".xml",".svg",
       ".c",".h",".cpp",".cc",".hpp",".rs",".go",".java",".kt",".rb",".php",".lua",
       ".sql",".graphql",".proto",".tex",".csv",".tsv",".gradle",".cmake",".mk",
       ".r",".jl",".scala",".swift",".m",".mm"}
NAMES = {"Dockerfile","Makefile","makefile","CMakeLists.txt","Justfile","justfile",
         "README","LICENSE","Procfile",".gitignore",".dockerignore",".env","requirements.txt"}
MAX = 1024*1024
files = []
for dp, dn, fn in os.walk(repo):
    if "pyvenv.cfg" in fn:
        dn[:] = []; continue
    dn[:] = [d for d in dn if d not in SKIP and not d.endswith(".egg-info")]
    for n in fn:
        if os.path.splitext(n)[1].lower() not in EXT and n not in NAMES:
            continue
        fp = os.path.join(dp, n)
        try:
            if os.path.islink(fp) or os.path.getsize(fp) > MAX:
                continue
        except OSError:
            continue
        files.append(os.path.relpath(fp, repo))
        if len(files) > 100000:
            break
with open(out_path, "wb") as f:
    f.write(b"\0".join(p.encode("utf-8") for p in files))
PY
}

# 增量刷 index 到当前工作区(不清空 → 保留 stat 缓存,大目录秒级)。
stage() {
  local list; list="$GD/linco-stage-cli.$$"
  collect "$list"
  if [ -s "$list" ]; then
    sgit add -f --pathspec-from-file="$list" --pathspec-file-nul || true
  fi
  rm -f "$list"
  sgit add -u || true   # 识别已删除文件 → D
}

rel_of() {  # 把绝对路径转相对 repo
  case "$1" in
    "$REPO"/*) printf '%s' "${1#"$REPO"/}" ;;
    *) printf '%s' "$1" ;;
  esac
}

cmd="${1:-}"
case "$cmd" in
  begin)
    ensure_init
    stage
    sgit commit -q --allow-empty -m linco-turn-baseline
    echo "已拍本轮基线(影子仓库:$GD)。之后的改动可用 'shadow.sh changed' / 'shadow.sh diff <文件>' 查看。"
    ;;
  changed)
    [ -e "$GD/HEAD" ] || { echo "(还没有基线;先运行 shadow.sh begin)"; exit 0; }
    stage
    sgit diff --cached --name-status HEAD
    ;;
  diff)
    [ -n "${2:-}" ] || { echo "用法: shadow.sh diff <文件路径>" >&2; exit 2; }
    [ -e "$GD/HEAD" ] || { echo "(还没有基线;先运行 shadow.sh begin)"; exit 0; }
    stage
    sgit diff --cached --no-color HEAD -- "$(rel_of "$2")"
    ;;
  status)
    echo "工作目录: $REPO"
    echo "影子仓库: $GD"
    if [ -e "$GD/HEAD" ]; then
      echo -n "当前基线: "; sgit log --oneline -1 2>/dev/null || echo "(无 commit)"
    else
      echo "当前基线: (未建立,运行 shadow.sh begin)"
    fi
    ;;
  *)
    cat >&2 <<EOF
Linco shadow-diff —— 查看「本轮 agent 改动」(独立影子 git,与项目 .git 无关)
用法:
  shadow.sh begin            拍本轮基线(开启新一轮)
  shadow.sh changed          列出本轮改过的文件 (A/M/D \\t 路径)
  shadow.sh diff <文件>       某文件本轮 unified diff
  shadow.sh status           影子仓库/基线信息
环境: LINCO_REPO=<abs> 覆盖工作目录(默认 \$PWD)
EOF
    exit 2
    ;;
esac
