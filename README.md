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
| `packages/web` | Hono 只读后台（空间/知识页/raw/日志/问答测试框） |
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
- **飞书 `lark-cli`**：已配置应用 + bot/user 授权。

### 环境变量

```bash
export ANTHROPIC_BASE_URL=https://api.gameaigc.cn   # 已注入
export ANTHROPIC_AUTH_TOKEN=sk-...                  # 已注入
export HOMEBRAIN_DATA_DIR=./data                    # 默认 ./data
export HOMEBRAIN_LLM_MODEL=claude-sonnet-5          # ask/提炼默认模型
export HOMEBRAIN_DAILY_BUDGET_USD=5                 # 每日预算
export HOMEBRAIN_WEB_PORT=3000                      # 只读后台端口
# 可选：精确 @ 识别（否则群内任意 @ 都视为叫机器人）
export HOMEBRAIN_FEISHU_BOT_NAME=homebrain
export HOMEBRAIN_FEISHU_BOT_OPEN_ID=ou_xxx
```

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

### 终端模拟飞书（不接飞书跑通全主干）

```bash
bun run packages/app/src/repl.ts
```

行内命令：`/at <text>`（群内 @ 机器人提问）、`/group <text>`（群内不 @，静默收录）、
`/added`（模拟机器人被拉进群）、`/dream`（立即提炼）、其余按私聊消息处理。

典型闭环：

```
/group Alice 是我们团队的后端负责人，主导服务端架构和数据库设计。
/group 项目 Orion 由 Alice 带队，计划 Q4 上线。
/dream
/at 谁负责后端？
→ 🤖 Alice 负责后端…… — 依据：[[entities/alice|Alice]]、[[entities/project-orion|项目 Orion]]
```

### 生产启动（接真实飞书）

```bash
bun run packages/app/src/main.ts
# 或 bun start
```

启动后：feishu 连接器监听事件、只读后台在 `HOMEBRAIN_WEB_PORT`、调度器做启动 catch-up + 每日 03:00 提炼。
SIGTERM/SIGINT 优雅退出（对 lark-cli 子进程发 SIGTERM，绝不 kill -9）。

## 需人工完成的飞书配置

代码已就绪，但以下需在飞书开放平台 / 开发者后台操作（一次性）：

1. **订阅事件**：在开发者后台为应用启用
   - `im.message.receive_v1`（接收消息）— **已验证可用**
   - `im.chat.member.bot.added_v1`（机器人入群）— 当前未订阅，启动日志会打印精确的订阅链接；
     订阅前该消费者会重试有限次后自动放弃（不影响消息主链路）。
2. **把机器人拉进一个飞书群**，或私聊它，触发空间创建。之后即可 @ 提问、发文档链接入库。
3. user 身份 token 到期会在下次 user API 调用时自动刷新（文档同步用 user 身份）。

## 实施状态

MVP = Slice 0–6，均已完成并通过测试；Slice 7（调度器 + 端到端联调）亦已完成。
未纳入 MVP（已预留）：学习任务、每日反馈、多模态附件提炼、健康检查 lint。
