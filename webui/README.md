# Alphion WebUI 边界

`webui/` 是未来浏览器界面的适配器边界。当前目录只有本说明，没有前端工程、服务端实现、构建配置或 UI 依赖。

## 职责

未来 WebUI 负责浏览器交互、运行时间线、证据与产物查看、差异展示、审批界面和可访问的响应式呈现。它把用户意图发送为核心命令，并从核心事件构建只读投影；领域状态和安全决策仍由核心拥有。

## 依赖方向

```text
browser -> HTTP command adapter -> core command boundary
browser <- SSE/WebSocket adapter <- core event boundary
```

- 核心永远不能导入 `webui/`。
- WebUI 不得复制或重新解释权限、评估、进化和事件归并规则。
- Provider/模型配置必须作为核心命令提交；浏览器和服务端适配器不得直接读写或迁移 `.alphion/alphion.sqlite3`。
- 服务端适配器必须在信任边界验证所有浏览器输入，不能把 TypeScript 类型当作运行时验证。
- 当前不选择 React、Vue、Svelte、Vite 或服务框架；后续选择必须保持核心合同与界面技术无关。

## 共享协议草案

命令至少携带 `schemaVersion`、`requestId`、`sessionId`、`idempotencyKey`、`expectedRevision`、`kind` 和类型化 `payload`。事件至少携带 `schemaVersion`、单调递增的 `sequence`、`eventId`、`sessionId`、`correlationId`、`causationId`、`timestamp`、`kind` 和类型化 `payload`。

HTTP 接受命令并返回受理、拒绝或修订冲突；SSE 适合单向事件流，WebSocket 只在确有双向低延迟需求时启用。客户端保存最后确认的 `sequence`，重连时请求续传；无法续传时获取版本化快照，再从快照游标继续。

## 安全和并发

- 每个命令都绑定已认证主体、授权范围、CSRF/Origin 策略和短期会话；
- 日志、错误和事件投影必须在服务端完成秘密及私有路径脱敏；
- `idempotencyKey` 防止网络重试重复执行，`expectedRevision` 防止多标签页静默覆盖；
- 审批界面展示精确能力、资源、期限和计划摘要，计划变化后旧审批失效；
- 浏览器永远不直接获得模型、Git、文件系统或沙箱凭据。

## 明确不属于本目录

- Agent 推理、Harness 选择、自我进化和评估逻辑；
- 权威命令/事件类型、验证器、reducer 和审计日志；
- 数据库、模型 provider、Git、进程或沙箱的直接客户端；
- 未经核心策略确认的乐观领域状态；
- 当前阶段的部署、认证系统或多租户能力。

引入首个 WebUI 源文件前，必须复用 v0.2.1 的运行/事件、配置、取消和权限合同，并补充 HTTP + SSE/WebSocket 的输入验证、续传与传输级集成测试。
