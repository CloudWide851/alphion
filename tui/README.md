# Alphion TUI 边界

`tui/` 是 v0.5.0 的简体中文 Ink/React 终端适配器。首页直接进入聊天：紫色字符 ALPHION Logo、Session 消息流、状态和输入框；Project、Session、Provider、Resource、Harness、Profile、doctor 和帮助通过 `/settings` 及别名打开不写入历史的内嵌卡片。

## 交互合同

- Enter 发送，Alt+Enter/Ctrl+J 换行；成功受理后清空聊天输入。
- ↑/↓ 直观移动所有列表选择并由 Enter 确认；数字键、Tab、Esc、`?`、`q` 与 Ctrl+C 保留。
- 密码/API key 在提交成功、失败、取消和卸载时立即清空；普通表单校验失败保留可编辑值。
- `NO_COLOR` 可用，状态同时使用符号/文本。approval、错误与取消在窄/低终端仍有优先级。
- reasoning 不显示、不进入 Session/Markdown/持久投影。

## Markdown 与安全

TUI 使用共享 `ui/markdown.ts` AST，支持段落、标题、表格、任务列表、代码、引用、链接和 TeX。常见公式转成 Unicode/多行文本，复杂公式回退为原始 TeX。raw HTML 不执行，C0/C1 控制字符被移除。外链只允许 HTTP/HTTPS、显示真实域名并要求确认。

## 依赖方向

```text
terminal input -> TUI -> AgentApplication/SessionManager
terminal view  <- TUI <- typed events + shared Markdown
```

TUI 不直接打开 SQLite、调用 Provider/tool、解析秘密或定义领域策略。`src/` 不能导入 TUI/Ink/React。界面最多约 30 FPS 合并可折叠 delta；审批、错误、最终状态和审计事实不能丢失。
