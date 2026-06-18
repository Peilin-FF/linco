#### 项目目前还在和我反复磨合，欢迎诸位vibe coding的大佬们广泛提需求。做一款我们自己用起来最方便的vibe coding套件！
#### 它可以直接在vscode中直接预览和编辑HTML，不需要用到浏览器显示,preview模式下可以直接修改HTML以及为claude加需求

# html-vibe

一个 Claude Code 插件：**让 Claude 默认用「可渲染、可编辑、能存回磁盘」的 HTML notebook 跟你交互**，而不是一堵纯 markdown。

灵感来自 Anthropic「[The unreasonable effectiveness of HTML](https://thariqs.github.io/html-effectiveness/)」——HTML 把"你会略读的文档"变成"你真正会读、还能动手改"的东西。

---

## 为什么是 HTML（核心理念）

同样的内容，markdown 是一堵需要略读的文字墙；HTML 能渲染成卡片、彩色对比表、并排布局、流程图、代码面板，一眼看清结构。这个插件把这件事变成 Claude 的**默认行为**，并补上了 markdown/ipynb 给不了的两件事：

1. **富渲染**——结论、对比、代码讲解渲染成漂亮的 HTML 块，不再是纯文本。
2. **可编辑 + 存回**——产物是个 Jupyter 式 notebook，你能就地改、删、重排，点「保存」直接写回磁盘文件，Claude 再读这个文件即可，**无需复制粘贴**。

---

## 它做什么

- **每次会话自动起一个 artifacts 预览服务器**（默认端口 8000，带热刷新）。你在 VS Code 的 Simple Browser 打开 `http://localhost:8000/` 一次，之后 Claude 写/改 `artifacts/` 里的文件，页面 ~1 秒自动刷新。
- **注入工作流指令**：让 Claude 对实质性产物（报告、对比、计划、代码审查、讲解、实验记录等）默认产出一个 **notebook 形态的 HTML**，而不是 markdown 回复。
- **附带 `/html-kit` 技能**：notebook 模板 + 统一设计套件（配色 token、组件配方）。

---

## Notebook 是什么样的

产物是一个 **Jupyter 式 notebook**——文档 = 一串 cell。三种 cell：

| cell 类型 | 用途 | 谁来写 |
|---|---|---|
| **HTML 块** | 卡片 / callout / 并排 / 彩色表 / 代码面板 —— 渲染成漂亮排版 | **Claude 产出的默认形态**（结论、对比、说明都用它） |
| **表格** | 可编辑网格：点改单元格、拖 `⠿` 换行列、删行列、导出 MD/CSV/JSON | 结构化数据 |
| **Markdown** | 渲染成排版文字 | **留给你**补充内容 / 笔记，供 Claude 参考 |

**约定**：Claude 的产出用 HTML 块 / 表格渲染（不塞进 markdown 框）；Markdown cell 是你的频道——你不写 HTML，加 cell 时只提供 `+ Markdown` 和 `+ 表格`。

### 交互（和 Jupyter 一致）

- **看**：cell 默认是渲染后的样子。
- **编辑**：双击 cell（或点 ✎）进入编辑，失焦或按 `Shift+Enter` 渲染回去。HTML 块是**所见即所得就地编辑**——直接在渲染出来的文字上改，不碰源代码。
- **删 / 重排**：每个 cell 右上角 `×` 删除，左侧 `⠿` 拖动重排。
- **加 cell**：cell 之间平时只有一条细线，**双击该处**才弹出 `+ Markdown` / `+ 表格`；不想加就点 `✕`、点别处或按 `Esc` 收起。
- **保存**：顶部「保存到文件」按钮，或按 `Ctrl+S`，把当前内容写回这个 HTML 文件本身（所见即所得落盘）。
- **复制 Markdown**：顶部按钮，把整本导出为 markdown。

---

## 数学公式（LaTeX）

在任意 cell 的文字里直接写 LaTeX，打开页面即渲染成公式：

- **行内**：`$e^{i\pi}+1=0$`
- **块级**：`$$\mathrm{softmax}(x_i)=\frac{e^{x_i}}{\sum_j e^{x_j}}$$`

由 **MathJax**（tex-svg，渲染成 SVG）完成。两个要点：

- **离线自包含**：库是插件自带的静态资源 `/__assets/mathjax-tex-svg.js`，不走外网 CDN。
- **源码保留 LaTeX**：渲染成公式后，文件里存的仍是 `$...$` 源码（不是一坨 SVG）。所以你双击编辑看到的还是 LaTeX、能改，保存回磁盘的也是 LaTeX，可反复重渲染。

> MathJax 库约 2MB，首次加载略慢（之后浏览器缓存）；公式异步渲染，可能比正文晚半秒出现，属正常。

---

## HTML 渲染机制（引擎与内容分离）

这是这个插件的关键设计——**产物 HTML 是一个薄壳，渲染/编辑引擎不在里面**：

```
你的产物文件 (artifacts/xxx.html)         插件 (由预览服务器提供)
┌─────────────────────────────┐         ┌──────────────────────────┐
│ <link href=/__assets/        │ ──────▶ │ assets/notebook.css       │
│       notebook.css>          │         │   （所有渲染样式）         │
│ <script id="seed"            │         │                          │
│   type="application/json">   │         │ assets/notebook.js        │
│   [ ...全部内容数据... ]      │ ──────▶ │   （渲染/编辑/表格/保存引擎） │
│ </script>                    │         │   HtmlVibeNotebook.mount()│
│ <script src=/__assets/       │         └──────────────────────────┘
│       notebook.js>           │
└─────────────────────────────┘
```

- **内容**：只存在产物里那段 `<script id="seed" type="application/json">` 的 JSON 数组（cell 列表）。
- **引擎**：渲染 markdown → HTML、富 HTML 块、可编辑表格、拖拽、保存逻辑，全部在插件的 `assets/notebook.js`（+ `notebook.css`），由预览服务器在固定地址 `/__assets/notebook.{css,js}` 提供。

**这样设计的好处：**
- **产物文件很小、只含内容** —— Claude 读它时不会被几百行引擎样板淹没，省上下文。
- **引擎统一升级** —— 想改进渲染/交互，只改 `assets/notebook.{js,css}` 一处，所有产物（包括已生成的）刷新即生效，无需逐个改文件。
- **页面打开时**：浏览器加载薄壳 → 拉取 `/__assets/` 引擎 → 引擎读 `<script id="seed">` 的数据 → `mount()` 渲染成 notebook。

### 所见即所得落盘怎么工作

预览服务器（`hooks/artifacts_server.py`）除了静态服务，还提供一个 `POST /__save` 接口。你点「保存到文件」时，前端把当前 cell 内容 POST 过去，服务器**只替换文件里 `<script id="seed">` 的 JSON**，其余壳原样保留。于是文件始终是薄壳、内容更新、可反复保存而不臃肿。Claude 随后直接读这个文件即可看到你的改动。

> ⚠️ 保存依赖预览服务器，必须**经 `http://localhost:8000/` 打开**才有效；用 `file://` 直接打开本地文件无法保存。

---

## 安装（新电脑也一样）

```
# 1. 添加这个 marketplace（指向本仓库）
/plugin marketplace add /path/to/html_vibe
#   或从 git： /plugin marketplace add <你的-git-url>

# 2. 安装插件
/plugin install html-vibe@html-vibe-marketplace
```

安装后**重启或重开会话**生效。之后任何项目新开会话都会自动起预览服务器并启用 HTML 工作流。

---

## 查看产物

VS Code 里 `Cmd/Ctrl+Shift+P` → `Simple Browser: Show` → 输入 `http://localhost:8000/`（产物目录首页，点进任意文件）。

**页面空白？** 多半是端口没转发：打开 VS Code 底部 **PORTS** 面板，确认/手动转发端口 8000。注意必须走 `http://localhost:8000/`，不能用 `file://`（否则热刷新和保存都失效）。

---

## 目录结构

```
html_vibe/
├── .claude-plugin/marketplace.json          marketplace 清单
└── plugins/html-vibe/
    ├── .claude-plugin/plugin.json           插件清单
    ├── hooks/
    │   ├── hooks.json                        SessionStart 钩子声明
    │   ├── html-session-start.sh             起服务器 + 注入工作流指令
    │   └── artifacts_server.py               预览服务器：静态服务 + 热刷新 + /__save 落盘 + /__assets 引擎
    ├── assets/
    │   ├── notebook.css                       notebook 渲染样式
    │   ├── notebook.js                        notebook 引擎（渲染/编辑/表格/拖拽/保存）
    │   └── mathjax-tex-svg.js                  LaTeX 数学渲染（离线，MathJax）
    └── skills/html-kit/
        ├── SKILL.md                           设计套件 + notebook 用法
        └── templates/notebook.html            薄壳模板（复制它、只改 seed 数据）
```

---

## 自定义

- **改端口**：设环境变量 `HTML_VIBE_PORT`（默认 8000）。
- **固定产物目录**：设 `HTML_VIBE_ARTIFACTS_DIR`（绝对路径），否则默认用当前项目的 `./artifacts`。
- **改渲染/交互引擎**：编辑 `plugins/html-vibe/assets/notebook.{js,css}` —— 所有产物自动生效。
- **改设计套件 / notebook 用法**：编辑 `plugins/html-vibe/skills/html-kit/SKILL.md`。
- **改注入指令**：编辑 `plugins/html-vibe/hooks/html-session-start.sh` 里的 `CTX`。

---

## 依赖

`python3`（起预览服务器）、`curl`、`jq`（推荐；缺失时钩子有降级路径）。
