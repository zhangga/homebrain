# homebrain

深度绑定飞书的团队/家庭 AI 知识库 Agent。定位是「最了解我们的 agent」：它常驻飞书群与私聊，
默默收录大家分享的知识，夜间提炼成 wiki 知识页，并在被 @ 或私聊时基于知识库作答（带引用）。

知识引擎借鉴 [`nashsu/llm_wiki`](https://github.com/nashsu/llm_wiki) 的设计（无 embedding 原生可用、
中文 CJK bigram、整页范式、成熟的 ingest/检索思路）与 `gbrain` 的 dream cycle 思路，
**编排/多用户/飞书层完全自建**。llm_wiki 为 GPL-3.0 → 仅借鉴设计，不 fork/拷贝代码或 prompt 原文。

## 架构

Bun workspaces monorepo，依赖严格单向：`web/app → orchestrator → core → llm → shared`，`connectors → shared`。

| 包 | 职责 |
|---|---|
| `packages/shared` | 类型、写串行化 `Serializer`、logger、config、SpaceId 工具 |
| `packages/llm` | 网关 fetch 封装（Anthropic messages 格式）+ 成本治理（JSONL 日志 + 每日预算） |
| `packages/core` | 知识层 seam `Knowledge` + llm_wiki 式引擎：markdown/SQLite(FTS5)/dream cycle/ask 检索问答 |
| `packages/connectors` | `Connector` 抽象 + `cli`（调试）+ `feishu`（lark-cli 子进程守护） |
| `packages/orchestrator` | runtime 单消费者 + LLM 意图分类 + 应答网关 + 空间归属 + 冷启动话术 |
| `packages/web` | Hono 管理后台（空间/知识、Agents、任务、Integrations、运行状态、数据治理、日志、设置） |
| `packages/app` | 入口：feishu 连接器 + orchestrator + web + 调度器（含 catch-up） |

### 双层空间模型

- `personal/<open_id>`：每人一个（私聊知识）
- `team/<chat_id>`：每个飞书群一个
- 检索视野 = 个人空间 ∪ 所属团队空间

每个空间的磁盘布局（Obsidian 兼容）：

```
data/workspaces/<dir>/
  purpose.md schema.md        # 空间意图 + 页类型规则（团队可编辑）
  raw/sources/                # 预留：不可变原始来源
  wiki/{index,overview,log,glossary}.md + {entities,concepts,sources,analysis}/*.md
  .index.db                   # SQLite，可从 wiki/*.md 重建
```

## 环境要求

- **Bun**（`curl -fsSL https://bun.sh/install | bash`），Node v22 仅作参考。
- **LLM 网关**：字节内网 `api.gameaigc.cn`，Anthropic + OpenAI 双兼容，无 embedding。
- **飞书 `lark-cli`**：已配置应用 + bot/user 授权。附件下载使用 bot 身份，应用需开通
  `im:message:readonly` 权限。

### 环境变量

```bash
export ANTHROPIC_BASE_URL=https://api.gameaigc.cn   # 已注入
export ANTHROPIC_AUTH_TOKEN=sk-...                  # 已注入
export HOMEBRAIN_DATA_DIR=./data                    # 默认 ./data
export HOMEBRAIN_LLM_MODEL=claude-sonnet-5          # ask/提炼默认模型
export HOMEBRAIN_DAILY_BUDGET_USD=5                 # 每日预算
export HOMEBRAIN_WEB_HOST=127.0.0.1                 # 默认仅本机访问
export HOMEBRAIN_WEB_PORT=3000                      # 管理后台端口
export HOMEBRAIN_DREAM_HOUR=3                        # 每日提炼时刻（0-23，Asia/Shanghai）
export HOMEBRAIN_RAW_RETENTION_DAYS=90              # 已提炼原始消息保留天数；0=永久
# 仅当 HOMEBRAIN_WEB_HOST 不是本机回环地址时必须设置（环境变量专属，不写盘）
export HOMEBRAIN_WEB_ADMIN_TOKEN=replace-with-a-strong-secret
# 可选：精确 @ 识别（否则群内任意 @ 都视为叫机器人）
export HOMEBRAIN_FEISHU_BOT_NAME=homebrain
export HOMEBRAIN_FEISHU_BOT_OPEN_ID=ou_xxx
```

> 后台「设置 / Agents / Integrations」里改的配置会写入 `data/config/{settings,agents,spaces}.json`
> 并叠加在上述环境变量之上（后台显式设置优先）。模型 / 预算 / 提炼时刻 / 群设置即时生效；
> Bot 身份与端口需重启生效。`HOMEBRAIN_WEB_HOST` 与 `HOMEBRAIN_WEB_ADMIN_TOKEN` 仅从环境变量读取：
> 默认绑定 `127.0.0.1`；开放到局域网或 `0.0.0.0` 时必须配置管理令牌，后台支持浏览器 Basic Auth
> （密码填令牌）及 Bearer Token。`ANTHROPIC_*` 为宿主注入的密钥，只读、不写盘。

网关关键事实（已实测验证）：认证用 `x-api-key` + `anthropic-version: 2023-06-01`；
结构化输出走强制 `tool_use`，**网关会改写返回的 tool 名**，因此按 block 类型（而非名字）提取；
真实模型 ID：`claude-haiku-4-5-20251001` / `claude-sonnet-5` / `claude-opus-4-8`。

## 开发

```bash
bun install
bun test                              # 全部离线单测/契约测试
HOMEBRAIN_LIVE=1 bun test packages/llm/src/gateway.live.test.ts   # 真调网关
HOMEBRAIN_LIVE=1 bun test packages/core/src/dream.live.test.ts    # 真跑提炼
HOMEBRAIN_LIVE=1 bun test packages/core/src/ask.live.test.ts      # 真跑问答
bunx tsc -p tsconfig.json --noEmit    # 类型检查
```

## 本地测试

按「想测什么」选，从快到全共四种。前提：`bun` 在 PATH 上（`curl -fsSL https://bun.sh/install | bash`）。

### 1. 快速回归（离线 · 最快 · 不联网不花钱）

每次改完代码先跑这个。测试全程用假 LLM / 假 CLI runner，`ANTHROPIC_*` 只是占位：

```bash
export ANTHROPIC_BASE_URL=http://localhost:0 ANTHROPIC_AUTH_TOKEN=test
bun test
bunx tsc -p tsconfig.json --noEmit
```

### 2. 点管理后台（离线 · 推荐先用）

```bash
bun run packages/web/src/dev.ts        # http://localhost:3000（启动日志：LLM=离线假回答）
```

能测**全部界面**：空间/知识、Agents、任务、Integrations、运行状态、数据治理、设置——增删改、开关、落盘、任务「立即运行」都可验证。
问答框与任务运行返回**固定假答案**（不 spawn 真 CLI，秒回），看不到真实模型效果。数据写 `./data`（或 `HOMEBRAIN_DATA_DIR`）。

### 3. 后台真跑本机 CLI（能看到真实效果 · 慢）

```bash
export ANTHROPIC_BASE_URL=https://api.gameaigc.cn ANTHROPIC_AUTH_TOKEN=sk-...   # claude CLI 用它鉴权
HOMEBRAIN_DEV_REAL_CLI=1 bun run packages/web/src/dev.ts                        # 启动日志：LLM=真实本机 CLI
```

给某群指定 Agent（或在设置里配默认 CLI），问答/任务会真的 spawn `claude`/`trae-cli`。单次数秒，任务的即时提炼会再多调几次。

### 4. 终端模拟飞书（repl · 不接飞书跑通全主干 · 会真跑 CLI）

```bash
export ANTHROPIC_BASE_URL=https://api.gameaigc.cn ANTHROPIC_AUTH_TOKEN=sk-...
bun run packages/app/src/repl.ts       # 启动横幅列出全部命令
```

行内命令：`/at <text>`（群内 @ 提问）、`/group <text>`（群内不 @，静默收录）、`/added`（模拟入群）、
`/dream`（立即提炼）、`/task ...`（管理个人空间任务；`/at /task ...` 管群空间），其余按私聊处理。典型闭环：

```
/group Alice 负责后端，主导架构。      # 收录到群空间
/dream                                # 提炼成知识页
/at 谁负责后端？                       # @提问，带引用作答
/at /task new 每周AI进展               # 在群空间建研究任务
/at /task run 每周AI进展               # 立即跑（写库 + 即时提炼）
```

> **注意事项**：
> - 第 3、4 种会 **spawn 真 claude/trae-cli**：慢、有开销，且 CLI **用它自己的鉴权和模型**，不一定尊重 homebrain 里选的 model；想快速点功能用第 2 种。
> - repl **必须设 `ANTHROPIC_*` 两个变量**，否则 `config()` 报 `missing required env var` 起不来（dev server 会自动塞占位，不受影响）。
> - 本机 `codex` 之前探测不可用（WSL 无 Linux node），`claude`/`trae-cli` 可用；后台每次启动**实时探测**，以界面显示为准。

## 管理后台（mew 风格，可读写）

左侧导航分八区：

- **空间 / 知识**：空间列表、知识页、原始条目、问答测试、手动触发提炼。
- **Agents**（中列列表 + 右侧编辑器）：新建 / 编辑 / 删除智能体，配置 **名称、Provider、Instruction（人格，会注入到回答）、Model、Visibility**。
  - **Provider = 本机已安装的 agent CLI**（`claude` / `codex` / `trae-cli`）。**所有 LLM 工作（问答 ask + 提炼 dream + 任务）都通过本机 CLI 子进程执行，homebrain 不直连任何网络 API**。后台**探测本机** CLI，只让可用的可选（装了但跑不了的灰显并标注原因，如 WSL 下无 Linux node 的 codex）。
  - **Model 随 Provider 变化**（对齐 mew）：切 Provider 时 Model 下拉自动换成该 provider 的模型清单（CLI 无「列模型」接口，为维护清单；codex 对齐 mew：`gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark`）。
- **任务**（研究任务执行）：新建定期任务，让某空间的 Agent CLI 定期研究一个主题；产出**存为该空间的原始材料**（`source=task`），**运行结束立即触发一次本空间提炼**（当场变成 wiki 知识页，而非等夜间），并可**推送摘要到该空间绑定的飞书群/私聊**。
  - 字段：名称、目标空间、研究主题、周期（每天几点 / 每小时）、启用开关、推送开关。
  - **定时**（TaskScheduler，每任务独立周期，启动即 catch-up）+ **后台「立即运行」**（fire-and-forget，研究较慢，完成后刷新看状态）。
  - 研究以**只读**方式跑（复用精简/只读 CLI 模式），不改文件、不跑命令。任务写入是异步的，不占用空间写锁；即时提炼是尽力而为——失败不影响任务成功，原始材料仍会被夜间提炼兜底。
  - **飞书里也能管任务**（`/task` 命令，在群或私聊，控制消息不会被当成知识收录）：
    - `/task` 或 `/task list` — 查看本空间任务
    - `/task new <主题>` — 新建每日研究任务（写入本空间）
    - `/task run <名称或序号>` — 立即运行
    - `/task help` — 帮助
  - **消息撤回**：回复原消息，@机器人说「别记这条」。原作者、群主或群管理员可执行；系统会删除该消息派生的全部原始记录，二次撤回会明确提示且事件重投不会重新入库。若内容已经进入知识页，会先移除受影响页面，再用仍有效的来源完成重新提炼后回复。撤回控制命令本身不会入库。
- **Integrations**：**Lark bot**（收发消息的机器人身份）+ **Lark groups**（每个群：指定 Agent、`Topic reply`、`@ mentions only` 开关）。
- **运行状态**：集中展示飞书事件消费者、必需 CLI、知识存储、待提炼数量、任务、Dream Cycle 与两个调度器的状态；任一关键组件未就绪时，所有后台页面会显示异常提示。
- **数据治理**：按空间导出 `homebrain.space v1` JSON 完整备份（知识页、原始记录、撤回标记、任务、空间元数据及关联 Agent），恢复备份，或永久删除整个空间；可按保留周期立即清理已提炼的过期消息。
- **设置**：**默认 Provider + 默认 Model**（群未指定 Agent 时用它）、每日预算、提炼时刻、原始消息保留周期、端口。

后台默认只监听 `127.0.0.1`，无需登录。若通过 `HOMEBRAIN_WEB_HOST` 开放到非回环地址，启动时会强制要求
`HOMEBRAIN_WEB_ADMIN_TOKEN`；除 `/healthz`、`/readyz` 外的所有页面与操作都需要认证。
非本机访问应置于 HTTPS 反向代理之后；不要在不可信网络上直接使用明文 HTTP 传输管理令牌。

对上 mew 的 `Codex Agent · Topic reply · @ mentions only`：给群指定 Agent 后，回答用该 Agent 的 CLI 与人格；
关掉 `@ mentions only` 则群内任意消息都会应答；`Topic reply` 控制是否在话题内回复。
群没指定 Agent 时用「设置」里的默认 CLI；若没有可用 CLI，机器人会提示去后台配置（不静默）。

### 附件提炼（P2 首版）

飞书直接发送的图片和文件消息会通过 bot 身份下载并在本机提取文字，再作为同一条消息的原始材料进入知识库。
首版支持 UTF-8 编码的 `.txt`、`.md`、`.markdown`、`.csv`、`.json`、`.log` 文件、图片 OCR，
以及 PDF 已有文本层的提取；扫描版 PDF 不会自动执行 OCR。单个附件下载上限为 20 MiB，
每个附件最多保留 200,000 个提取字符，超限、损坏或不支持的附件会安全跳过，不影响原消息收录和回复。
资源元数据查询和下载各有 30 秒超时，下载期间会监视输出文件大小；本地图片/PDF 提取总计最多 60 秒，
图片在解码前还会执行 4,000 万像素上限检查。

提取记录保留原飞书 `messageId`，因此回复原消息执行「别记这条」、原始消息保留策略、空间导出和空间删除
都会覆盖这些派生记录。macOS 使用系统自带的 Vision/PDFKit；其他平台仍可提取上述 UTF-8 文本文件，
但会安全跳过图片 OCR 和 PDF 文本提取。音频转写、Office 文件、视频理解和 `post` 消息内嵌资源暂不支持。

> **CLI-only 的代价（务必知悉）**：claude/trae-cli 是完整编码 agent，单次调用**慢、开销大**，dream 批量提炼会明显变慢；它们**自带鉴权和模型选择**，不一定尊重你在 homebrain 里选的 model。dream 的结构化抽取靠"让 CLI 只输出 JSON + 解析校验 + 失败跳过（quarantine）"，偶有条目建不出页。每日预算仅对可计费的 provider 有意义。

### 生产启动（接真实飞书）

```bash
bun run packages/app/src/main.ts
# 或 bun start
```

启动后：feishu 连接器监听事件、管理后台在 `HOMEBRAIN_WEB_HOST:HOMEBRAIN_WEB_PORT`、调度器做启动 catch-up + 每日 03:00 提炼，并按保留周期清理已提炼的过期消息。
SIGTERM/SIGINT 优雅退出（对 lark-cli 子进程发 SIGTERM，绝不 kill -9）。

部署探针：`GET /healthz` 是不依赖外部组件的快速进程存活检查，始终返回 200；`GET /readyz` 只有在知识存储、必需 CLI、两条飞书事件消费者及两个调度器都可用时返回 200，否则返回 503。管理后台 `/health` 提供完整健康快照的人类可读视图。

## 需人工完成的飞书配置

代码已就绪，但以下需在飞书开放平台 / 开发者后台操作（一次性）：

1. **订阅事件**：在开发者后台为应用启用
   - `im.message.receive_v1`（接收消息）— **已验证可用**
   - `im.chat.member.bot.added_v1`（机器人入群）— **已验证可用**
   - 群内非 @ 消息的静默收录还需要敏感权限 `im:message.group_msg`；只有 @ 消息权限时，机器人收不到普通群消息。
2. **把机器人拉进一个飞书群**，或私聊它，触发空间创建。之后即可 @ 提问、发文档链接入库。
3. user 身份 token 到期会在下次 user API 调用时自动刷新（文档同步用 user 身份）。

## 实施状态

MVP = Slice 0–6，均已完成并通过测试；Slice 7（调度器 + 端到端联调）亦已完成。
后续已完成：学习任务、真实飞书 E2E、思考表情、精确消息撤回、健康检查与可观测性（`/healthz`、`/readyz`、运行状态页与异常提示）、空间导出/恢复/删除、原始消息保留策略、非本机后台鉴权，以及 P2 首版附件提炼。
未纳入 MVP（已预留）：每日反馈，以及音频、Office、视频和 `post` 内嵌资源的进一步多模态提炼。
