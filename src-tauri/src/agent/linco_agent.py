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

AGENT_VERSION = "4"
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


def _scan_mtimes(root):
    # 返回 {path: mtime},跳过噪声目录,限制规模
    out = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in WATCH_SKIP]
        for n in filenames:
            p = os.path.join(dirpath, n)
            try:
                out[p] = os.stat(p).st_mtime
            except OSError:
                pass
        if len(out) > 20000:
            return out
    return out


def _watch_poll(root, stop):
    prev = _scan_mtimes(root)
    while not stop.is_set():
        if stop.wait(0.5):
            break
        cur = _scan_mtimes(root)
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
        # 没有 inotifywait 时不要做全项目轮询。大仓库/远端盘会把首次展开目录拖到
        # 数秒甚至十几秒;交互优先,自动刷新可以降级为手动/操作后局部刷新。
        if _has_inotifywait():
            _watch_stop = threading.Event()
            stop = _watch_stop
            _watch_thread = threading.Thread(target=_watch_inotify, args=(root, stop), daemon=True)
            _watch_thread.start()
            mode = "inotify"
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
    "git": op_git,
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
