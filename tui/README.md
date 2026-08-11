# Alphion TUI 边界

`tui/` 是未来终端用户界面的适配器边界。当前目录只有本说明，没有可执行代码、独立包或 UI 依赖；v0.2.1 的一次性 CLI 位于根级 `cli/`，不属于本目录。

## 职责

未来 TUI 负责终端输入、增量渲染、键盘交互、审批提示和本地会话导航。它可以把用户操作转换为核心命令，并把核心事件投影为文本界面，但不能拥有 Agent 决策、权限判断、事件归并或长期状态规则。

## 依赖方向

```text
terminal input -> TUI adapter -> core command boundary
terminal view  <- TUI adapter <- core event boundary
```

- 核心永远不能导入 `tui/`。
- TUI 只能消费核心公开的版本化合同，不得复制私有事件类型或直接解析状态文件。
- TUI 不得直接调用模型、Git、进程、网络、缓存或存储；这些能力由核心端口和策略统一控制。
- Provider/模型配置必须通过核心配置服务提交；TUI 不得直接打开或迁移 `.alphion/alphion.sqlite3`。
- 当前不选择 Ink、Blessed 或其他终端框架。只有可访问性、输入能力和性能基准证明需要时，才评估可替换适配器。

## 共享协议草案

命令至少携带 `schemaVersion`、`requestId`、`sessionId`、`idempotencyKey`、`expectedRevision`、`kind` 和类型化 `payload`。事件至少携带 `schemaVersion`、单调递增的 `sequence`、`eventId`、`sessionId`、`correlationId`、`causationId`、`timestamp`、`kind` 和类型化 `payload`。

适配器只能提交意图；核心负责验证、授权和落盘。重试必须复用幂等键。若 `expectedRevision` 已过期，核心返回冲突事件，TUI 重新同步事件游标，不能静默覆盖新状态。

## 未来连接方式

默认使用进程内异步迭代器或流，避免为了本地 TUI 引入常驻服务。断线或重启后，适配器从最后确认的 `sequence` 恢复；渲染较慢时发送背压信号并允许合并非审计类进度事件，审计事件不得丢弃。

## 明确不属于本目录

- Agent 推理、Harness 选择、自我进化和评估逻辑；
- 命令/事件的权威类型、验证器和 reducer；
- 凭据解析、权限扩大或审批规则；
- 直接读写核心 JSON/JSONL 状态；
- Web 服务、浏览器资源和跨用户会话管理。

引入首个 TUI 源文件前，必须复用 v0.2.1 的 `AgentRunHandle` 异步事件流、配置服务、取消语义、事件重放和权限门禁，不得另建一套运行循环。
