# Alphion TUI 边界

`tui/` 是 v0.3.1 的 Ink/React 终端适配器。运行 `alphion tui` 或 `npm run tui` 可进入简体中文“工程工作台”，查看 Project Profile/诊断、配置 provider、导入加密 API key，并执行一次受控 Agent 任务。

## 职责

TUI 负责终端输入、增量渲染、键盘交互、审批提示和本地会话导航。它把用户操作转换为核心应用服务调用，并把核心事件 reducer 投影为文本界面，但不拥有 Agent 决策、权限判断或长期状态规则。

## 依赖方向

```text
terminal input -> TUI adapter -> core command boundary
terminal view  <- TUI adapter <- core event boundary
```

- 核心永远不能导入 `tui/`。
- TUI 只消费核心公开的版本化合同和本地 application façade，不直接解析状态文件。
- TUI 不得直接调用模型、Git、进程、网络、缓存或存储；这些能力由核心端口和策略统一控制。
- Provider/模型配置必须通过核心配置服务提交；TUI 不得直接打开或迁移 `.alphion/alphion.sqlite3`。
- Ink/React 只存在于本目录；核心和 provider adapter 不得导入 UI 运行时。

## 共享协议草案

命令至少携带 `schemaVersion`、`requestId`、`sessionId`、`idempotencyKey`、`expectedRevision`、`kind` 和类型化 `payload`。事件至少携带 `schemaVersion`、单调递增的 `sequence`、`eventId`、`sessionId`、`correlationId`、`causationId`、`timestamp`、`kind` 和类型化 `payload`。

适配器只能提交意图；核心负责验证、授权和落盘。重试必须复用幂等键。若 `expectedRevision` 已过期，核心返回冲突事件，TUI 重新同步事件游标，不能静默覆盖新状态。

## 当前交互

- 首页概览、项目画像、Provider/Vault、任务运行和只读诊断五个工作区；
- 100 列及以上使用侧栏，窄终端使用顶部导航，低于 18 行启用紧凑布局；
- 品牌紫 `#A377F6` 作为唯一主强调色，状态始终同时显示文字/符号，并支持 `NO_COLOR`；
- vault 初始化/解锁，遮罩输入主密码；
- provider 列表、新增/编辑/激活及 API key 导入、轮换和删除；
- 单次任务输入、流式答案、工具审批、取消、token 用量；
- DeepSeek reasoning 默认折叠并标记为“非证据”。

数字键或 Tab 切换区域，Enter 确认，Esc 返回首页，`?` 查看帮助，`q` 退出。Ctrl+C 在任务运行中优先取消任务。Provider 预设由本地 application façade 提供，TUI 不导入 DeepSeek 或其他模型 adapter 常量。

界面使用进程内异步事件流，不创建守护进程或网络服务。显示层最多约 30 FPS 合并模型 delta，但最终文本、审批和审计事件不会丢失。

## 明确不属于本目录

- Agent 推理、Harness 选择、自我进化和评估逻辑；
- 命令/事件的权威类型、验证器和 reducer；
- 凭据加密/解析、权限扩大或审批规则；
- 直接读写核心 JSON/JSONL 状态；
- Web 服务、浏览器资源和跨用户会话管理。

API key 和主密码只在遮罩输入及应用服务调用期间位于内存；界面不得显示、记录或缓存它们。vault 的加密、迁移、自动锁定和恢复限制由 adapter/application 层统一实现。
