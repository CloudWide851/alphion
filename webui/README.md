# Alphion WebUI 边界

v0.9.0 的 WebUI 与 Electron Renderer 共享固定底部输入框、可滚动消息区、多 token slash 面板、`ConversationRunState`、Project/Session Workspace、Provider 实测、Compaction/Goal/Schedule 投影和由 `alphion-icon.svg` 生成的品牌资产。用户气泡右对齐，assistant 气泡左对齐；首 token 前显示等待状态，流式内容按约 60 FPS frame 更新，reduced-motion 使用静态反馈且 snapshot/resync 不清按 Project/Session 保存的普通草稿。

`webui/` 是 v0.5.0 的本地 React/Vite 界面和 loopback Node HTTP/SSE adapter。它只绑定 `127.0.0.1`、面向一个本地用户和一个活动 Project；Renderer 也被 Electron 复用。

## 传输与并发

- `POST /api/bootstrap` 建立短期 HttpOnly、SameSite=Strict 会话并返回 CSRF challenge。
- `POST /api/command` 只接受共享严格 decoder 的版本化命令；写操作携带 revision/idempotency。
- `GET /api/events` 以 cursor SSE 续传。落后客户端收到 `stream.resync-required` 后加载 Session snapshot，不采用最后写入者获胜。
- Provider credential 与 approval 使用独立 CSRF-bound endpoint；秘密不进入 local/session storage、事件或普通命令。
- API Key 由 Project 独立密钥认证加密；浏览器从不接触 Project key、凭据密文或迁移材料。

## 界面与内容

界面使用 macOS 简白玻璃风，`#A377F6` 是唯一主强调色，正文 14–16px、标题不超过 24px，不使用副标题。说明统一进入可键盘操作的圆圈 `!` disclosure，玻璃只用于导航、浮层和层级边界，并尊重 reduced motion/transparency。

模型内容通过共享安全 Markdown AST 渲染；支持 GFM 表格/任务/代码和 KaTeX，禁止 raw HTML 与 `dangerouslySetInnerHTML`。外链显示域名、仅允许 HTTP/HTTPS并要求确认。

`/context`、`/goals`、`/goal` 和 `/schedules` 打开共享自动化面板。快照仅携带最新压缩摘要和累计次数，正文按需读取且默认隐藏；Goal 与 Schedule mutation 继续使用 revision/idempotency，并通过 frame 自动刷新。favicon 和左上角品牌使用 canonical Alphion 图标。

## 边界

WebUI 不直接读 SQLite、模型、文件工具、Project key 或凭据密文。`src/` 不依赖 Web/React/Vite。服务端负责输入验证、Origin/CSRF、秘密脱敏和安全错误；浏览器只持有短期 UI 状态。
