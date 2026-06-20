---
name: shadow-diff
description: 当用户问「这一轮你改了什么/给我看 diff」,或你在终端直接改文件希望被 Linco 文件树标记时使用。提供 shadow.sh 追踪本轮 agent 改动。
---

# Linco 本轮改动 diff(shadow diff)

Linco 有一个「本轮 agent 改动」可视化:用户每次在对话框给你发消息时,Linco 会自动在 `~/.linco/shadows/<工作目录哈希>/` 建一个**独立 git 影子仓库**(与项目自己的 `.git` 完全无关)拍下「这一轮开始前」的基线;之后你改文件,Linco 文件树就自动标 A/M/D、点开文件显红绿 diff。

**这套大部分是自动的** —— 用户发消息=自动建基线,你改文件=自动显示。它只收人类会手改的源码/文本/配置(<1MB),自动跳过 venv、日志、模型权重等产物。

## 主动调用 shadow.sh

脚本随本插件分发,影子仓库与 Linco 应用共用、完全互通。优先用已安装路径,回退到本仓库:

```bash
# 拍/重置本轮基线(每个用户回合最多一次,勿中途反复调)
bash ~/.codex/skills/shadow-diff/shadow.sh begin 2>/dev/null \
  || bash ~/.codex/skills/html-kit/shadow.sh begin

# 列出本轮改过的文件(A/M/D)
bash ~/.codex/skills/shadow-diff/shadow.sh changed

# 看某文件本轮的红绿 diff
bash ~/.codex/skills/shadow-diff/shadow.sh diff <文件>

# 查基线信息
bash ~/.codex/skills/shadow-diff/shadow.sh status
```

默认在项目根目录运行(或用 `LINCO_REPO=<abs>` 指定)。

## 何时主动用

1. 用户问「这一轮你改了什么/给我看 diff」时,跑 `changed`/`diff <文件>` 给出确切清单。
2. 你在终端里直接干活(没走对话框、因而没自动建基线)、却希望用户能在文件树看到本轮标记时,先 `begin` 再开始改。
3. 想确认某次改动是否被正确捕获时用 `status`/`changed` 自查。

注意:`begin` 会重置基线(开启新一轮),不要在用户一轮对话中途反复 `begin`,否则会把本轮已有的改动从 diff 里抹掉。
