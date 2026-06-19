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

AGENT_VERSION = "8"
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


def op_grep(a):
    # 复用系统 grep(快、稳),结构化解析 path:lineno:text
    root = a["root"]
    pattern = a["pattern"]
    flags = "-rnI"
    if not a.get("case_sensitive"):
        flags += "i"
    flags += "E" if a.get("is_regex") else "F"
    cmd = ["grep", flags,
           "--exclude-dir=.git", "--exclude-dir=node_modules",
           "--exclude-dir=target", "--exclude-dir=__pycache__", "--exclude-dir=.venv",
           "-e", pattern, root]
    try:
        p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        text = p.stdout.decode("utf-8", "replace")
    except Exception as e:
        raise ValueError("grep 失败: %s" % e)
    results = []
    for line in text.splitlines()[:3000]:
        parts = line.split(":", 2)
        if len(parts) == 3 and parts[1].isdigit():
            results.append([parts[0], int(parts[1]), parts[2]])
    return {"matches": results}


def op_git(a):
    # 在 repo 目录跑 git,返回 stdout/stderr/code(不抛错,由调用方按 code 判断)
    repo = a["repo"]
    args = a.get("args") or []
    try:
        p = subprocess.run(
            ["git", "-C", repo] + list(args),
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        return {
            "stdout": p.stdout.decode("utf-8", "replace"),
            "stderr": p.stderr.decode("utf-8", "replace"),
            "code": p.returncode,
        }
    except FileNotFoundError:
        raise ValueError("git 未安装")


# ---------- 影子快照(本轮 agent 改动):与项目 git 无关的独立影子仓库 ----------
# 语义与本地 shadow.rs 完全对称:在 $HOME/.linco/shadows/<repo哈希>/ 建独立 git 仓库,
# work-tree 指向工作目录,add -A + commit 出「本轮基线」,捕获一切文件(含 untracked /
# gitignored 产物)。changed/diff 都对比这个基线。远端零额外依赖,只用 git 本身。

SHADOW_EXCLUDES = [".git/", "node_modules/", "target/", "__pycache__/", ".venv/", "dist/"]


def _shadow_fnv1a(s):
    h = 0xcbf29ce484222325
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x100000001b3) & 0xFFFFFFFFFFFFFFFF
    return "%016x" % h


def _shadow_dir(repo):
    home = os.environ.get("HOME", "/tmp")
    return os.path.join(home, ".linco", "shadows", _shadow_fnv1a(repo))


def _shadow_git(repo, gitdir, args):
    # 用 --git-dir/--work-tree 把影子仓库与项目 git 隔离;关掉 hooks/gpg 保证干净快速。
    full = [
        "git",
        "--git-dir=" + gitdir,
        "--work-tree=" + repo,
        "-c", "core.hooksPath=/dev/null",
        "-c", "commit.gpgsign=false",
    ] + list(args)
    p = subprocess.run(full, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return p.returncode, p.stdout.decode("utf-8", "replace"), p.stderr.decode("utf-8", "replace")


def _shadow_ensure_init(repo):
    gitdir = _shadow_dir(repo)
    head = os.path.join(gitdir, "HEAD")
    if not os.path.exists(head):
        os.makedirs(gitdir, exist_ok=True)
        _shadow_git(repo, gitdir, ["init", "-q"])
        _shadow_git(repo, gitdir, ["config", "user.email", "linco@local"])
        _shadow_git(repo, gitdir, ["config", "user.name", "Linco"])
    info = os.path.join(gitdir, "info")
    os.makedirs(info, exist_ok=True)
    with open(os.path.join(info, "exclude"), "w", encoding="utf-8") as f:
        f.write("\n".join(SHADOW_EXCLUDES) + "\n")
    return gitdir


def _shadow_rel(repo, path):
    pref = repo.rstrip("/") + "/"
    return path[len(pref):] if path.startswith(pref) else path


def op_shadow_begin(a):
    repo = a["repo"]
    gitdir = _shadow_ensure_init(repo)
    _shadow_git(repo, gitdir, ["add", "-A"])
    _shadow_git(repo, gitdir, ["commit", "-q", "--allow-empty", "-m", "linco-turn-baseline"])
    return {}


def op_shadow_changed(a):
    repo = a["repo"]
    gitdir = _shadow_dir(repo)
    if not os.path.exists(os.path.join(gitdir, "HEAD")):
        return {"changed": {}}
    # 先 add -A 纳入新建 untracked 文件,再 diff --cached(index vs 基线),否则漏新建产物
    _shadow_git(repo, gitdir, ["add", "-A"])
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
    _shadow_git(repo, gitdir, ["add", "-A"])
    code, out, _ = _shadow_git(repo, gitdir, ["diff", "--cached", "--no-color", "HEAD", "--", rel])
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
            if not cwd or c is None or c == cwd:
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


def _cwd_matches(proc_cwd, project_cwd):
    # 进程 cwd 是否落在项目目录下(含子目录)。realpath 归一化(解 symlink,如
    # macOS /tmp→/private/tmp)+ 前缀匹配,容忍尾斜杠与软链差异。
    if not proc_cwd or not project_cwd:
        return False
    try:
        a = os.path.realpath(proc_cwd)
        b = os.path.realpath(project_cwd)
    except OSError:
        a, b = proc_cwd, project_cwd
    return a == b or a.startswith(b.rstrip("/") + "/")


def op_agent_tasks(a):
    # 列出 agent 起的、**输出已落盘成文件**的后台任务(可实时 tail 的)。
    # 这正是「训练/长任务」:stdout 重定向到文件;前台命令(npm/lark 等)stdout 是
    # 直连 agent 的管道,_fd_file 返回 None → 被过滤掉(也没法 tail)。
    #
    # 检测策略(并集):一个进程算 agent 任务,需满足「输出落盘」且满足以下任一:
    #   (a) 在 agent(cmd_base)进程子树下 —— 刚起、还挂在 agent shell 下的任务;
    #   (b) cwd 在项目目录(cwd 参数)下 —— 后台长任务常被 init 收养(ppid→1)而脱离
    #       子树,但工作目录不变,用 cwd 锚点仍能稳定捕获,tab 不会因 reparent 消失。
    # 两路按 pid 去重合并。cwd 为空(没传项目目录)则只走 (a)。
    cmd_base = a.get("command_base") or ""
    cwd = a.get("cwd") or ""

    cand = {}  # pid -> proc(去重)
    # (a) agent 子树
    for p in _agent_descendants(cmd_base, cwd):
        cand[p["pid"]] = p
    # (b) cwd 命中项目目录的进程(不限进程树),排除 agent 自身
    if cwd:
        base = os.path.basename(cmd_base) if cmd_base else ""
        procs, _ = _ps_snapshot()
        for p in procs:
            if p["pid"] in cand:
                continue
            if base and base in p["args"]:
                continue  # 跳过 agent 本体
            if _cwd_matches(_cwd_of(p["pid"]), cwd):
                cand[p["pid"]] = p

    tasks = []
    for p in cand.values():
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
