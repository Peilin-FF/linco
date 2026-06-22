#!/usr/bin/env python3
# Linco shadow-diff 诊断脚本(独立运行,逻辑与 linco_agent.py 完全对称)。
#
# 用途:排查「发了消息但文件界面不显示本轮改动」。它会打印:
#   1) 该工作目录对应的影子仓库路径(FNV1a 哈希)、基线 commit 是否存在
#   2) 影子仓库当前算出的「本轮改动」(git diff --cached --name-status HEAD)
#   3) 若指定了某个「没显示的文件」,逐项说明它为什么被收录 / 被排除
#      (扩展名白名单 / 跳过目录 / 1MB 上限 / 不在工作目录内 / 是软链)
#
# 用法:
#   python3 shadow_diag.py <工作目录绝对路径> [可选:没显示的那个文件的绝对路径]
# 例(远程):
#   python3 shadow_diag.py /workspace/cloud_android/fengpeilin/MAS /workspace/.../某文件
#
# 注意:在【文件所在的那台机器】上跑——本地项目在本机跑,远程项目 ssh 到远端跑。

import os, sys, subprocess

# —— 与 linco_agent.py 一致的常量(若 app 侧改了,这里也要同步)——
SHADOW_SKIP_DIRS = {
    ".git", "node_modules", "target", "__pycache__", ".venv", "venv", "env", "dist", "build",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode", ".cache",
    "site-packages", "swanlog", "wandb", "outputs",
}
SNAPSHOT_EXTS = {
    ".py", ".pyi", ".pyx", ".ipynb", ".json", ".jsonl", ".md", ".markdown", ".rst", ".txt",
    ".yaml", ".yml", ".toml", ".cfg", ".ini", ".conf", ".env", ".properties",
    ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".css", ".scss", ".less", ".html", ".htm", ".xml", ".svg",
    ".c", ".h", ".cpp", ".cc", ".hpp", ".rs", ".go", ".java", ".kt", ".rb", ".php",
    ".lua", ".sql", ".graphql", ".proto", ".tex", ".csv", ".tsv",
    ".gradle", ".cmake", ".mk", ".r", ".jl", ".scala", ".swift", ".m", ".mm",
}
SNAPSHOT_NAMES = {
    "Dockerfile", "Makefile", "makefile", "CMakeLists.txt", "Justfile", "justfile",
    "README", "LICENSE", "Procfile", ".gitignore", ".dockerignore", ".env", "requirements.txt",
}
MAX_SNAPSHOT_FILE = 1024 * 1024  # 1MB


def fnv1a(s):
    h = 0xcbf29ce484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return "%016x" % h


def shadow_dir(repo):
    home = os.environ.get("HOME", "/tmp")
    # 远程 agent 用 ~/.linco;本地 dev 也是 ~/.linco,release 是 ~/.linco-app
    cands = [os.path.join(home, ".linco", "shadows", fnv1a(repo)),
             os.path.join(home, ".linco-app", "shadows", fnv1a(repo))]
    for c in cands:
        if os.path.isdir(c):
            return c
    return cands[0]  # 不存在也返回首选,供下面报告"基线缺失"


def git(gitdir, repo, args):
    cmd = ["git", "--git-dir=" + gitdir, "--work-tree=" + repo,
           "-c", "core.hooksPath=", "-c", "commit.gpgsign=false"] + args
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def why_excluded(repo, f):
    # 返回 (是否会被收录, 原因说明)
    if not os.path.exists(f):
        return False, "文件不存在(可能已被删/路径错)"
    real_repo = os.path.realpath(repo).rstrip("/")
    real_f = os.path.realpath(f)
    if not real_f.startswith(real_repo + "/"):
        return False, "不在工作目录(cwd)内:cwd=%s" % real_repo
    rel = real_f[len(real_repo) + 1:]
    # 逐级目录检查 skip
    parts = rel.split("/")
    for d in parts[:-1]:
        if d in SHADOW_SKIP_DIRS or d.endswith(".egg-info"):
            return False, "路径里有被跳过的目录:'%s'(SHADOW_SKIP_DIRS)" % d
    # venv 探测:任一父目录含 pyvenv.cfg
    cur = os.path.dirname(real_f)
    while cur.startswith(real_repo):
        if os.path.exists(os.path.join(cur, "pyvenv.cfg")):
            return False, "父目录是 venv(含 pyvenv.cfg):%s" % cur
        if cur == real_repo:
            break
        cur = os.path.dirname(cur)
    if os.path.islink(f):
        return False, "是符号链接(shadow 不跟随软链)"
    name = os.path.basename(real_f)
    ext = ("." + name.rsplit(".", 1)[1].lower()) if "." in name else ""
    wanted = ext in SNAPSHOT_EXTS or name in SNAPSHOT_NAMES
    if not wanted:
        return False, "扩展名/文件名不在白名单:name='%s' ext='%s'(不在 SNAPSHOT_EXTS/NAMES)" % (name, ext)
    try:
        sz = os.path.getsize(real_f)
    except OSError:
        return False, "无法读取大小"
    if sz > MAX_SNAPSHOT_FILE:
        return False, "文件 > 1MB(%d 字节,上限 %d)" % (sz, MAX_SNAPSHOT_FILE)
    return True, "应被收录(name='%s' ext='%s' size=%d)" % (name, ext, sz)


