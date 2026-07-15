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

## 普通用户安装（macOS 13+）

正式发布后，普通用户只需下载与 Mac 架构对应的 DMG，把 `Homebrain.app` 拖入“应用程序”并双击：

1. Homebrain 自动安装并启动当前用户的后台服务，然后在默认浏览器打开设置向导。
2. 点击“安装并连接 ChatGPT”，明确同意后由 Homebrain 下载、校验并安装 OpenAI 官方 Codex；登录在
   OpenAI 官方页面完成，不需要复制 API Key。
3. 点击“一键创建飞书机器人”，在飞书页面确认。Homebrain 会自动申请运行权限、验证机器人身份，并引导完成消息监听。
4. 如需加入外部群，向导会直达当前应用并列出对外共享发布项；完成飞书版本发布和管理员审批后，用一条真实外部群消息验证。
5. 把机器人加入群聊并发送第一条测试消息；向导确认真实消息到达后进入知识空间。

应用包已自带 Bun 运行时、`lark-cli` 和 macOS 附件提取助手，用户不需要安装 Git、Bun、Node、npm、
Homebrew 或全局 CLI。知识数据保存在 `~/Library/Application Support/Homebrain`，日志保存在
`~/Library/Logs/Homebrain`；替换应用版本不会覆盖知识数据。

> 当前仓库提供 beta 构建与发布流水线。面向外部分发的 DMG 仍须由维护者配置 Apple Developer ID
> 签名/公证凭据，并完成 Bun 等二进制再分发审查；未经签名的本地构建仅供开发验证。

## 从源码运行的环境要求

- **Bun**（`curl -fsSL https://bun.sh/install | bash`），Node v22 仅作参考。
- **Agent CLI**：至少安装并登录 `claude`、`codex`、`trae-cli` 之一。旧 LLM 网关仅用于兼容测试，生产主流程不依赖它。
- **飞书 `lark-cli`**：需已安装并可执行。首次启动可在浏览器里一键创建并验证飞书应用；
  附件下载使用 bot 身份，应用需开通 `im:message:readonly` 权限。读取用户文档时的 user 授权仍由
  `lark-cli auth login` 管理。

### 环境变量

```bash
# 可选：仅旧网关客户端/网关 live test 使用；生产主流程无需配置
export ANTHROPIC_BASE_URL=https://api.gameaigc.cn
export ANTHROPIC_AUTH_TOKEN=sk-...
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
> （密码填令牌）及 Bearer Token。可选的 `ANTHROPIC_*` 只在调用旧网关客户端时校验，只读、不写盘，
> LaunchAgent 也不会保存它们。

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

每次改完代码先跑这个。测试全程用假 LLM / 假 CLI runner，无需配置网关变量：

```bash
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
HOMEBRAIN_DEV_REAL_CLI=1 bun run packages/web/src/dev.ts   # 启动日志：LLM=真实本机 CLI
```

给某群指定 Agent（或在设置里配默认 CLI），问答/任务会真的 spawn `claude`/`trae-cli`。单次数秒，任务的即时提炼会再多调几次。

### 4. 终端模拟飞书（repl · 不接飞书跑通全主干 · 会真跑 CLI）

```bash
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
> - 本机 `codex` 之前探测不可用（WSL 无 Linux node），`claude`/`trae-cli` 可用；后台每次启动**实时探测**，以界面显示为准。

## 管理后台（mew 风格，可读写）

左侧导航分九区：

- **空间 / 知识**：空间列表、知识页、原始条目、问答测试、手动触发提炼。
- **Agents**（中列列表 + 右侧编辑器）：新建 / 编辑 / 删除智能体，配置 **名称、Provider、Instruction（人格，会注入到回答）、Model、推理强度、Visibility**。
  - **Provider = 本机已安装的 agent CLI**（`claude` / `codex` / `trae-cli`）。**所有 LLM 工作（意图分类 + 问答 ask + 提炼 dream + 任务）都通过当前空间配置的本机 CLI 子进程执行，homebrain 不直连任何网络 API**。后台**探测本机** CLI，只让可用的可选（装了但跑不了的灰显并标注原因，如 WSL 下无 Linux node 的 codex）。
  - **Model 随 Provider 变化**：切 Provider 时 Model 下拉自动换成该 provider 的维护清单（CLI 无“列模型”接口）；Codex 当前提供 `gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna / gpt-5.5 / gpt-5.4 / gpt-5.4-mini / gpt-5.3-codex-spark`。其中 `gpt-5.6-sol` 是 GPT-5.6 Sol 的完整模型 ID；Homebrain 日常问答优先选择较快、成本更低的 `gpt-5.6-luna`，复杂研究可选择 `gpt-5.6-terra` 或 `gpt-5.6-sol`。
  - **推理强度按 Agent 配置**：Codex Agent 可选择继承默认值，或从当前模型支持的档位中选择；GPT-5.6 系列支持 `none / low / medium / high / xhigh / max`，旧模型不会显示不支持的档位。普通问答建议从 `medium` 开始，级别越高通常耗时和 token 越多。其他 Provider 暂不传递此配置。
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
- **提醒**（与研究任务、知识记忆相互独立）：在群聊或私聊中 @机器人说“周日上午提醒我去茶饼斋”或“1 小时后提醒我喝水”，系统会把解析出的上海时区具体时间回显并持久化；未识别出时间时不会假装已经保存。
  - “我最近一周有什么安排”“我这周有哪些安排”直接查询提醒数据，不依赖夜间知识提炼。
  - 支持“确认/完成……”“取消……的提醒”“把……的提醒延后 2 小时”。管理后台也可查看、完成或取消提醒。
  - 支持“提前 2 天提醒……，每隔 3 小时重复，直到确认”；重复提醒会明确要求在群里回复并 @机器人确认。
  - ReminderScheduler 每 30 秒检查到期提醒，启动时会补发停机期间到期的提醒；只有飞书发送成功后才推进状态，失败会保留待重试。
