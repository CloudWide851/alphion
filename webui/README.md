# Alphion WebUI 边界

`webui/` 是 v0.5.0 的本地 React/Vite 界面和 loopback Node HTTP/SSE adapter。它只绑定 `127.0.0.1`、面向一个本地用户和一个活动 Project；Renderer 也被 Electron 复用。

## 传输与并发

- `POST /api/bootstrap` 建立短期 HttpOnly、SameSite=Strict 会话并返回 CSRF challenge。
- `POST /api/command` 只接受共享严格 decoder 的版本化命令；写操作携带 revision/idempotency。
- `GET /api/events` 以 cursor SSE 续传。落后客户端收到 `stream.resync-required` 后加载 Session snapshot，不采用最后写入者获胜。
- Provider credential 与 approval 使用独立 CSRF-bound endpoint；秘密不进入 local/session storage、事件或普通命令。

## 界面与内容

界面使用 macOS 简白玻璃风，`#A377F6` 是唯一主强调色，正文 14–16px、标题不超过 24px，不使用副标题。说明统一进入可键盘操作的圆圈 `!` disclosure，玻璃只用于导航、浮层和层级边界，并尊重 reduced motion/transparency。

模型内容通过共享安全 Markdown AST 渲染；支持 GFM 表格/任务/代码和 KaTeX，禁止 raw HTML 与 `dangerouslySetInnerHTML`。外链显示域名、仅允许 HTTP/HTTPS并要求确认。

## 边界

WebUI 不直接读 SQLite、模型、文件工具或 Vault。`src/` 不依赖 Web/React/Vite。服务端负责输入验证、Origin/CSRF、秘密脱敏和安全错误；浏览器只持有短期 UI 状态。
