import assert from "node:assert/strict";
import test from "node:test";
import { parseExternalHttpUrl, parseMarkdown, renderMarkdownText, sanitizeUiText } from "../ui/markdown.js";

const FIXTURE = `# 结论

| 项目 | 状态 |
| --- | --- |
| Session | **完成** |
| WebUI | 进行中 |

- [x] 安全链接
- [ ] 后续事项

行内公式 $E=mc^2$ 与 [OpenAI](https://openai.com/docs)。

$$
\\sum_{i=1}^n i
$$

\`\`\`ts
const safe = true;
\`\`\`

<script>alert('never html')</script>`;

test("shared Markdown parses GFM, code, links and TeX into a safe document", () => {
  const document = parseMarkdown(FIXTURE);
  assert.equal(document.schemaVersion, 1);
  assert.ok(document.blocks.some((block) => block.kind === "table"));
  assert.ok(document.blocks.some((block) => block.kind === "list"));
  assert.ok(document.blocks.some((block) => block.kind === "math"));
  assert.ok(document.blocks.some((block) => block.kind === "code"));
  assert.match(renderMarkdownText(document), /E=mc²/u);
  assert.match(renderMarkdownText(document), /OpenAI <openai\.com>/u);
  assert.match(renderMarkdownText(document), /<script>alert/u);
});

test("shared Markdown strips terminal controls and rejects unsafe external protocols", () => {
  assert.equal(sanitizeUiText("safe\u001b[31m\u0000"), "safe[31m");
  assert.equal(parseExternalHttpUrl("javascript:alert(1)"), undefined);
  assert.equal(parseExternalHttpUrl("file:///etc/passwd"), undefined);
  assert.equal(parseExternalHttpUrl("data:text/html,x"), undefined);
  assert.deepEqual(parseExternalHttpUrl("https://Example.com/path"), { href: "https://example.com/path", domain: "example.com" });
  const text = renderMarkdownText(parseMarkdown("[bad](javascript:alert(1))"));
  assert.match(text, /javascript:/u);
});
