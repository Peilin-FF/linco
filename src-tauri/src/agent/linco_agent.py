#!/usr/bin/env python3
# Linco 远程助手进程(常驻):借鉴 VS Code Remote 的"远端常驻 + RPC"。
#
# 由 Linco 经持久 SSH 管道启动:`python3 ~/.linco/linco_agent.py`。
# 协议:stdin 每行一个请求 JSON,stdout 每行一个响应 JSON(均 UTF-8,无内嵌换行)。
#   请求 {"id":N,"op":"...","args":{...}}
#   响应 {"id":N,"ok":true,"result":...} 或 {"id":N,"ok":false,"error":"..."}
#   推送(无 id,主动)  {"event":"fileChange","paths":[...]}   # 阶段1
# 二进制(读/写字节)用 base64 字段,信道只走 ASCII,二进制安全。
#
# 只依赖标准库(os/sys/json/base64/shutil/subprocess/time/select/threading)。
# 兼容 Python 3.6+(集群常见)。任何 op 抛错 → 返回 ok:false,不崩进程。
# 空闲自退:超过 IDLE_TIMEOUT 无请求即退出,不在集群留垃圾进程。

import sys, os, json, base64, shutil, subprocess, time, threading, queue

AGENT_VERSION = "16"
IDLE_TIMEOUT = 1800  # 30 分钟无请求自退
MAX_BYTES_DEFAULT = 50 * 1024 * 1024
MAX_WORKERS = 8
MAX_QUEUED_REQUESTS = 128

_last_activity = time.time()
_out_lock = threading.Lock()
_request_queue = queue.Queue(MAX_QUEUED_REQUESTS)


def _send(obj):
    line = json.dumps(obj, ensure_ascii=False)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


# ---------- 文件类 op(语义对齐 remote.rs)----------

def _join(d, name):
    return (d.rstrip("/") + "/" + name) if not d.endswith("/") else (d + name)


def op_ping(_a):
    return {"pong": True, "version": AGENT_VERSION}


def op_stat(a):
    p = a["path"]
    st = os.stat(p)
    return {
        "is_dir": os.path.isdir(p),
        "size": st.st_size,
        "mtime": int(st.st_mtime),
    }


def op_readdir(a):
    d = a["path"]
    entries = []
    with os.scandir(d) as it:
        for e in it:
            try:
                is_dir = e.is_dir()
            except OSError:
                is_dir = False
            entries.append({"name": e.name, "path": _join(d, e.name), "is_dir": is_dir})
    # 目录在前,再按名称小写排序(与 remote.rs list_dir 一致)
    entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return {"entries": entries}


