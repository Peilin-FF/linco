### 我已经把利用HTML与claude code/codex交互做成了一个原生vibe coding app，它的human in loop感会领先于现在所有的产品，敬请期待！
#### btw,其实我已经在用它来更新它自己了🤫

---

## HTML-VibeCoding 插件(`vendor/HTML-VibeCoding`)

Linco 的预览能力依赖这个 Claude Code 插件:它让 claude 默认把"实质性产物"产出为**自包含 HTML**(写到当前项目的 `./artifacts/`),并提供 notebook 渲染引擎(KaTeX 公式、可编辑单元格、表格)。源码随 Linco 一起 vendored 在 `vendor/HTML-VibeCoding/`。

### 它做了什么
- **SessionStart 钩子**(`plugins/html-vibe/hooks/html-session-start.sh`):每次 claude 会话启动时,注入"默认产出单文件 HTML 到 `当前cwd/artifacts/`"的工作流指令。
  - 产物目录 = claude 启动时的 **当前工作目录(cwd)下的 `artifacts/`**(不是固定根目录)。所以在 `MAS` 启动 claude → 写 `MAS/artifacts/`;在 `fengpeilin` 启动 → 写 `fengpeilin/artifacts/`。
  - 可选:设环境变量 `HTML_VIBE_ARTIFACTS_DIR=/abs/path` 可钉死产物目录(一般不用)。
- **html-kit 技能**(`skills/html-kit/`):统一设计套件 + notebook 模板。
- **渲染引擎资源**(`assets/`):`notebook.js/css`、`katex.min.js/css` + 字体。Linco 的预览服务器从这里取引擎渲染产物(见 `src-tauri/src/preview.rs` 的 `/__assets/`)。

> 注:Linco 的预览**不依赖**插件自带的 Python 预览服务器(`artifacts_server.py`)——Linco 自己在本机起了 HTTP 服务器、并复刻了它的 `/__assets/` 与目录首页。插件主要提供:① 给 claude 的"产出 HTML"工作流指令;② 渲染引擎静态资源。

### 安装(关键:装在 claude 实际运行的机器上)

claude 在哪运行,插件就要装在哪。Linco 让 claude **跑在远程集群**,所以**插件要装到远程服务器**(本地用 claude 时则装本地)。

Claude Code 插件 = 放到 `~/.claude/plugins/<插件名>/` 即可被加载。

**本地安装:**
```bash
# 软链(推荐,改 vendor 即生效)或拷贝
ln -sfn /Users/peilinfeng/linco/vendor/HTML-VibeCoding/plugins/html-vibe ~/.claude/plugins/html-vibe
# 或拷贝:
# cp -r /Users/peilinfeng/linco/vendor/HTML-VibeCoding/plugins/html-vibe ~/.claude/plugins/html-vibe
```

**远程集群安装**(在每台要用的服务器上):
```bash
# 把插件推到远端 ~/.claude/plugins/(在 Linco 所在 Mac 上执行)
ssh <host> 'mkdir -p ~/.claude/plugins'
rsync -a /Users/peilinfeng/linco/vendor/HTML-VibeCoding/plugins/html-vibe/ <host>:~/.claude/plugins/html-vibe/
```

装好后**重开一个 claude 会话**(SessionStart 钩子才会触发),让 claude 生成 HTML 产物,即可在 Linco 预览页看到。

### 校验已安装
```bash
# 本地
ls ~/.claude/plugins/html-vibe/hooks/html-session-start.sh
# 远程
ssh <host> 'ls ~/.claude/plugins/html-vibe/hooks/html-session-start.sh'
```

### 升级
改了 `vendor/HTML-VibeCoding` 后:本地软链方式自动生效;拷贝/远程方式重跑上面的 `cp`/`rsync` 即可。Linco 内置的渲染引擎资源(KaTeX 等)在 `vendor/.../assets/`,预览服务器会优先用各机器 `~/.claude/plugins/html-vibe/assets/` 那份(与产物同机,版本匹配)。
