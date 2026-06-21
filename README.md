## 这是一款全新的Vibe Coding产品

---

## Linco 插件(`vendor/HTML-VibeCoding/plugins/`)

Linco 的若干能力由随项目 vendored 的 Claude Code 插件提供。它们曾是一个单体插件,现已拆成**三个独立插件**,各管一摊、可单独安装:

| 插件 | 作用 |
|---|---|
| **linco-html** | 让 claude 默认把"实质性产物"产出为**自包含 HTML**(写到 `当前cwd/artifacts/`),并提供 notebook 渲染引擎(KaTeX、可编辑单元格、表格)。**Linco 预览引擎资源(`assets/`)也在这个插件下**,预览功能依赖它。 |
| **linco-task-monitor** | 注入"后台长任务用 `-u` + 重定向到项目内 `.log` + 后台 `&`"的工作流指令,让训练/评测等后台任务被 Linco 终端的监控面板实时捕获显示。纯说明,无副作用。 |
| **linco-shadow-diff** | 「本轮 agent 改动」可视化:用独立影子 git(与项目 `.git` 无关)追踪每轮对话改了哪些文件,Linco 文件树标 A/M/D、点开显红绿 diff。注入说明 + 提供 `shadow.sh` CLI(`begin`/`changed`/`diff`/`status`)供 agent 主动调用。 |

每个插件各有自己的 SessionStart 钩子,会话启动时全部触发、互不干扰。

### 几个要点
- **产物目录** = claude 启动时 cwd 下的 `artifacts/`(不是固定根目录)。可选 `HTML_VIBE_ARTIFACTS_DIR=/abs/path` 钉死(一般不用)。
- Linco 的预览**不依赖** linco-html 自带的 Python 服务器(`artifacts_server.py`)——Linco 自己在本机起 HTTP 服务器、复刻了 `/__assets/` 与目录首页;它只需要 linco-html 的 `assets/` 引擎资源(见 `src-tauri/src/preview.rs`,优先 `linco-html/assets`,兼容旧的 `html-vibe/assets`)。
- **shadow diff 大多数时候是全自动的**:用户发消息 → Linco 自动拍基线 → 改文件 → 文件树标记/diff 自动出现。`shadow.sh` 只是给 agent 主动查看/触发用的补充入口。

### 安装(关键:装在 claude 实际运行的机器上)

claude 在哪运行,插件就装在哪。Linco 让 claude **跑在远程集群**,所以插件要装到远程服务器(本地用 claude 时则装本地)。Claude Code 插件 = 放到 `~/.claude/plugins/<插件名>/` 即可加载。

**本地安装(三个都软链,改 vendor 即生效):**
```bash
P=/Users/peilinfeng/linco/vendor/HTML-VibeCoding/plugins
for p in linco-html linco-task-monitor linco-shadow-diff; do
  ln -sfn "$P/$p" ~/.claude/plugins/"$p"
done
```

**远程集群安装(在每台要用的服务器上,从 Linco 所在 Mac 执行):**
```bash
P=/Users/peilinfeng/linco/vendor/HTML-VibeCoding/plugins
ssh <host> 'mkdir -p ~/.claude/plugins'
for p in linco-html linco-task-monitor linco-shadow-diff; do
  rsync -a "$P/$p/" <host>:~/.claude/plugins/"$p"/
done
```

装好后**重开一个 claude 会话**(SessionStart 钩子才会触发)即可生效。

### 校验已安装
```bash
# 本地(三个 hook 都应存在)
ls ~/.claude/plugins/linco-html/hooks/html-session-start.sh \
   ~/.claude/plugins/linco-task-monitor/hooks/task-monitor-session-start.sh \
   ~/.claude/plugins/linco-shadow-diff/hooks/shadow.sh
# 远程同理:ssh <host> 'ls ~/.claude/plugins/linco-*/hooks/'
```

### 升级
改了 `vendor/HTML-VibeCoding/plugins/` 后:本地软链方式自动生效;拷贝/远程方式重跑上面的 `rsync` 即可。

> 兼容性:`preview.rs` 仍保留对旧插件名 `html-vibe/assets` 的回退,已部署旧插件的机器预览不会立即失效;但要用上拆分后的三插件,需按上面重新软链/rsync 到 `linco-*`。

