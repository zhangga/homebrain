# homebrain 文档索引

homebrain —— 面向家庭的长期记忆 AI 助手。本地优先、单家庭、自托管。

家人日常对话、重要事情、待办、学习计划都能被它自动记住、主动总结、按人派发，把"家庭记忆"沉淀成越用越有价值的护城河。

## 文档

| 文档 | 内容 |
|---|---|
| [项目框架](./architecture.md) | 目录结构、各模块职责、数据流、依赖方向 |
| [实施计划](./implementation-plan.md) | 分片落地路线（地基 → Slice 0~5）、前置条件、验收标准、风险表 |
| [Slice 0 gbrain contract 实测记录](./slice0-gbrain-contract.md) | gbrain `v0.42.52.0` CLI 行为、输出样例、fallback 决策 |

## 核心决策一览

| 维度 | 决策 |
|---|---|
| 形态 | 本地优先、单家庭、自托管 |
| 基座 | `gbrain`（github.com/garrytan/gbrain）当锁版本外部依赖，不 fork |
| 入口 | 飞书 Bot（connector 可插拔，以后可加微信/QQ/Telegram/CLI） |
| 栈 | TS + Bun |
| 编排层 LLM | Claude（最新模型） |
| 隐私边界 | 务实型：原始聊天记录 + 记忆库只在本机；抽取/问答/总结/embedding 可调云端 API（不长期留存） |
| 成员映射 | gbrain Model B：单 source + `partners/<slug>/` 文件夹 + `USER.md` 画像 |

## v1 范围（"三件事"，只做这些）

1. **记忆闭环**：家人在飞书群随手说/转发/拍照 → Claude 抽取要点 → 写进 gbrain 知识图谱（归到对应成员）→ @bot 问答，回答带引用。后台 dream-cycle 去重/找矛盾/摘要。
2. **主动播报**：cron 定时发到群——每日早安简报、每周家庭周报、"那年今日"。
3. **一个任务派发闭环**：成员设一个阅读/学习目标 → Claude 拆解成日程 → 每天派当天份额 → 收反馈回写并调整后续。
