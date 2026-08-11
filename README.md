<p align="center">
  <img src="./alphion-logo.svg" alt="Alphion" width="280" />
</p>

# Alphion

Alphion 是一个面向不同软件项目、在证据和安全边界内持续优化 harness 的轻量 Agent 项目。

当前 **v0.3.0** 在受控 Agent 基础层上加入可运行的 Ink TUI、加密 SQLite 凭据库和独立 DeepSeek provider。OpenAI-compatible Chat Completions/Responses 仍受支持；详细 Phase 1–6 Agent 架构已经定稿，但画像、长期记忆、自我进化、Framework Scout 和 SubAgent 仍是后续运行时里程碑。

## 当前能力

- 单任务 Agent 循环，支持流式输出、函数工具调用、取消、超时，以及轮次、工具、token 和输出字节预算。
- OpenAI-compatible Chat Completions 与 Responses 双协议；模型、Base URL 和能力均由本地 profile 配置。
- 独立 DeepSeek Chat Completions provider，支持 `deepseek-chat`、`deepseek-reasoner`、推理流、工具续轮和 prompt-cache 命中用量。
- Ink + React TUI，可管理 provider、导入或轮换加密 API key、执行单次任务、审批工具、取消运行并折叠查看 reasoning。
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

正式构建产物写入被忽略的 `dist/`。Windows 可在构建后通过 `alphion.bat` 启动；其他平台使用 `npm run cli --` 或 `node dist/cli/index.js`。交互界面使用：

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
run --prompt ...
tui
```

`edit`、`write` 和 `shell` 只在交互式终端逐次展示完整动作并批准；管道、CI 或其他无 TTY 场景默认拒绝。shell 还必须匹配本地白名单中的可执行文件、摘要和参数前缀。这个边界是“白名单 + 审批”的进程控制，不是操作系统级沙箱。

## 项目边界

```text
src/          模型和界面无关的领域、应用、端口与协议核心
adapters/     OpenAI-compatible、DeepSeek、SQLite/vault、缓存、秘密和工具实现
cli/          当前单任务命令行适配器
tui/          Ink 终端界面、运行投影和逐次审批适配器
webui/        未来 Web 界面边界；当前仅 README
tests/        单元、合同、集成、安全与 CLI 验证
benchmarks/   通信、缓存和 SQLite 基线
```

依赖方向固定为 `CLI/UI -> application -> domain` 和 `adapters -> ports <- application`。`src/` 不能导入 adapter、CLI、TUI 或 WebUI；具体 SDK 类型不能进入核心公共接口。

## 公共接口

根入口保留稳定只读的 `ALPHION_BRAND`，并公开 `AgentRuntime`、运行/事件、provider、工具、审批、缓存、事件存储和密钥引用合同。具体实现通过 `alphion/openai-compatible`、`alphion/deepseek`、`alphion/local`、`alphion/sqlite` 和 `alphion/tools` 子路径暴露。Provider profile schema v2 以 `kind` 区分实现，并支持环境变量或加密 SQLite 凭据引用。

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
