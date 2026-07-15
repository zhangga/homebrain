# P3.2 macOS 后台服务

## 目标

让 homeagent 在本机以 macOS LaunchAgent 长期运行，不依赖启动它的终端，并在管理后台提供可观察、可安全重启的服务入口。

## 对外接口

- `bun run service install`：安装并加载当前工作区的 LaunchAgent。
- `bun run service start|stop|restart|status|logs|uninstall`：管理服务生命周期。
- `bun run service status --json`：输出适合脚本消费的状态。
- 管理后台 `/health`：显示托管方式、PID 和启动时间；仅在 LaunchAgent 托管时显示重启按钮。

## 运行约束

- LaunchAgent 标签固定为 `com.homeagent.agent`，登录后自动启动，异常退出后自动拉起。
- plist 只写入运行所需的非敏感环境（HOME、PATH、数据目录和托管标记）；不会写入 Anthropic 或管理后台密钥。
- 主进程使用数据目录中的内核 advisory lock 阻止重复启动；进程退出时由内核自动释放，并兼容回收旧版 PID 锁。
- SIGINT/SIGTERM 继续走现有优雅关闭流程；管理后台重启通过 SIGTERM 退出，由 launchd 拉起。
- `stop` 会先从 launchd 卸载服务，避免 KeepAlive 立即重启；`uninstall` 保留数据和日志。

## 验收

1. 安装后关闭启动终端，飞书问答和管理后台仍可用。
2. macOS 重新登录后服务自动恢复。
3. `status` 能看到 loaded/running/PID/启动时间，`logs` 能读取标准输出和错误日志。
4. 第二个手动实例会明确提示已有进程，而不是同时消费飞书事件。
5. 管理后台能显示服务状态并安全重启，重启后 PID 变化且服务恢复 ready。

## 暂不包含

- Linux systemd、Windows Service。
- 自动升级代码、远程服务管理。
- 将密钥迁移到 plist；密钥继续由各 CLI 自己的认证存储管理。