def op_read_file(a):
    p = a["path"]
    limit = a.get("max", 5 * 1024 * 1024)
    size = os.path.getsize(p)
    if size > limit:
        raise ValueError("文件过大,无法预览(>%dMB)" % (limit // 1024 // 1024))
    with open(p, "rb") as f:
        data = f.read()
    if b"\x00" in data[:8000]:
        raise ValueError("二进制文件,无法预览")
    try:
        return {"text": data.decode("utf-8")}
    except UnicodeDecodeError:
        raise ValueError("非 UTF-8 文本,无法预览")


def op_read_bytes(a):
    p = a["path"]
    limit = a.get("max", MAX_BYTES_DEFAULT)
    size = os.path.getsize(p)
    if size > limit:
        raise ValueError("文件过大,无法预览(>%dMB)" % (limit // 1024 // 1024))
    with open(p, "rb") as f:
        data = f.read()
    return {"b64": base64.b64encode(data).decode("ascii")}


def op_write_file(a):
    with open(a["path"], "w", encoding="utf-8") as f:
        f.write(a["content"])
    return {}


def op_write_bytes(a):
    data = base64.b64decode(a["b64"])
    with open(a["path"], "wb") as f:
        f.write(data)
    return {}


def op_create_file(a):
    target = _join(a["parent"], a["name"])
    if os.path.exists(target):
        raise ValueError("同名文件已存在")
    # O_EXCL 防竞态覆盖
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    os.close(fd)
    return {"path": target}


def op_mkdir(a):
    target = _join(a["parent"], a["name"])
    os.mkdir(target)
    return {"path": target}


def op_rename(a):
    path = a["path"]
    parent = path.rsplit("/", 1)[0] if "/" in path else ""
    target = _join(parent, a["new_name"])
    if os.path.exists(target):
        raise ValueError("目标已存在")
    os.rename(path, target)
    return {"path": target}


def op_delete(a):
    p = a["path"]
    if os.path.isdir(p) and not os.path.islink(p):
        shutil.rmtree(p, ignore_errors=True)
    else:
        try:
            os.remove(p)
        except FileNotFoundError:
            pass
    return {}


def op_copy(a):
    src = a["src"]
    name = src.rstrip("/").rsplit("/", 1)[-1]
    target = _join(a["dest_dir"], name)
    if os.path.isdir(src):
        shutil.copytree(src, target)
    else:
        shutil.copy2(src, target)
    return {"path": target}


def op_move(a):
    src = a["src"]
    name = src.rstrip("/").rsplit("/", 1)[-1]
    target = _join(a["dest_dir"], name)
    shutil.move(src, target)
    return {"path": target}


SKIP_DIRS = {".git", "node_modules", "target", "__pycache__", ".venv"}


def op_search_files(a):
    root = a["root"]
    q = a["query"].lower()
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for n in filenames:
            if q in n.lower():
                out.append({"name": n, "path": _join(dirpath, n), "is_dir": False})
                if len(out) >= 300:
                    return {"entries": out}
    return {"entries": out}


def _is_git_repo(root):
    try:
        p = subprocess.run(["git", "-C", root, "rev-parse", "--is-inside-work-tree"],
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        return p.returncode == 0 and p.stdout.strip() == b"true"
    except Exception:
        return False


def _search_proc(root, pattern, case_sensitive, is_regex):
    # 决定用什么命令搜内容,返回已 spawn 的 Popen(stdout=PIPE,输出 path:lineno:text)。
    # 策略(借鉴 VS Code,优先快且少噪声):
    #   1) git 仓库 → `git ls-files -z | xargs -0 grep`,只搜【被 git 跟踪的文件】。
    #      跳过 .gitignore 的产物/数据/日志(MAS 实测 33s→1s)。与 VS Code 默认一致。
    #   2) 有 ripgrep → rg(自动遵守 .gitignore、跳二进制/隐藏)。
    #   3) 否则 → grep -r 全量(排除几个重目录),最后兜底。
    # 所有路径输出统一为【绝对路径】的 path:lineno:text(与本地搜索一致,前端按绝对路径打开)。
    if _is_git_repo(root):
        # git ls-files 出相对路径 → 用 sed 补 root 前缀使绝对;grep -nI 出 path:lineno:text
        gi = "i" if not case_sensitive else ""
        gx = "E" if is_regex else "F"
        # 在 root 内执行:列跟踪文件 → xargs 分批 grep。--no-messages 静默无权限/不存在。
        sh = (
            "cd %s && git ls-files -z | "
            "xargs -0 -r grep -nI%s%s --no-messages -e %s -- 2>/dev/null"
            % (_shq(root), gi, gx, _shq(pattern))
        )
        return subprocess.Popen(["sh", "-c", sh], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, cwd=root), True

    rg = shutil.which("rg")
    if rg:
        cmd = [rg, "--line-number", "--no-heading", "--color", "never",
               "--max-filesize", "1M", "--max-columns", "2000"]
        if not case_sensitive:
            cmd.append("-i")
        if not is_regex:
            cmd.append("-F")
        for d in (".git", "node_modules", "target", "__pycache__", ".venv"):
            cmd += ["-g", "!%s" % d]
        cmd += ["-e", pattern, root]
        return subprocess.Popen(cmd, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL), False

    flags = "-rnI"
    if not case_sensitive:
        flags += "i"
    flags += "E" if is_regex else "F"
    cmd = ["grep", flags,
           "--exclude-dir=.git", "--exclude-dir=node_modules",
           "--exclude-dir=target", "--exclude-dir=__pycache__", "--exclude-dir=.venv",
           "-e", pattern, root]
    return subprocess.Popen(cmd, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL), False


def _shq(s):
    return "'" + s.replace("'", "'\\''") + "'"


def _parse_grep_line(line, root, relative):
    # "path:lineno:text" → [abs_path, lineno, text];relative 时给 path 补 root 前缀
    parts = line.split(":", 2)
    if len(parts) == 3 and parts[1].isdigit():
        path = parts[0]
        if relative:
            path = root.rstrip("/") + "/" + path
        return [path, int(parts[1]), parts[2]]
    return None


def op_grep(a):
    # 非流式内容搜索(保留:兼容旧调用)。一次性返回 matches 数组。
    root = a["root"]; pattern = a["pattern"]
    cs = bool(a.get("case_sensitive")); rx = bool(a.get("is_regex"))
    limit = int(a.get("limit") or 3000); timeout_s = float(a.get("timeout") or 20)
    results = []
    deadline = time.time() + timeout_s
    p = None
    relative = False
    try:
        p, relative = _search_proc(root, pattern, cs, rx)
        for raw in iter(p.stdout.readline, b""):
            if time.time() > deadline:
                break
            row = _parse_grep_line(raw.decode("utf-8", "replace").rstrip("\n"), root, relative)
            if row is not None:
                results.append(row)
                if len(results) >= limit:
                    break
    except Exception as e:
        raise ValueError("grep 失败: %s" % e)
    finally:
        _reap(p)
    return {"matches": results}


# 进行中的流式搜索:sid -> Popen(供取消)
_search_procs = {}
_search_lock = threading.Lock()


def _reap(p):
    if p is None:
        return
    for fn in (lambda: p.kill(), lambda: p.stdout.close(), lambda: p.wait(timeout=2)):
        try:
            fn()
        except Exception:
            pass


def op_grep_stream(a, rid):
    # 流式内容搜索(借鉴 VS Code 边搜边返回)。自开线程跑,不占 RPC worker 池;
    # 边读子进程输出边按批 emit,结束用 rid 回 RPC 响应关闭这次调用。
    t = threading.Thread(target=_grep_stream_run, args=(a, rid),
                         name="linco-search", daemon=True)
    t.start()


def _grep_stream_run(a, rid):
    #   - event "searchMatch" {sid, rows:[[path,lineno,text],...]}  分批推
    #   - event "searchDone"  {sid, count, hitLimit}                结束
    #   - 最后用 rid 回一个 RPC 响应(ok)关闭这次调用
    # 提前停止:达 limit 立即 kill;到 timeout 也停。sid 用于前端关联 + 取消。
    root = a["root"]; pattern = a["pattern"]
    cs = bool(a.get("case_sensitive")); rx = bool(a.get("is_regex"))
    limit = int(a.get("limit") or 3000); timeout_s = float(a.get("timeout") or 20)
    sid = a.get("sid")
    if not pattern:
        _send({"event": "searchDone", "sid": sid, "count": 0, "hitLimit": False})
        _send({"id": rid, "ok": True, "result": {"sid": sid}})
        return

    count = 0
    hit_limit = False
    deadline = time.time() + timeout_s
    batch = []
    last_flush = time.time()
    p = None
    relative = False
    try:
        p, relative = _search_proc(root, pattern, cs, rx)
        with _search_lock:
            _search_procs[sid] = p
        for raw in iter(p.stdout.readline, b""):
            now = time.time()
            if now > deadline:
                break
            row = _parse_grep_line(raw.decode("utf-8", "replace").rstrip("\n"), root, relative)
            if row is None:
                continue
            batch.append(row)
            count += 1
            # 攒够 50 条 或 距上次推 >120ms 就 flush 一批(避免每条一个 event)
            if len(batch) >= 50 or (now - last_flush) > 0.12:
                _send({"event": "searchMatch", "sid": sid, "rows": batch})
                batch = []
                last_flush = now
            if count >= limit:
                hit_limit = True
                break
    except Exception:
        pass  # 流式搜索不抛错:已推的结果有效,末尾照常发 searchDone
    finally:
        if batch:
            _send({"event": "searchMatch", "sid": sid, "rows": batch})
        with _search_lock:
            _search_procs.pop(sid, None)
        _reap(p)
    _send({"event": "searchDone", "sid": sid, "count": count, "hitLimit": hit_limit})
    _send({"id": rid, "ok": True, "result": {"sid": sid, "count": count}})


def op_search_cancel(a):
    # 取消进行中的流式搜索(kill 其子进程)
    sid = a.get("sid")
    with _search_lock:
        p = _search_procs.get(sid)
    if p is not None:
        try:
            p.kill()
        except Exception:
            pass
    return {"ok": True}


def op_git(a):
    # 在 repo 目录跑 git,返回 stdout/stderr/code(不抛错,由调用方按 code 判断)
    repo = a["repo"]
    args = a.get("args") or []
    env = os.environ.copy()
    for key, value in (a.get("env") or {}).items():
        env[str(key)] = str(value)
    timeout = float(a.get("timeout") or 180)
    try:
        p = subprocess.run(
            ["git", "-C", repo] + list(args),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, timeout=timeout,
        )
        return {
            "stdout": p.stdout.decode("utf-8", "replace"),
            "stderr": p.stderr.decode("utf-8", "replace"),
            "code": p.returncode,
        }
    except FileNotFoundError:
        raise ValueError("git 未安装")


    except subprocess.TimeoutExpired:
        raise ValueError("git operation timed out")


# ---------- 影子快照(本轮 agent 改动):与项目 git 无关的独立影子仓库 ----------
# 语义与本地 shadow.rs 完全对称:在 $HOME/.linco/shadows/<repo哈希>/ 建独立 git 仓库,
# work-tree 指向工作目录。关键:**不读项目 .gitignore**(自己遍历筛选 + git add -f),
# 这样 agent 的临时产物(artifacts、被项目忽略的小文件)也能监控;同时**跳过噪声目录与
# 大文件**(模型权重动辄上 GB,绝不能纳入,否则影子 git 会卡死/爆盘)。

SHADOW_SKIP_DIRS = {
    ".git", "node_modules", "target", "__pycache__", ".venv", "venv", "env", "dist", "build",
    ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".idea", ".vscode", ".cache",
    "site-packages", "swanlog", "wandb", "outputs", "checkpoints", "logs", ".ipynb_checkpoints",
    ".conda", ".eggs", "__MACOSX",
}
SHADOW_MAX_FILE = 1024 * 1024  # 1MB:超过则不纳入(不标记、不 diff)
# 只收人类会手改的源码/文本/配置类型;venv 库、模型权重、数据产物等一律不进影子。
SHADOW_EXTS = {
    ".py", ".pyi", ".pyx", ".ipynb", ".json", ".jsonl", ".md", ".markdown", ".rst", ".txt",
    ".yaml", ".yml", ".toml", ".cfg", ".ini", ".conf", ".env", ".properties",
    ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat",
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte",
    ".css", ".scss", ".less", ".html", ".htm", ".xml", ".svg",
    ".c", ".h", ".cpp", ".cc", ".hpp", ".rs", ".go", ".java", ".kt", ".rb", ".php", ".lua",
    ".sql", ".graphql", ".proto", ".tex", ".csv", ".tsv", ".dockerfile", ".gitignore",
    ".gradle", ".cmake", ".mk", ".r", ".jl", ".scala", ".swift", ".m", ".mm",
}
# 无扩展名但人类常改的文件名(Dockerfile/Makefile 等)
SHADOW_NAMES = {
    "Dockerfile", "Makefile", "makefile", "CMakeLists.txt", "Justfile", "justfile",
    "README", "LICENSE", "Procfile", ".gitignore", ".dockerignore", ".env",
    "requirements.txt",
}

# 临时文件唯一序号:agent 是单进程多线程(MAX_WORKERS),os.getpid() 在并发线程间相同,
# 会导致临时 index / 列表文件名冲突 → 并发的 changed/diff 互相踩 index(全删/空 index bug)。
# 用进程级原子自增序号 + 线程 id 保证每次调用的临时文件名全局唯一。
_shadow_seq = [0]
_shadow_seq_lock = threading.Lock()


def _shadow_uniq():
    with _shadow_seq_lock:
        _shadow_seq[0] += 1
        n = _shadow_seq[0]
    return "%d-%d" % (threading.current_thread().ident or 0, n)


def _shadow_fnv1a(s):
    h = 0xcbf29ce484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return "%016x" % h


def _shadow_dir(repo):
    home = os.environ.get("HOME", "/tmp")
    return os.path.join(home, ".linco", "shadows", _shadow_fnv1a(repo))


def _shadow_git(repo, gitdir, args, index_file=None):
    # 用 --git-dir/--work-tree 把影子仓库与项目 git 隔离;关掉 hooks/gpg 保证干净快速。
    # index_file:指定独立 index(GIT_INDEX_FILE),让 changed/diff 用临时 index 算,
    # 不动持久 index —— 避免「清空 index→重 add」的空窗期被并发调用读到空 index(全 D bug)。
    full = [
        "git",
        "--git-dir=" + gitdir,
        "--work-tree=" + repo,
        "-c", "core.hooksPath=/dev/null",
        "-c", "commit.gpgsign=false",
        # core.quotePath=false:默认 git 会把非 ASCII 路径(中文文件名/目录)八进制转义并加双引号
        # 输出(如 "\346\265\...")。diff --name-status 一旦被转义,文件树用它当 map key 就匹配不上
        # 真实 entry.path → 文件树不标 M/A/D(而 diff 走 `-- <path>` 传真实路径,不受影响,所以
        # 「远端右侧 diff 正常、左侧文件树无标记」)。关掉它,name-status 才输出原始 UTF-8 路径。
        "-c", "core.quotePath=false",
    ] + list(args)
    env = dict(os.environ)
    if index_file is not None:
        env["GIT_INDEX_FILE"] = index_file
    # cwd=repo:git 的 pathspec 相对**进程 cwd** 解析(不是 --work-tree)。agent 进程 cwd 通常是
    # $HOME,不设就会 "pathspec 'index.html' did not match" → 顶层文件进不了快照。设成 work-tree 根。
    p = subprocess.run(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                       env=env, cwd=repo)
    return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def _shadow_ensure_init(repo):
    gitdir = _shadow_dir(repo)
    head = os.path.join(gitdir, "HEAD")
    if not os.path.exists(head):
        os.makedirs(gitdir, exist_ok=True)
        _shadow_git(repo, gitdir, ["init", "-q"])
        _shadow_git(repo, gitdir, ["config", "user.email", "linco@local"])
        _shadow_git(repo, gitdir, ["config", "user.name", "Linco"])
    return gitdir


def _shadow_collect(repo):
    # 遍历工作目录,收集应纳入快照的文件(相对路径)。不读 .gitignore。
    # 三重筛选,把噪声挡在外面(否则 venv/日志/产物动辄几万文件,首次哈希撞超时):
    #   1) 跳 venv:目录含 pyvenv.cfg → 整个不进(抓住 .venv/.venv312/env 等所有命名变体)
    #   2) 跳噪声目录 SHADOW_SKIP_DIRS + *.egg-info
    #   3) 只收白名单类型(人类会改的源码/文本/配置)+ 少数无扩展名常见文件,且 <1MB
    root = repo.rstrip("/")
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        if "pyvenv.cfg" in filenames:
            dirnames[:] = []
            continue
        dirnames[:] = [d for d in dirnames
                       if d not in SHADOW_SKIP_DIRS and not d.endswith(".egg-info")]
        for n in filenames:
            ext = os.path.splitext(n)[1].lower()
            if ext not in SHADOW_EXTS and n not in SHADOW_NAMES:
                continue
            fp = os.path.join(dirpath, n)
            try:
                if os.path.islink(fp) or os.path.getsize(fp) > SHADOW_MAX_FILE:
                    continue
            except OSError:
                continue
            out.append(os.path.relpath(fp, root))
        if len(out) > 100000:
            return out
    return out


def _shadow_stage(repo, gitdir):
    # 增量刷新持久 index 到当前工作区状态(绝不清空 → 保留 git 的 stat 缓存,
    # add 只重哈希真正变动的文件,大目录从几十秒降到秒级 = 增量重置,不会爆机器):
    #   1) git add -f <当前文件列表>:纳入新增/修改(强制,绕过 .gitignore)
    #   2) git add -u:只更新已跟踪文件,识别「消失的文件」→ 记录为删除(D)
    # -u 只动已在 index 的文件,不会把 .gitignore 忽略的新目录拉进来,故 .gitignore 安全。
    files = _shadow_collect(repo)
    if files:
        listfile = os.path.join(gitdir, "linco-stage-" + _shadow_uniq())
        with open(listfile, "wb") as f:
            f.write(b"\0".join(p.encode("utf-8") for p in files))
        try:
            _shadow_git(repo, gitdir,
                        ["add", "-f", "--pathspec-from-file", listfile, "--pathspec-file-nul"])
        finally:
            try:
                os.remove(listfile)
            except OSError:
                pass
    _shadow_git(repo, gitdir, ["add", "-u"])


def _shadow_rel(repo, path):
    pref = repo.rstrip("/") + "/"
    return path[len(pref):] if path.startswith(pref) else path


# 每仓库一把锁:begin/changed/diff 共享同一个常驻「热」index(保留 stat 缓存以增量哈希),
# 所以必须串行,避免并发同时改 index 互相踩(空 index → 全 D/全红 bug)。每个操作都已是
# 秒级(增量),串行无性能损失。
_shadow_locks = {}
_shadow_locks_guard = threading.Lock()


def _shadow_lock(repo):
    with _shadow_locks_guard:
        lk = _shadow_locks.get(repo)
        if lk is None:
            lk = threading.Lock()
            _shadow_locks[repo] = lk
        return lk


def op_shadow_begin(a):
    repo = a["repo"]
    gitdir = _shadow_ensure_init(repo)
    with _shadow_lock(repo):
        _shadow_stage(repo, gitdir)
        _shadow_git(repo, gitdir, ["commit", "-q", "--allow-empty", "-m", "linco-turn-baseline"])
    return {}


def op_shadow_changed(a):
    repo = a["repo"]
    gitdir = _shadow_dir(repo)
    if not os.path.exists(os.path.join(gitdir, "HEAD")):
        return {"changed": {}}
    with _shadow_lock(repo):
        _shadow_stage(repo, gitdir)
        code, out, _ = _shadow_git(repo, gitdir, ["diff", "--cached", "--name-status", "HEAD"])
    base = repo.rstrip("/")
    changed = {}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) < 2:
            continue
        st = parts[0].strip()
        p = parts[-1].strip()
        if not st or not p:
            continue
        changed[base + "/" + p] = st[0]
    return {"changed": changed}


def op_shadow_diff(a):
    repo = a["repo"]
    path = a["path"]
    gitdir = _shadow_dir(repo)
    if not os.path.exists(os.path.join(gitdir, "HEAD")):
        return {"diff": ""}
    rel = _shadow_rel(repo, path)
    with _shadow_lock(repo):
        _shadow_stage(repo, gitdir)
        code, out, _ = _shadow_git(repo, gitdir,
                                   ["diff", "--cached", "--no-color", "-U99999", "HEAD", "--", rel])
    return {"diff": out}


def op_shell(a):
    # 供 preview lane 复用既有 shell 探测命令,但仍走独立 RPC 进程/队列。
    cmd = a["cmd"]
    timeout = a.get("timeout", 45)
    stdin_b64 = a.get("stdin_b64")
    stdin_data = base64.b64decode(stdin_b64) if stdin_b64 else None
    try:
        p = subprocess.run(
            cmd,
            input=stdin_data,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
        return {
            "stdout_b64": base64.b64encode(p.stdout).decode("ascii"),
            "stderr": p.stderr.decode("utf-8", "replace"),
            "code": p.returncode,
        }
    except subprocess.TimeoutExpired:
        raise ValueError("shell 超时")


def _ps_snapshot():
    # 全量进程快照:返回 (procs 列表, children 映射 ppid->[pid])。
    out = subprocess.run(
        ["ps", "-eo", "pid=,ppid=,etime=,pcpu=,pmem=,stat=,args="],
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
    ).stdout.decode("utf-8", "replace")
    procs = []
    children = {}
    for line in out.splitlines():
        parts = line.split(None, 6)
        if len(parts) < 7:
            continue
        try:
            pid, ppid = int(parts[0]), int(parts[1])
        except ValueError:
            continue
        procs.append({"pid": pid, "ppid": ppid, "etime": parts[2],
                      "pcpu": parts[3], "pmem": parts[4],
                      "stat": parts[5], "args": parts[6]})
        children.setdefault(ppid, []).append(pid)
    return procs, children


def _cwd_of(pid):
    # 进程工作目录:Linux 读 /proc/<pid>/cwd;其它平台(macOS)用 lsof。
    try:
        return os.readlink("/proc/%d/cwd" % pid)
    except OSError:
        pass
    try:
        r = subprocess.run(
            ["lsof", "-p", str(pid), "-a", "-d", "cwd", "-F", "n"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout.decode("utf-8", "replace")
        for line in r.splitlines():
            if line.startswith("n/"):
                return line[1:]
    except Exception:
        pass
    return None


def _all_cwds():
    # 一次性拿到「所有进程」的 cwd:{pid: cwd}。
    # 关键性能点:macOS 上对每个进程单独 lsof 会慢到几十秒(789 进程 × 57ms ≈ 45s);
    # 这里 Linux 批量 readlink /proc/*/cwd,macOS 一条 `lsof -d cwd` 拿全部(~0.4s)。
    out = {}
    # Linux:/proc 最快
    if os.path.isdir("/proc"):
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            try:
                out[int(name)] = os.readlink("/proc/%s/cwd" % name)
            except OSError:
                pass
        if out:
            return out
    # macOS / 无 /proc:一条 lsof 批量取所有进程 cwd
    try:
        r = subprocess.run(
            ["lsof", "-d", "cwd", "-F", "pn"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout.decode("utf-8", "replace")
        cur = None
        for line in r.splitlines():
            if line.startswith("p"):
                try:
                    cur = int(line[1:])
                except ValueError:
                    cur = None
            elif line.startswith("n") and cur is not None:
                out[cur] = line[1:]
    except Exception:
        pass
    return out


def _all_fd_files():
    # 一次性拿到「所有进程」stdout/stderr(fd 1/2)指向的普通文件:{pid: path}。
    # 用途:launchctl/nohup 起的任务 cwd=/ 又不在 agent 子树下,唯一能关联到项目的
    # 线索就是它把日志写进了项目目录 —— 用输出文件路径作第三条锚点。
    # 性能同 _all_cwds:Linux 批量 readlink /proc/*/fd/{1,2},macOS 一条 lsof。
    out = {}
    if os.path.isdir("/proc"):
        for name in os.listdir("/proc"):
            if not name.isdigit():
                continue
            pid = int(name)
            for fd in (1, 2):
                try:
                    p = os.readlink("/proc/%s/fd/%d" % (name, fd))
                except OSError:
                    continue
                if p.startswith("/") and not p.startswith("/dev/"):
                    out[pid] = p
                    break  # fd1 优先;拿到即够
        if out:
            return out
    # macOS / 无 /proc:一条 lsof 取所有进程的 fd 1/2(只认普通文件 REG)
    try:
        r = subprocess.run(
            ["lsof", "-d", "1,2", "-F", "ptn"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        ).stdout.decode("utf-8", "replace")
        cur = None
        is_reg = False
        for line in r.splitlines():
            tag, val = line[:1], line[1:]
            if tag == "p":
                try:
                    cur = int(val)
                except ValueError:
                    cur = None
            elif tag == "t":
                is_reg = (val == "REG")
            elif tag == "n" and cur is not None and is_reg and cur not in out:
                if val.startswith("/") and not val.startswith("/dev/"):
                    out[cur] = val
    except Exception:
        pass
    return out


def _agent_descendants(cmd_base, cwd):
    # 定位 code agent(cmd_base)进程子树,返回其所有后代进程(不含根本身)。
    # 全量 ps 快照 → 按命令名(+cwd 收窄)找根 → 沿 ppid BFS。
    procs, children = _ps_snapshot()
    by_pid = {p["pid"]: p for p in procs}
    base = os.path.basename(cmd_base) if cmd_base else ""

    roots = []
    for p in procs:
        if base and base in p["args"]:
            c = _cwd_of(p["pid"])
            # cwd 收窄:归一化后比对(容忍尾斜杠/~/symlink),空 cwd 或取不到则不收窄。
            if not cwd or c is None or _norm_path(c) == _norm_path(cwd):
                roots.append(p["pid"])

    seen = set(roots)
    result = []
    stack = list(roots)
    while stack:
        for ch in children.get(stack.pop(), []):
            if ch not in seen:
                seen.add(ch)
                result.append(by_pid[ch])
                stack.append(ch)
    return result


def _fd_file(pid):
    # 取进程 stdout/stderr(fd 1/2)指向的普通文件路径;管道/tty/dev 等返回 None。
    # Linux:readlink /proc/<pid>/fd/N;其它平台(macOS)用 lsof 兜底。
    for fd in (1, 2):
        try:
            p = os.readlink("/proc/%d/fd/%d" % (pid, fd))
            if p.startswith("/") and not p.startswith("/dev/"):
                return p
            continue  # 是 pipe:/socket: 等 → 试下一个 fd
        except OSError:
            pass
        try:
            r = subprocess.run(
                ["lsof", "-p", str(pid), "-a", "-d", str(fd), "-F", "tn"],
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            ).stdout.decode("utf-8", "replace")
            is_reg = False
            for line in r.splitlines():
                if line.startswith("t"):
                    is_reg = (line[1:] == "REG")  # 只认普通文件
                elif line.startswith("n") and is_reg:
                    path = line[1:]
                    if path.startswith("/") and not path.startswith("/dev/"):
                        return path
        except Exception:
            pass
    return None


def op_ps(a):
    # 列出 code agent 进程子树下的所有后代进程(不做落盘过滤)。
    return {"procs": _agent_descendants(a.get("command_base") or "", a.get("cwd") or "")}


def _norm_path(p):
    # 路径归一化:展开 ~、相对转绝对、解 symlink(如 macOS /tmp→/private/tmp)。
    # 关键:前端传入的 project cwd 可能是 ~/proj 或相对形式,而 realpath 不展开 ~,
    # 直接比对会漏匹配 → 这里先 expanduser 再 abspath/realpath,容忍各种表示。
    if not p:
        return p
    try:
        return os.path.realpath(os.path.expanduser(p))
    except OSError:
        return os.path.expanduser(p).rstrip("/")


def _cwd_matches(proc_cwd, project_cwd):
    # 进程 cwd 是否落在项目目录下(含子目录)。归一化(展开 ~ + 解 symlink)+ 前缀
    # 匹配,容忍尾斜杠、软链、~ 与相对路径差异。
    if not proc_cwd or not project_cwd:
        return False
    a = _norm_path(proc_cwd)
    b = _norm_path(project_cwd)
    return a == b or a.startswith(b.rstrip("/") + "/")


# 一闪而过的短命工具 / 纯 shell 外壳:不是用户想看的"训练长任务",从任务列表剔除。
_NOISE_CMDS = {
    "sh", "bash", "zsh", "dash", "fish", "ksh",
    "head", "tail", "cat", "grep", "egrep", "fgrep", "ugrep", "rg", "ag",
    "ls", "sed", "awk", "find", "fd", "wc", "sort", "uniq", "cut", "tr",
    "which", "env", "echo", "printf", "true", "false", "test", "expr",
    "date", "basename", "dirname", "readlink", "stat", "cmp", "diff",
    "git", "ssh", "scp", "rsync", "tee", "xargs", "cp", "mv", "rm", "mkdir",
    "sleep",
}


def _exe_name(args):
    # 从命令行取「真正执行的程序名」:跳过 env / 解释器前缀,取第一个非选项 token 的 basename。
    toks = args.split()
    i = 0
    # 跳过 env VAR=val 前缀
    while i < len(toks) and ("=" in toks[i] or toks[i] in ("env", "nohup", "setsid", "stdbuf")):
        i += 1
    if i >= len(toks):
        return os.path.basename(toks[0]) if toks else ""
    return os.path.basename(toks[i])


def _is_noise(p):
    # 判断进程是否为噪声:纯 shell 外壳 / 短命工具 / claude snapshot shell /
    # Linco 自身基础设施(html-vibe 预览服务器、linco agent 自己)。
    args = p.get("args", "")
    if "shell-snapshot" in args or "snapshot-zsh" in args or "snapshot-bash" in args:
        return True
    # Linco/插件自己的进程,不是用户关心的「agent 起的任务」
    if "artifacts_server.py" in args or "linco_agent.py" in args:
        return True
    exe = _exe_name(args)
    return exe in _NOISE_CMDS


def _etime_secs(etime):
    # 解析 ps ELAPSED:[[DD-]HH:]MM:SS → 秒。解析失败返回一个大值(不因解析失败误删长任务)。
    try:
        days = 0
        s = etime.strip()
        if "-" in s:
            d, s = s.split("-", 1)
            days = int(d)
        parts = [int(x) for x in s.split(":")]
        if len(parts) == 3:
            h, m, sec = parts
        elif len(parts) == 2:
            h, m, sec = 0, parts[0], parts[1]
        else:
            h, m, sec = 0, 0, parts[0]
        return days * 86400 + h * 3600 + m * 60 + sec
    except Exception:
        return 10 ** 9


MIN_TASK_SECS = 5  # 存活不足这么久的不显示(滤掉一闪而过的工具);无上限,长任务保留


def op_agent_tasks(a):
    # 列出 agent 起的、**输出已落盘成文件**的「持续运行的任务」(可实时 tail 的)。
    # 典型:训练 / 评测 / 数据处理。把盲盒(agent 后台到底在跑什么)变透明。
    #
    # 检测策略(并集):一个进程算候选,需满足「输出落盘」且满足以下任一:
    #   (a) 在 agent(cmd_base)进程子树下 —— 刚起、还挂在 agent shell 下的任务;
    #   (b) cwd 在项目目录(cwd 参数)下 —— 后台长任务常被 init 收养(ppid→1)而脱离
    #       子树,但工作目录不变,用 cwd 锚点仍能稳定捕获,tab 不会因 reparent 消失。
    # 去噪(只留"训练这种长任务"):
    #   - 穿透外壳:sh -c "python train.py" 这种,外层 sh 是噪声,显示里层 python
    #     (若一个噪声 shell 有干活的子进程,改纳入子进程);
    #   - 剔除纯 shell / 短命工具(head/grep/cat/snapshot shell 等);
    #   - 跳过存活 < MIN_TASK_SECS 秒的(一闪而过);无时间上限。
    cmd_base = a.get("command_base") or ""
    cwd = a.get("cwd") or ""

    procs, children = _ps_snapshot()
    by_pid = {p["pid"]: p for p in procs}

    cand = {}  # pid -> proc(去重)
    # (a) agent 子树
    for p in _agent_descendants(cmd_base, cwd):
        cand[p["pid"]] = p
    # (b) cwd 命中项目目录的进程(不限进程树),排除 agent 自身。
    # 用一次性批量 _all_cwds()(macOS 一条 lsof,Linux 批量 /proc),避免对每个进程
    # 单独 lsof —— 后者在 macOS 上 789 进程要 ~45s,会把前端轮询永久挂住。
    if cwd:
        base = os.path.basename(cmd_base) if cmd_base else ""
        cwds = _all_cwds()
        for p in procs:
            if p["pid"] in cand:
                continue
            if base and base in p["args"]:
                continue  # 跳过 agent 本体
            if _cwd_matches(cwds.get(p["pid"]), cwd):
                cand[p["pid"]] = p
    # (c) 输出文件落在项目目录下的进程(不限进程树/cwd)。覆盖 launchctl/nohup 起的
    #     任务:它们 cwd=/、ppid=1(两条锚点都失效),但日志写进了项目目录,用输出
    #     文件路径兜底锚定。同样用批量 _all_fd_files() 避免逐进程 lsof。
    if cwd:
        base = os.path.basename(cmd_base) if cmd_base else ""
        fdfiles = _all_fd_files()
        for p in procs:
            if p["pid"] in cand:
                continue
            if base and base in p["args"]:
                continue
            f = fdfiles.get(p["pid"])
            if f and _cwd_matches(f, cwd):
                cand[p["pid"]] = p

    # 穿透外壳:候选若是噪声 shell 但有「干活的子进程」,用子进程替代它。
    # (sh -c "python train.py":外层 sh 被里层 python 替代,避免重复 tab)
    resolved = {}
    for pid, p in cand.items():
        target = p
        # 最多下钻几层壳
        for _ in range(4):
            if not _is_noise(target):
                break
            kids = [by_pid[c] for c in children.get(target["pid"], []) if c in by_pid]
            real = [k for k in kids if not _is_noise(k)]
            if len(real) == 1:
                target = real[0]
            else:
                break  # 没有唯一干活子进程 → 就地判定(下面会因 _is_noise 被剔除)
        resolved[target["pid"]] = target

    tasks = []
    for p in resolved.values():
        if _is_noise(p):
            continue  # 仍是 shell/短命工具 → 剔除
        if _etime_secs(p.get("etime", "")) < MIN_TASK_SECS:
            continue  # 一闪而过
        f = _fd_file(p["pid"])
        if f:
            tasks.append({"pid": p["pid"], "args": p["args"],
                          "file": f, "etime": p["etime"]})
    tasks.sort(key=lambda t: t["pid"])
    return {"tasks": tasks}


def op_proc_output(a):
    # 取某进程 stdout/stderr(fd 1/2)指向的文件路径。
    pid = int(a["pid"])
    f = _fd_file(pid)
    return {"fd1": f, "fd2": None}


def op_tail_file(a):
    # 从 offset 字节处增量读文件,返回新增内容(base64)+ 当前总大小。
    # 前端记住 size 作下次 offset,持续拿新增 → 实时滚动。文件被截断(size<offset)
    # 时从头读。限制单次返回上限,避免初次打开超大 log 一次性灌爆。
    path = a["path"]
    offset = int(a.get("offset", 0))
    max_bytes = int(a.get("max", 256 * 1024))
    try:
        size = os.path.getsize(path)
    except OSError as e:
        raise ValueError("无法读取输出文件: %s" % e)
    start = offset
    if offset > size:      # 文件被截断/轮转 → 从头
        start = 0
    # 初次(offset=0)且文件很大:只取尾部 max_bytes,避免一次性灌爆
    if start == 0 and size > max_bytes:
        start = size - max_bytes
    with open(path, "rb") as f:
        f.seek(start)
        data = f.read(max_bytes)
    return {
        "b64": base64.b64encode(data).decode("ascii"),
        "size": size,
        "start": start,
    }


# ---------- 文件监听(灵敏:agent 改文件 → 主动推 fileChange)----------
# 优先 inotifywait(事件级,最灵敏);否则纯 Python 轮询 mtime(~0.5s)。
# 变更去抖后批量推 {"event":"fileChange","paths":[...]}(无 id,主动)。

_watch_thread = None
_watch_stop = None  # threading.Event
_watch_lock = threading.Lock()
WATCH_SKIP = {".git", "node_modules", "target", "__pycache__", ".venv", "dist"}


def _emit_changes(paths):
    if paths:
        _send({"event": "fileChange", "paths": sorted(set(paths))})


def _has_inotifywait():
    return shutil.which("inotifywait") is not None


def _watch_inotify(root, stop):
    # 递归监听;批量收集 ~0.3s 内的事件再推一次
    excludes = "(/(" + "|".join(WATCH_SKIP) + ")(/|$))"
    cmd = ["inotifywait", "-m", "-r", "-q",
           "-e", "modify", "-e", "create", "-e", "delete", "-e", "moved_to", "-e", "moved_from",
           "--exclude", excludes, "--format", "%w%f", root]
    try:
        p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    except Exception:
        return _watch_poll(root, stop)  # 起不来则回退轮询
    batch = []
    last_flush = time.time()
    import select as _select
    while not stop.is_set():
        r, _, _ = _select.select([p.stdout], [], [], 0.3)
        if r:
            line = p.stdout.readline()
            if not line:
                break
            path = line.decode("utf-8", "replace").strip()
            if path:
                batch.append(path)
        # 去抖:积累 0.3s 或攒够一批就推
        if batch and (time.time() - last_flush > 0.3):
            _emit_changes(batch)
            batch = []
            last_flush = time.time()
    try:
        p.terminate()
    except Exception:
        pass
    if batch:
        _emit_changes(batch)


# 轮询监听的文件数上限:超过则放弃轮询(巨型目录全扫会拖垮交互)。
# 9k~1w 量级的常规仓库远在阈值内;真遇到超大目录就降级为"不自动刷新"。
MAX_WATCH_FILES = 50000


def _scan_mtimes(root):
    # 返回 (out, truncated):out = {path: mtime}(跳过噪声目录);
    # 文件数超 MAX_WATCH_FILES 时提前返回,truncated=True 通知调用方放弃轮询。
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in WATCH_SKIP]
        for n in filenames:
            p = os.path.join(dirpath, n)
            try:
                out[p] = os.stat(p).st_mtime
            except OSError:
                pass
        if len(out) > MAX_WATCH_FILES:
            return out, True
    return out, False


WATCH_POLL_INTERVAL = 1.0  # 轮询间隔(秒)。近万文件每秒全扫一次,CPU 可控;产物/代码刷新 1s 够用


def _watch_poll(root, stop):
    # 纯 Python mtime 轮询(无 inotifywait 时的兜底):周期性全量扫 root(只跳 WATCH_SKIP
    # 噪声目录),对比上一轮 mtime,变更/删除批量推 fileChange。语义与 inotify 路径一致——
    # 关键:全量覆盖,所以 agent 写到 artifacts/ 等 untracked / .gitignore 产物也照样被监控到。
    prev, truncated = _scan_mtimes(root)
    if truncated:
        return  # 目录过大,放弃轮询(op_watch 已据此把 mode 标为 none)
    while not stop.is_set():
        if stop.wait(WATCH_POLL_INTERVAL):
            break
        cur, too_big = _scan_mtimes(root)
        if too_big:
            # 运行中目录膨胀到超阈值(如训练写出海量文件)→ 停止轮询,避免持续卡顿
            return
        changed = []
        for p, m in cur.items():
            if prev.get(p) != m:
                changed.append(p)
        for p in prev:
            if p not in cur:
                changed.append(p)  # 删除
        if changed:
            _emit_changes(changed)
        prev = cur


def op_watch(a, rid):
    global _watch_thread, _watch_stop
    root = a["root"]
    mode = "none"
    with _watch_lock:
        # 已在监听 → 先停旧的
        if _watch_stop is not None:
            _watch_stop.set()
        _watch_stop = None
        _watch_thread = None
        # 优先 inotifywait(事件级、最灵敏);远端没装时回退到纯 Python mtime 轮询。
        # 轮询全量覆盖工作目录(只跳 WATCH_SKIP 噪声),所以 agent 写到 artifacts/ 等
        # untracked / .gitignore 产物也照样被监控到 —— 这正是文件树标记 + diff 自动刷新的来源。
        # 超大目录由 _watch_poll 内部的 MAX_WATCH_FILES 兜底:直接退出、mode 仍报 poll,
        # 前端不会误以为有实时刷新(已知局限,常规仓库远在阈值内)。
        _watch_stop = threading.Event()
        stop = _watch_stop
        if _has_inotifywait():
            target = _watch_inotify
            mode = "inotify"
        else:
            target = _watch_poll
            mode = "poll"
        _watch_thread = threading.Thread(target=target, args=(root, stop), daemon=True)
        _watch_thread.start()
    _send({"id": rid, "ok": True, "result": {"watching": root, "mode": mode}})


def op_unwatch(a, rid):
    global _watch_stop
    with _watch_lock:
        if _watch_stop is not None:
            _watch_stop.set()
            _watch_stop = None
    _send({"id": rid, "ok": True, "result": {}})


OPS = {
    "ping": op_ping, "stat": op_stat, "readdir": op_readdir,
    "read_file": op_read_file, "read_bytes": op_read_bytes,
    "write_file": op_write_file, "write_bytes": op_write_bytes,
    "create_file": op_create_file, "mkdir": op_mkdir,
    "rename": op_rename, "delete": op_delete,
    "copy": op_copy, "move": op_move,
    "search_files": op_search_files, "grep": op_grep,
    "search_cancel": op_search_cancel,
    "git": op_git, "shell": op_shell, "ps": op_ps,
    "shadow_begin": op_shadow_begin,
    "shadow_changed": op_shadow_changed,
    "shadow_diff": op_shadow_diff,
    "proc_output": op_proc_output, "tail_file": op_tail_file,
    "agent_tasks": op_agent_tasks,
}


def _handle(req):
    global _last_activity
    _last_activity = time.time()
    rid = req.get("id")
    op = req.get("op")
    args = req.get("args") or {}
    # watch/unwatch 需要 rid 且自管线程,单独处理
    if op == "watch":
        op_watch(args, rid)
        return
    if op == "unwatch":
        op_unwatch(args, rid)
        return
    if op == "grep_stream":
        # 流式搜索:自行用 rid 在结束时回 RPC 响应,中途用 event 推批次
        op_grep_stream(args, rid)
        return
    fn = OPS.get(op)
    if fn is None:
        _send({"id": rid, "ok": False, "error": "unknown op: %s" % op})
        return
    try:
        result = fn(args)
        _send({"id": rid, "ok": True, "result": result})
    except Exception as e:
        _send({"id": rid, "ok": False, "error": str(e)})


def _idle_watch():
    # 空闲自退:超时无请求即退出
    while True:
        time.sleep(30)
        if time.time() - _last_activity > IDLE_TIMEOUT:
            os._exit(0)


def _worker_loop():
    while True:
        req = _request_queue.get()
        if req is None:
            _request_queue.task_done()
            return
        try:
            _handle(req)
        finally:
            _request_queue.task_done()


def _start_workers():
    for i in range(MAX_WORKERS):
        t = threading.Thread(target=_worker_loop, name="linco-rpc-%d" % i, daemon=True)
        t.start()


def main():
    t = threading.Thread(target=_idle_watch, daemon=True)
    t.start()
    _start_workers()
    # 逐行读请求
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception:
            _send({"id": None, "ok": False, "error": "bad json"})
            continue
        _request_queue.put(req)
    # stdin EOF → 退出
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        pass