- **飞书连接**：首次连接使用引导式设置，一键创建飞书应用并自动识别 Bot 名称与 open_id；也保留
  App ID / App Secret 手动接入作为高级选项。连接页展示消息监听汇总状态；每个群可指定 Agent、`Topic reply`、
  `@ mentions only`，并直接发送测试消息验证发送通道。对外共享状态按 App ID 独立记录，更换机器人后不会沿用
  旧机器人的验证结果。
- **运行状态**：集中展示后台托管方式、PID、启动时间、两条飞书事件消费者的详细状态、必需 CLI、知识存储、任务、提醒、Dream Cycle 与三个调度器；LaunchAgent 托管时可从页面安全重启。
- **数据治理**：按空间导出 `homebrain.space v1` JSON 完整备份（知识页、原始记录、撤回标记、任务、提醒、空间元数据及关联 Agent），恢复备份，或永久删除整个空间；可按保留周期立即清理已提炼的过期消息。
- **设置**：**默认 Provider + 默认 Model**（群未指定 Agent 时用它）、每日预算、提炼时刻、原始消息保留周期、端口。

后台默认只监听 `127.0.0.1`，无需登录。若通过 `HOMEBRAIN_WEB_HOST` 开放到非回环地址，启动时会强制要求
`HOMEBRAIN_WEB_ADMIN_TOKEN`；除 `/healthz`、`/readyz` 外的所有页面与操作都需要认证。
非本机访问应置于 HTTPS 反向代理之后；不要在不可信网络上直接使用明文 HTTP 传输管理令牌。

对上 mew 的 `Codex Agent · Topic reply · @ mentions only`：给群指定 Agent 后，回答用该 Agent 的 CLI 与人格；
关掉 `@ mentions only` 则群内任意消息都会应答；`Topic reply` 控制是否在话题内回复。
群没指定 Agent 时用「设置」里的默认 CLI；若没有可用 CLI，机器人会提示去后台配置（不静默）。

### 首次启动与飞书连接

1. 普通用户双击 `Homebrain.app`；源码开发者运行 `bun start`。全新数据目录会自动进入 `/setup`。
2. 应用包用户点击“安装并连接 ChatGPT”即可完成 Codex 下载、校验与 OpenAI 官方登录；源码运行会提供
   已检测到的 Codex、Claude Code 或 TRAE CLI，并把手动安装命令留在高级路径。
3. 点击“一键创建飞书机器人”，在飞书官方页面确认。Homebrain 通过官方 Node SDK 显式提交完整授权清单，
   一次申请私聊、群内 @、群内全部消息、消息读取/发送、附件、表情、群信息、机器人进群权限和两条事件订阅。
   App Secret 只通过 stdin 写入 `lark-cli` 的系统钥匙串，不进入 Homebrain 设置、页面或日志。
4. `im:message.group_msg` 是敏感权限；如果企业启用了自建应用审核，管理员会在这次创建确认中批准。
   不需要用户创建完成后再进入开放平台逐项补权限或事件。
5. 如需对外共享，向导会打开当前应用。进入“应用发布 → 版本管理与发布 → 创建版本”，开启
   “允许机器人被添加到外部群中使用”和“允许外部用户与机器人单聊”，然后保存、提交发布并完成管理员审批。
   这两个开关不属于飞书 SDK 的创建权限清单，当前不能由 Homebrain 代替用户或管理员自动开启；可选择“暂时仅内部使用”。
6. LaunchAgent 托管时点击“激活消息监听”安全重启；源码运行时重启 `bun start`。
7. 发布获批后，把机器人加入一个外部群并发送“@机器人 对外共享测试”。Homebrain 会通过只读群信息接口确认该群
   确实是外部群，而且只接受点击“开始验证”之后收到的消息。随后把机器人加入目标群，@机器人发送第一条知识测试消息；
   Homebrain 会按 `chat_id` 自动建立群知识空间。

已有应用可在“手动输入 App ID”中接入。App Secret 只通过子进程 stdin 交给
`lark-cli config init --app-secret-stdin`，不会写入 `data/config/settings.json`、页面或日志。后续可从
“飞书连接”重新进入引导、验证现有配置、调整群聊 Agent 与回复方式。

