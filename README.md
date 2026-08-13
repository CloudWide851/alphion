<p align="center">
  <img src="./alphion-logo.svg" alt="Alphion" width="280" />
</p>

# Alphion

Alphion 是一个面向不同软件项目、在证据和安全边界内持续优化 harness 的轻量 Agent 项目。

当前 **v0.7.0** 延续 `Project → shared Agent → Session → Run → ProviderConversationPlan → Tool`，修复连续对话的 prompt 重复与审计消息污染，增加共享 slash 命令、原地流式对话气泡、Provider catalog 门禁及每调用 Vault 凭据租约。SQLite 继续使用 user_version 6。

资源优先级固定为内置 → 用户共享 → 项目 `.alphion-resources/manifest.json` → Session overrides。扩展包仅支持声明式资源，不执行第三方 JavaScript。用户资源根可通过 `ALPHION_RESOURCE_HOME` 指定，否则使用平台标准配置目录。

这是新的 0.x 能力里程碑。SQLite user_version 为 6；首次打开 v5 数据库会先 checkpoint 并创建、验证相邻 `.v5-backup`。回滚必须停止所有 Alphion 进程、恢复 `.v5-backup` 并切回 v0.5.0；迁移后的 v6 Fork 数据会丢失。

## 当前能力

- 项目级共享 Agent 与分层 Session/Run/Turn/ToolCall；每个 Session 独立持有分支消息、双队列、运行租约、审批上下文、compaction 和 append-only AgentShape。
- idle、已塑形 Session 可按当前 leaf 或指定 entry 原子 Fork；目标保留 Evidence、重映射 entry/Memory 引用、重新计算身份 digest，并记录不可变 provenance。
- 四层声明式资源解析、确定性 SystemPrompt Composer、任务分类与最小 HarnessPlan，以及 CodeGraph 优先、词法降级的有界代码召回。
- Node/TypeScript 优先的确定性只读 Project Profile，识别语言、运行时、模块系统、包管理器、框架、质量命令、Git/CI、约束、风险和冲突；未知项目安全降级。
- 每次运行自动注入最多 2,048 estimated tokens 的不可变 ContextPack；安全、目标、权限和强约束不会被可选画像事实挤出预算。
- 运行期 Working Memory 仅由当前任务事件 reducer 重放，跟踪阶段、轮次、工具、Evidence、错误和用量，不写入长期记忆。
- OpenAI-compatible Chat Completions 与 Responses 双协议；DeepSeek、Kimi、Qwen、GLM 提供内置大陆/国际 official endpoint，普通配置无需 Base URL，只有自定义兼容 Provider 接受 URL。
- 简体中文聊天式 Ink TUI、React/Vite loopback WebUI 和 Electron Desktop；三端完整渲染共享安全 Markdown 与受限代码投影（语言、高亮、复制/裁剪、稳定 digest），reasoning 不可见。
- `read`、`grep`、`edit`、`write` 和 `shell` 工具；写入和进程执行必须逐次审批。
- SQLite 权威事件写入与 SHA-256 审计链；三端先订阅再取 snapshot，按 30/60 FPS frame 合并 delta/invalidation，慢消费者通过 cursor resync，不延迟 AgentLoop。
- ProviderConversationPlan 从当前 Run 之前的分支构建合法 user/assistant/tool 消息线；普通审计事件和 `tool.updated` 不进入 Provider 历史，当前 prompt 只追加一次。
- TUI/Web/Desktop 共用 `/new`、`/settings`、`/projects`、`/sessions`、`/providers`、`/resources`、`/doctor`、`/help`、`/profile`、`/harness`、`/fork`、`/steer`、`/follow-up`、`/cancel` 注册表与可用性原因。
- 进程内 LRU + SQLite L2 缓存、single-flight 合并、策略/权限/项目修订失效和可选 provider prompt caching；疑似秘密不进入缓存。
- Project 注册层保证名称/realpath 唯一、每项目独立 SQLite v5；同域 `session.send` 支持 idle 自动 Run 与 busy steering，并限制 8 hop/每 Run 4 次发送。
- WebUI 只绑定 `127.0.0.1`，采用 HttpOnly/Origin/CSRF/SSE；Electron 开启 sandbox/contextIsolation、禁用 Node integration/任意导航，preload 仅暴露五个 allowlisted IPC 通道。

本版不会实现 LAN/远程部署、多用户、跨 Project 协作、动态代码插件、SubAgent 或长期记忆。

## 安装与构建

- Node.js 22.13+
- TypeScript 5.9+
- ESM
- `better-sqlite3` 含原生 ABI；根安装树固定用于 Node，Electron 使用忽略的独立 `.desktop-runtime/`，打包前运行 `npm run desktop:deps`

```bash
npm install
npm run typecheck
npm run build
```

