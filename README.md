<p align="center">
  <img src="./alphion-logo.svg" alt="Alphion" width="280" />
</p>

# Alphion

Alphion 是一个面向不同软件项目、在证据和安全边界内持续优化 harness 的轻量 Agent 项目。

当前 **v0.3.2** 将运行边界升级为项目级共享 Agent 和持久化分支会话：`LocalAlphionApplication → Agent → Session → Run`。CLI/TUI 通过同一传输无关的 Session API 创建、查看、发送、转向和排队后续消息；确定性的 HarnessPlan 与受限 ResourceLoader 负责能力、权限、预算及上下文组合。长期语义记忆、自我进化、SubAgent、Web/Desktop 传输仍是后续里程碑。

这是用户批准的 0.x 版本例外：公开 TypeScript API 和 SQLite schema 都有破坏性变更。首次打开 schema v2 数据库时，会先 checkpoint，再通过 SQLite `VACUUM INTO` 创建相邻且自包含的 `.v2-backup` snapshot，并校验 quick check、schema 与逻辑摘要。回滚时必须停止所有 Alphion 进程、恢复该 snapshot 并切回 `v0.3.1`；迁移后新增的会话数据将丢失。

## 当前能力

- 单任务 Agent 循环，支持流式输出、函数工具调用、取消、超时，以及轮次、工具、token 和输出字节预算。
- Node/TypeScript 优先的确定性只读 Project Profile，识别语言、运行时、模块系统、包管理器、框架、质量命令、Git/CI、约束、风险和冲突；未知项目安全降级。
- 每次运行自动注入最多 2,048 estimated tokens 的不可变 ContextPack；安全、目标、权限和强约束不会被可选画像事实挤出预算。
- 运行期 Working Memory 仅由当前任务事件 reducer 重放，跟踪阶段、轮次、工具、Evidence、错误和用量，不写入长期记忆。
- OpenAI-compatible Chat Completions 与 Responses 双协议；模型、Base URL 和能力均由本地 profile 配置。
- 独立 DeepSeek Chat Completions provider，支持 `deepseek-chat`、`deepseek-reasoner`、推理流、工具续轮和 prompt-cache 命中用量。
- 简体中文 Ink + React 工程工作台，宽终端使用侧栏、窄终端使用顶部导航，并提供首页、画像、Provider/Vault、任务与只读诊断五个区域。
- `read`、`grep`、`edit`、`write` 和 `shell` 工具；写入和进程执行必须逐次审批。
- 单写者类型化事件、背压、关键事件持久化及 SHA-256 审计链。
- 进程内 LRU + SQLite L2 缓存、single-flight 合并、策略/权限/项目修订失效和可选 provider prompt caching；疑似秘密不进入缓存。
- 项目内 `.alphion/alphion.sqlite3` 保存配置、审计、缓存、shell 白名单和 AES-256-GCM 密文凭据；用户主密码通过 scrypt 解锁，明文不写入数据库、事件或缓存。

本版不会实现 WebUI、SubAgent、自我进化执行或原生 Anthropic/Gemini/Azure provider。这些能力将在对应证据门和回放基线稳定后逐步加入。

## 安装与构建

- Node.js 22.13+
- TypeScript 5.9+
- ESM
- 运行时依赖仅包含官方 `openai` JavaScript 客户端以及位于 TUI 层的 Ink/React

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
```

首次启动会创建主密码。主密码无法恢复；忘记后只能重置 vault 并重新导入 API key。reasoning 默认折叠、明确标记为模型推理，且不会被当作 Evidence 或最终答案。

## 配置兼容服务

以下示例配置一个本机无认证 Chat Completions 服务：

```bat
alphion.bat provider set --id local --base-url http://127.0.0.1:11434/v1 --model your-model --protocol chat-completions --active
alphion.bat run --prompt "读取 README 并概括当前能力"
```

需要 Bearer key 时，数据库只记录环境变量名称：

```bat
set COMPATIBLE_API_KEY=replace-me
alphion.bat provider set --id hosted --base-url https://example.com/v1 --model model-id --protocol responses --auth-env COMPATIBLE_API_KEY --active
```

常用命令：

```text
provider set/list/activate
policy shell allow/list/remove
cache stats/clear
doctor [--json]
project inspect [--refresh] [--json]
run --prompt ...
tui
```

`edit`、`write` 和 `shell` 只在交互式终端逐次展示完整动作并批准；管道、CI 或其他无 TTY 场景默认拒绝。shell 还必须匹配本地白名单中的可执行文件、摘要和参数前缀。这个边界是“白名单 + 审批”的进程控制，不是操作系统级沙箱。

## 项目边界

```text
src/          模型和界面无关的领域、应用、端口与协议核心
adapters/     只读画像、OpenAI-compatible、DeepSeek、SQLite/vault、缓存、秘密和工具实现
cli/          当前单任务命令行适配器
tui/          Ink 终端界面、运行投影和逐次审批适配器
webui/        未来 Web 界面边界；当前仅 README
tests/        单元、合同、集成、安全与 CLI 验证
benchmarks/   通信、缓存和 SQLite 基线
```

依赖方向固定为 `CLI/UI -> application -> domain` 和 `adapters -> ports <- application`。`src/` 不能导入 adapter、CLI、TUI 或 WebUI；具体 SDK 类型不能进入核心公共接口。

## 公共接口

根入口保留稳定只读的 `ALPHION_BRAND`，并公开共享 `Agent`、`AgentApplication.sessions: SessionManager`、`AgentSession`、版本化消息、HarnessPlan、ResourceLoader、Project Profile、ContextPack、诊断、事件、provider、工具、审批、缓存、会话/事件存储和密钥引用合同。旧的 `AgentRuntime.start` / `AgentApplication.startRun` 已移除；具体实现通过 `alphion/openai-compatible`、`alphion/deepseek`、`alphion/local`、`alphion/sqlite` 和 `alphion/tools` 子路径暴露。Provider profile schema v2 继续支持环境变量或加密 SQLite 凭据引用；SQLite user_version 现为 3。

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