一键创建使用飞书官方智能体应用模板，并通过 `addons` 显式叠加 Homebrain 的全部运行时权限和事件。
敏感权限 `im:message.group_msg` 也在首次确认中申请；若企业要求审核，需在创建阶段由管理员批准。
Homebrain 只有在 `im.message.receive_v1` 和 `im.chat.member.bot.added_v1` 都通过有界监听验证后才显示创建完成。
若飞书仍漏配事件，创建页会直接给出官方增量授权链接并持续复检，不要求用户进入开发者后台操作。
已有应用仍可在“更多设置”中通过 App ID / App Secret 接入。
Provider 自身的登录授权仍由对应 CLI 管理。

### 构建 macOS 应用

本机开发构建（仅生成 ad-hoc 签名的当前架构应用）：

```bash
bun install --frozen-lockfile
bun run build:macos --target arm64 --allow-dirty
bun run smoke:macos --app dist/Homebrain.app
```

正式发布由 `v*` tag 触发 GitHub Actions，分别在 Apple Silicon 与 Intel runner 上构建，签名嵌套可执行文件，
生成并公证两个架构的 DMG，最后发布带 SHA-256 的更新清单。流水线要求 Apple 签名/公证 secrets，且只有
仓库变量 `BINARY_REDISTRIBUTION_APPROVED=true` 时才允许进入二进制发布阶段。

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

### macOS 后台常驻（P3.2）

在仓库根目录安装当前用户的 LaunchAgent；安装后关闭终端不影响运行，重新登录 macOS 会自动启动：

```bash
bun run service install
bun run service status
```

常用维护命令：

```bash
bun run service start
bun run service stop
bun run service restart
bun run service logs                 # 最近 100 行 stdout/stderr
bun run service logs --lines 300 --follow
bun run service status --json
bun run service uninstall            # 保留 data 与日志
```

服务定义写在 `~/Library/LaunchAgents/com.homebrain.agent.plist`，日志写到
`$HOMEBRAIN_DATA_DIR/logs/service.{stdout,stderr}.log`（默认仓库内 `data/logs`）。plist 权限为 0600，
只包含 HOME、PATH、数据目录和托管标记，不保存 Anthropic 或后台管理密钥。主进程使用
`data/run/homebrain.lock` 上由内核自动释放的 advisory lock 阻止重复实例；SIGTERM/SIGINT 仍会优雅停止
所有子进程。活动日志超过 10 MiB 时会保留最近 1 MiB 并轮转 3 份，所有日志文件权限均为 0600。

部署探针：`GET /healthz` 是不依赖外部组件的快速进程存活检查，始终返回 200；`GET /readyz` 只有在知识存储、必需 CLI、两条飞书事件消费者及 Dream Cycle、任务、提醒三个调度器都可用时返回 200，否则返回 503。管理后台 `/health` 提供完整健康快照的人类可读视图。

## 飞书权限边界

一键创建在首次飞书确认页显式申请以下 Homebrain 运行时能力：

- 消息接收：`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、
  `im:message.group_at_msg.include_bot:readonly`、`im:message.group_msg`；
- 消息处理：`im:message:readonly`、`im:message:send_as_bot`、`im:resource`、
  `im:message.reactions:write_only`；
- 群与机器人：`im:chat:read`、`im:chat.members:bot_access`、`application:bot.basic_info:read`；
- 文档只读同步：`drive:drive.metadata:readonly`、`docx:document:readonly`、`wiki:node:read`；
- 事件订阅：`im.message.receive_v1` 和 `im.chat.member.bot.added_v1`。

用户仍需在飞书官方页面确认；如果企业启用了自建应用审核，管理员会在这次创建流程中批准本次安装。
机器人加入群聊或收到私聊后会自动创建空间，文档同步所用的 user 身份 token 到期时会在下次 API 调用时自动刷新。

对外共享是单独的发布能力，不是可随创建 `addons` 自动授予的权限。Homebrain 会直达当前 App、引导开启外部群与
外部私聊两个开关，并在管理员审批后用真实外部群消息验证；验证进度与 App ID 绑定。飞书企业/团队认证、个人实名认证、
版本发布及管理员审批仍由飞书官方页面处理。

群内非 @ 消息的静默收录使用敏感权限 `im:message.group_msg`。该权限已经放进首次创建确认页；请仅在确有需要时
关闭 `@ mentions only`。如果管理员在创建阶段未批准，请保持 @ 模式；非 @ 消息不会被飞书推送给机器人。

## 实施状态

MVP = Slice 0–6，均已完成并通过测试；Slice 7（调度器 + 端到端联调）亦已完成。
后续已完成：学习任务、真实飞书 E2E、思考表情、精确消息撤回、健康检查与可观测性（`/healthz`、`/readyz`、运行状态页与异常提示）、空间导出/恢复/删除、原始消息保留策略、非本机后台鉴权、P2 首版附件提炼、P3.1 飞书配置向导、P3.2 macOS LaunchAgent 后台常驻与服务管理，以及 P4.1 CLI-only 意图路由。
未纳入 MVP（已预留）：每日反馈，以及音频、Office、视频和 `post` 内嵌资源的进一步多模态提炼。