正式构建产物写入被忽略的 `dist/`。Windows 构建后双击 `alphion.bat` 会显示循环启动菜单，可进入工作台、运行只读诊断或查看帮助；带参数调用仍原样透传退出码，适合 CI/脚本。其他平台使用 `npm run cli --` 或 `node dist/cli/index.js`。交互界面使用：

```bash
npm run tui
# 或
alphion.bat tui
npm run desktop
# 或本地 WebUI
alphion.bat web
```

主密码无法恢复；忘记后只能重置 vault 并重新导入 API key。reasoning 仅在 Provider 当前 Run 的工具续轮中短暂存在，不进入任何用户界面、SQLite 或重放。

## 配置兼容服务

以下示例配置一个本机无认证自定义 Chat Completions 服务：

```bat
alphion.bat provider set --id local --preset custom-openai-compatible --base-url http://127.0.0.1:11434/v1 --model your-model --protocol chat-completions --active
alphion.bat run --prompt "读取 README 并概括当前能力"
```

需要 Bearer key 时，数据库只记录环境变量名称：

```bat
set COMPATIBLE_API_KEY=replace-me
alphion.bat provider set --id hosted --preset custom-openai-compatible --base-url https://example.com/v1 --model model-id --protocol responses --auth-env COMPATIBLE_API_KEY --active
```

常用命令：

```text
provider set/list/activate
policy shell allow/list/remove
cache stats/clear
doctor [--json]
project inspect [--refresh] [--json]
session create/list/show/shape/reshape/checkout/send/steer/follow-up/fork
resource list/doctor
desktop
web [--port PORT]
run --prompt ...
tui [--session SESSION_ID]
```

`edit`、`write` 和 `shell` 只在交互式终端逐次展示完整动作并批准；管道、CI 或其他无 TTY 场景默认拒绝。shell 还必须匹配本地白名单中的可执行文件、摘要和参数前缀。这个边界是“白名单 + 审批”的进程控制，不是操作系统级沙箱。

## 项目边界

```text
src/          模型和界面无关的领域、应用、端口与协议核心
adapters/     只读画像、OpenAI-compatible、DeepSeek、SQLite/vault、缓存、秘密和工具实现
cli/          命令行、Session/资源/shape 与一次性 run 适配器
tui/          Ink 终端界面、运行投影和逐次审批适配器
ui/           三端共享命令、事件队列与安全 Markdown AST
webui/        loopback HTTP/SSE 与 React/Vite renderer
desktop/      Electron Main、sandbox preload 与 IPC 合同
tests/        单元、合同、集成、安全与 CLI 验证
benchmarks/   通信、缓存和 SQLite 基线
```

依赖方向固定为 `CLI/UI -> application -> domain` 和 `adapters -> ports <- application`。`src/` 不能导入 adapter、CLI、TUI 或 WebUI；具体 SDK 类型不能进入核心公共接口。

## 公共接口

根入口保留稳定只读的 `ALPHION_BRAND`，并公开共享 Agent、Project/Session、AgentShape、HarnessPlan、ResourceResolution、SystemPromptPlan 与 Provider/runtime 端口。稳定子路径包括 `alphion/runtime`、`alphion/providers`、`alphion/resources`、`alphion/webui`、`alphion/desktop` 及既有具体 adapter。Provider profile schema v2 继续支持环境变量或加密 SQLite 凭据引用；AgentSessionRecord schema v3 可携带 Fork provenance，SQLite user_version 现为 6。

当当前分支超过模型上下文预算时，会话会从原始分支重建压缩：保留最近两个交互周期及系统/目标/验收、权限/约束/revision、失败、Evidence 和未解决项，并可调用同一 Provider 生成禁用工具、`temperature: 0`、闭合 JSON schema 校验的结构化摘要；超时、非法输出或 Provider 失败会确定性回退。模型 reasoning 只存在于实时 `AgentStreamEvent`，不进入 SQLite 事件、会话条目、重放、Working Memory 或持久缓存。

## 安全和数据

- HTTPS endpoint 默认允许；HTTP 只允许 localhost/loopback。
- vault 使用 scrypt + AES-256-GCM、每条密钥随机 nonce 和绑定 profile/revision 的认证数据；15 分钟无活动后自动锁定。
- `.git`、`.alphion`、工具生成物、依赖、构建目录和常见秘密文件不能被 Agent 文件工具读取或修改。
- 路径同时检查词法范围、真实路径与符号链接，写入使用 revision 校验和原子替换。
- 模型输出不是完成证据；工具观察生成 Evidence ID，最终答案可用 `[evidence:<id>]` 引用。
- `.alphion/`、`docs/`、Trellis 和 CodeGraph 均保持本地且不进入 Git 或 npm 包；`dist/` 不进入 Git，但会由正式构建生成并纳入 npm 打包内容。

## 品牌资产

| 用途 | 文件 |
| --- | --- |
| 主系统 Logo | `alphion-logo.svg` |
| 图标 | `alphion-icon.svg` |
| 文字标识 | `alphion-wordmark.svg` |

## 许可

[Apache License 2.0](./LICENSE)
