# Slice 0 gbrain contract 实测记录

> 日期：2026-06-24。目标：把 gbrain 作为外部可执行依赖的真实行为记录下来，供 `packages/homebrain/src/gbrainCli.ts` 做 contract 测试与升级回归。

## 版本与安装

- 目标版本：`v0.42.52.0`。
- GitHub 远端没有找到 `refs/tags/v0.42.52.0`；当前 `~/gbrain` 的 `package.json` version 为 `0.42.52.0`，HEAD 为 `bb2e88c42a4969e16df7a43a9eb118aa031e89a4`。
- 已执行 `bun install && bun link`，可执行文件在 `/Users/jossyzhang/.bun/bin/gbrain`。
- 当前 shell 的 `PATH` 未必包含 `~/.bun/bin`；本项目可通过 `GBRAIN_BIN=/Users/jossyzhang/.bun/bin/gbrain` 显式指定。

## 目录环境变量

gbrain 使用 `GBRAIN_HOME` 作为 home 目录环境变量；`GBRAIN_DIR` 不生效。项目里的 `HOMEBRAIN_DIR` 会传给 gbrain 的 `GBRAIN_HOME`。

最小初始化命令：

```bash
rm -rf /tmp/homebrain-slice0-home
mkdir -p /tmp/homebrain-slice0-home
GBRAIN_HOME=/tmp/homebrain-slice0-home /Users/jossyzhang/.bun/bin/gbrain init --pglite --no-embedding --yes
```

初始化后 brain 位于：

```text
/tmp/homebrain-slice0-home/.gbrain/brain.pglite
```

注意：第一次误用 `GBRAIN_DIR` 时，gbrain 初始化到了默认 `~/.gbrain`。后续验证均使用隔离的 `/tmp/homebrain-slice0-home`。

## 命令矩阵

| 命令 | 退出码 | 输出形状 | contract 决策 |
|---|---:|---|---|
| `gbrain --version` | 0 | 文本：`gbrain 0.42.52.0` | `health()` 读取 stdout |
| `gbrain init --pglite --no-embedding --yes` | 0 | 文本日志 | 初始化由运维/Makefile 执行，不进库接口 |
| `gbrain capture <text> --source default --json` | 0 | JSON object | `captureText()` 继续解析 JSON |
| `gbrain put partners/<slug>/user --content <markdown>` | 0 | JSON object | `upsertProfile()` 用于写成员画像；gbrain slug 必须小写 |
| `gbrain get partners/<slug>/user` | 0 / 1 | markdown 文本；缺页时报 `Page not found` | `getProfile()` 返回 markdown；缺页归一为 `null` |
| `gbrain search <query>` | 0 | 文本结果：`[score] slug -- title` + snippet | `search()` 不带 `--json`，解析文本 |
| `gbrain query <question>` | 0 | 文本结果或 `No results.` | `query()` 不带 `--json`，返回原文 answer，并从 search 风格行抽 citations |
| `gbrain sync --source default` | 1（无 embedding key 时） | 文本错误 | `runDreamCycle()` 透传失败日志 |
| `gbrain sync --source default --no-embed` | 1（当前隔离 brain） | 文本错误：source 没有 `local_path` | `runDreamCycle({ noEmbed: true })` 已接入，但 sync 仍需先 `sources add <id> --path <path>` |
| `gbrain sources list` | 0 | 文本表格 | contract 层已解析 source id 与后续缩进行的 local path |
| `gbrain sources add homebrain --path <repo>` | 0 | 文本确认 | `GBRAIN_SOURCE_PATH` 配置存在时，homebrain 可在 sync 前自动注册缺失 source |
| `gbrain sources add default --path <repo>` | 1 | 文本错误：`default` 已存在 | `default` 在 `init` 后通常已是 federated source 且无 local_path；homebrain 不做 destructive remove/re-add，会给出可读失败 |
| `gbrain dream --dry-run --json` | 0 | phase 日志 + JSON 状态报告 | PGLite 可跑部分 phase；dry-run 无写入，status 可为 clean/partial |
| `gbrain dream --json` | 0 | phase 日志 + JSON 状态报告 | 真实执行 dream-cycle；即使 exit 0 也可能因 embed/provider 返回 `status: partial`，wrapper 按 report status 判断成败 |
| `gbrain doctor` | 非 0（当前本机） | 文本健康报告 | doctor 作为手工诊断；resolver/skills/provider 未齐时不能作为阻塞式健康检查 |

## 关键输出样例

`capture --json`：

```json
{
  "slug": "inbox/2026-06-24-d47e405f",
  "status": "created_or_updated",
  "chunks": 1,
  "content_hash": "...",
  "written": false,
  "source_kind": "capture-cli",
  "captured_at": "2026-06-24T03:01:19.066Z"
}
```

`search` 文本输出：

```text
[2.3333] inbox/2026-06-24-d47e405f -- # 老师电话是 138

老师电话是 138
```

`put` 成员画像输出：

```json
{
  "slug": "partners/dad/user",
  "status": "created_or_updated",
  "chunks": 1,
  "write_through": {
    "written": false,
    "skipped": "no_repo_configured"
  }
}
```

`get` 成员画像输出：

```text
---
type: concept
title: Dad
---

# Dad

- likes tea
```

`query` 在未配 embedding/provider 的隔离 PGLite 下：

```text
No results.
```

`sync` 在未配 embedding key 时：

```text
sync failed: Provider error during sync: Missing ZEROENTROPY_API_KEY
```

`sync --no-embed` 在未配置 source 本地路径时：

```text
Source "default" has no local_path. Run: gbrain sources add default --path <path>
```

## 项目 wrapper 实测

使用：

```bash
GBRAIN_HOME=/tmp/homebrain-slice0-home /Users/jossyzhang/.bun/bin/gbrain init --pglite --no-embedding --yes
```

再通过 `createHomebrain({ brainDir: "/tmp/homebrain-slice0-home", gbrainBin: "/Users/jossyzhang/.bun/bin/gbrain" })` 验证：

- `remember()` 可以写入。
- `search({ query: "校车" })` 可以返回命中。
- `ask({ question: "校车几点到" })` 在未配置 embedding/provider 时返回 `No results.`。
- `upsertProfile()/getProfile()` 可以写读 `partners/<slug>/user`；这是 gbrain slug 形态，对应设计里的 `partners/<slug>/USER.md`。

因此 Slice 1 的首个端到端闭环应先以 `remember + search` 验证写入/检索，再在 provider 配置完成后验证 `ask/query` 综合问答。

## 待跟进决策

1. `sync --no-embed` 已接入开发模式 fallback；`GBRAIN_SOURCE_PATH` 存在时，homebrain 会在 sync 前用 `sources list/add` 确保非 destructive 的本地 source 已注册。若要同步本地 markdown repo，建议使用非 `default` 的 `GBRAIN_SOURCE`（例如 `homebrain`）。
2. `dream --json` 已接入 `runDreamCycle()`；生产效果仍依赖 embedding/provider 配置，需要补一条带 key 的端到端验收记录。
3. `ask/query` 的生产效果依赖 embedding/provider；`.env.example` 已列出 provider key 位，仍需要补一条带 key 的端到端验收记录。
4. 成员画像写读已验证并接入；当前由 homeagent 本地规则维护 `USER.md` 托管区块，后续还可补更智能的周期性归纳。
5. `doctor` 当前受 resolver/skills/provider 影响，短期 `health()` 用 `--version` 更稳定。
