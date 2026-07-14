# P3.1 飞书配置向导

**Status:** Complete. Standards/Spec review findings were resolved before commit: setup now reuses the bounded connector executor, shared Lark value types live in `packages/shared`, verified identity persistence is centralized, and the UI keeps a restart warning until the running connector matches the configured Bot.

## Outcome

用户只通过 homebrain 管理后台即可完成现有飞书应用接入、Bot 身份同步、Agent 创建入口、群聊绑定和发送通道测试，不再需要手工查询 Bot open_id 或编辑 JSON。

## Requirements

- Integrations 页面提供 App ID、App Secret 和 Feishu/Lark 品牌配置。
- App Secret 只能通过 stdin 传给 `lark-cli config init --app-secret-stdin`，不得出现在 argv、homebrain 配置、日志或返回页面中。
- 配置后执行 `lark-cli auth status --json --verify`，自动保存已验证 Bot 的名称和 open_id。
- 已有 `lark-cli` 配置可以在不重新输入 Secret 的情况下重新验证并同步身份。
- 页面展示 `im.message.receive_v1` 与 `im.chat.member.bot.added_v1` 两条事件消费者的当前运行状态，并列出仍需在开放平台确认的权限、发布和可用范围检查项。
- 页面提供 Agent 管理入口；已有群聊可选择 Agent、回复模式并发送真实测试消息。
- 配置或身份变更明确提示需要重启，避免把当前进程快照误认为已热更新。
- 所有外部命令均有超时，错误不得回显 App Secret。

## Public test seams

- 管理后台 HTTP 路由：配置、重新验证、群聊绑定和测试消息。
- `LarkCliSetup` 端口：stdin/argv 安全契约和 Bot 状态解析。
- Integrations 的服务端 HTML：步骤、状态、权限提示和空 Secret 输入。

## Deferred

- 飞书开放平台本身的机器人能力、权限、事件订阅、版本发布和可用范围仍由管理员在开放平台操作。
- Provider CLI 的安装与登录授权不由本向导接管。
- homebrain 不接管 `lark-cli` 自己的凭据存储；系统钥匙串/加密配置属于后续安全交付阶段。
- Bot 身份和事件消费者暂不热切换；修改应用后重启进程生效。
