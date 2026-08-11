<p align="center">
  <img src="./alphion-logo.svg" alt="Alphion" width="280" />
</p>

# Alphion

Alphion 是一个面向不同软件项目、在证据和安全边界内持续优化 harness 的轻量 Agent 项目。

当前 **v0.2.1** 提供首个可运行的 Agent 基础层：通过可配置的 OpenAI-compatible 接口连接模型，统一支持 Chat Completions 与 Responses 协议，并内置有界事件通信、SQLite 状态、两级缓存、证据引用和安全项目工具。它不绑定 OpenAI 官方模型，也不会自动调用真实服务。

## 当前能力

- 单任务 Agent 循环，支持流式输出、函数工具调用、取消、超时，以及轮次、工具、token 和输出字节预算。
- OpenAI-compatible Chat Completions 与 Responses 双协议；模型、Base URL 和能力均由本地 profile 配置。
- `read`、`grep`、`edit`、`write` 和 `shell` 工具；写入和进程执行必须逐次审批。
- 单写者类型化事件、背压、关键事件持久化及 SHA-256 审计链。
- 进程内 LRU + SQLite L2 缓存、single-flight 合并、策略/权限/项目修订失效和可选 provider prompt caching；疑似秘密不进入缓存。
- 项目内 `.alphion/alphion.sqlite3` 保存非秘密配置、审计、缓存和 shell 白名单；API key 只保存环境变量引用。

本版不会实现 TUI、WebUI、SubAgent、自我进化执行或原生 Anthropic/Gemini/Azure provider。这些能力将在核心合同和评测门稳定后逐步加入。

## 安装与构建

- Node.js 22.13+
- TypeScript 5.9+
- ESM
- 唯一运行时依赖：官方 `openai` JavaScript 客户端

```bash
npm install
npm run typecheck
npm run build
```

正式构建产物写入被忽略的 `dist/`。Windows 可在构建后通过 `alphion.bat` 启动；其他平台使用 `npm run cli --` 或 `node dist/cli/index.js`。

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
```

`edit`、`write` 和 `shell` 只在交互式终端逐次展示完整动作并批准；管道、CI 或其他无 TTY 场景默认拒绝。shell 还必须匹配本地白名单中的可执行文件、摘要和参数前缀。这个边界是“白名单 + 审批”的进程控制，不是操作系统级沙箱。

## 项目边界

```text
src/          模型和界面无关的领域、应用、端口与协议核心
adapters/     OpenAI-compatible、SQLite、缓存、秘密和工具实现
cli/          当前单任务命令行适配器
tui/          未来终端界面边界；当前仅 README
webui/        未来 Web 界面边界；当前仅 README
tests/        单元、合同、集成、安全与 CLI 验证
benchmarks/   通信、缓存和 SQLite 基线
```

依赖方向固定为 `CLI/UI -> application -> domain` 和 `adapters -> ports <- application`。`src/` 不能导入 adapter、CLI、TUI 或 WebUI；具体 SDK 类型不能进入核心公共接口。

## 公共接口

根入口保留稳定只读的 `ALPHION_BRAND`，并公开 `AgentRuntime`、运行/事件、provider、工具、审批、缓存、事件存储和密钥引用合同。具体实现通过 `alphion/openai-compatible`、`alphion/sqlite` 和 `alphion/tools` 子路径暴露。

## 安全和数据

- HTTPS endpoint 默认允许；HTTP 只允许 localhost/loopback。
- `.git`、`.alphion`、工具生成物、依赖、构建目录和常见秘密文件不能被 Agent 文件工具读取或修改。
- 路径同时检查词法范围、真实路径与符号链接，写入使用 revision 校验和原子替换。
- 模型输出不是完成证据；工具观察生成 Evidence ID，最终答案可用 `[evidence:<id>]` 引用。
- `.alphion/`、`docs/`、Trellis、CodeGraph 和 `dist/` 均保持本地且不进入发布内容。

## 品牌资产

| 用途 | 文件 |
| --- | --- |
| 主系统 Logo | `alphion-logo.svg` |
| 图标 | `alphion-icon.svg` |
| 文字标识 | `alphion-wordmark.svg` |

## 许可

[Apache License 2.0](./LICENSE)
