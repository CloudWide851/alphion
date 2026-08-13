import assert from "node:assert/strict";
import test from "node:test";
import { parseExternalHttpUrl, parseMarkdown, renderMarkdownText, sanitizeUiText } from "../ui/markdown.js";
import { projectCode, renderTerminalCode } from "../ui/code-projection.js";

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
  const code = document.blocks.find((block) => block.kind === "code");
  assert.equal(code?.kind === "code" ? code.projection.language : undefined, "ts");
  assert.match(code?.kind === "code" ? code.projection.digest : "", /^[a-f0-9]{64}$/u);
  assert.equal(code?.kind === "code" ? code.projection.originalLines : 0, 1);
  assert.match(renderMarkdownText(document), /E=mc²/u);
  assert.match(renderMarkdownText(document), /OpenAI <openai\.com>/u);
  assert.match(renderMarkdownText(document), /<script>alert/u);
});

test("code projection highlights known languages, falls back safely and bounds long blocks", () => {
  const known = projectCode("const value = 42; // safe", "typescript");
  assert.equal(projectCode("abc").digest, "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.ok(known.tokens.some((token) => token.kind === "keyword" && token.value === "const"));
  assert.ok(known.tokens.some((token) => token.kind === "number"));
  const unknown = projectCode("<unsafe>& text", "mystery");
  assert.deepEqual(unknown.tokens, [{ kind: "plain", value: "<unsafe>& text" }]);
  const streaming = projectCode("const partial =", "ts", false);
  assert.deepEqual(streaming.tokens, [{ kind: "plain", value: "const partial =" }]);
  const long = projectCode("x\n".repeat(3_000), "js");
  assert.equal(long.truncated, true);
  assert.ok(long.originalLines > 2_000);
  const plain = renderTerminalCode(known, 80, false);
  assert.doesNotMatch(plain, /\u001b/u);
  assert.match(plain, /typescript.*1 lines/u);
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