def main():
    if len(sys.argv) < 2:
        print("用法: python3 shadow_diag.py <工作目录绝对路径> [没显示的文件绝对路径]")
        sys.exit(1)
    repo = os.path.realpath(sys.argv[1]).rstrip("/")
    target = sys.argv[2] if len(sys.argv) > 2 else None

    print("===== LINCO SHADOW 诊断(把以下整段复制给我)=====")
    print("工作目录 repo =", repo)
    print("repo 哈希     =", fnv1a(repo))
    gd = shadow_dir(repo)
    print("影子仓库目录   =", gd)
    has_head = os.path.exists(os.path.join(gd, "HEAD"))
    print("影子仓库存在?  =", has_head)

    if has_head:
        rc, out, err = git(gd, repo, ["log", "--oneline", "-3"])
        print("--- 最近基线 commit(应有 linco-turn-baseline)---")
        print(out.strip() or "(无 commit!基线从未建立)")
        if err.strip():
            print("[git log stderr]", err.strip()[:300])

        # 重新 stage 后算本轮改动(等价 shadow_changed)
        idx = os.path.join(gd, "linco-diag-index")
        env_git = ["git", "--git-dir=" + gd, "--work-tree=" + repo,
                   "-c", "core.hooksPath=", "-c", "commit.gpgsign=false"]
        os.environ["GIT_INDEX_FILE"] = idx
        # 用持久 index 的内容做基础:先 read-tree HEAD,再 add -A(简化:直接 add -u + add -f 收录文件)
        subprocess.run(env_git + ["read-tree", "HEAD"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        rc, out, err = git(gd, repo, ["diff", "--cached", "--name-status", "HEAD"])
        # 注:这里只读已有 index 的 diff;真实 app 会先 stage_snapshot。下面单独验证 target。
        print("--- 当前 index 相对基线的改动(name-status)---")
        print(out.strip() or "(空 —— 当前 index 与基线一致)")
        try:
            os.remove(idx)
        except OSError:
            pass
        del os.environ["GIT_INDEX_FILE"]
    else:
        print(">>> 基线不存在:说明这个工作目录从没成功建过影子仓库。")
        print(">>> 可能原因:发消息时 cwd 为空、或 shadow_begin 在远端失败。")

    if target:
        t = os.path.realpath(target)
        print("--- 指定文件为何不显示 ---")
        print("文件 =", t)
        print("磁盘存在?=", os.path.exists(t))
        ok, reason = why_excluded(repo, target)
        print("会被 shadow 收录? =", ok)
        print("判定 =", reason)
        # 它在基线里有记录吗 / git 眼里改了吗
        if has_head:
            rel = t[len(repo) + 1:] if t.startswith(repo + "/") else t
            rc, out, err = git(gd, repo, ["ls-files", "--", rel])
            print("基线是否跟踪此文件? =", "是" if out.strip() else "否(基线里没有它 → 改了也无对比锚点)")
            rc, out, err = git(gd, repo, ["diff", "--name-status", "HEAD", "--", rel])
            print("相对基线 git 看改了吗:", out.strip() or "(无变化或未跟踪)")
    print("===== 诊断结束 =====")


if __name__ == "__main__":
    main()
