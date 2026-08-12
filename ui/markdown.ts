export type MarkdownInline =
  | Readonly<{ readonly kind: "text"; readonly value: string }>
  | Readonly<{ readonly kind: "strong" | "emphasis"; readonly children: readonly MarkdownInline[] }>
  | Readonly<{ readonly kind: "code" | "math"; readonly value: string }>
  | Readonly<{ readonly kind: "link"; readonly href: string; readonly domain: string; readonly children: readonly MarkdownInline[] }>
  | Readonly<{ readonly kind: "break" }>;

export type MarkdownBlock =
  | Readonly<{ readonly kind: "paragraph"; readonly children: readonly MarkdownInline[] }>
  | Readonly<{ readonly kind: "heading"; readonly level: 1 | 2 | 3 | 4 | 5 | 6; readonly children: readonly MarkdownInline[] }>
  | Readonly<{ readonly kind: "code"; readonly language?: string; readonly value: string }>
  | Readonly<{ readonly kind: "math"; readonly value: string }>
  | Readonly<{ readonly kind: "quote"; readonly children: readonly MarkdownBlock[] }>
  | Readonly<{ readonly kind: "list"; readonly ordered: boolean; readonly items: readonly Readonly<{ readonly checked?: boolean; readonly children: readonly MarkdownInline[] }>[] }>
  | Readonly<{ readonly kind: "table"; readonly header: readonly (readonly MarkdownInline[])[]; readonly rows: readonly (readonly (readonly MarkdownInline[])[])[] }>
  | Readonly<{ readonly kind: "rule" }>;

export interface MarkdownDocument {
  readonly schemaVersion: 1;
  readonly blocks: readonly MarkdownBlock[];
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;
const LINK = /\[([^\]]+)\]\(([^\s)]+)(?:\s+["'][^"']*["'])?\)/u;
const INLINE_TOKEN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|`[^`\n]+`|\$[^$\n]+\$|\*[^*\n]+\*|_[^_\n]+_|\[[^\]]+\]\([^\s)]+(?:\s+["'][^"']*["'])?\))/u;

export function sanitizeUiText(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "");
}

export function parseMarkdown(source: string): MarkdownDocument {
  const lines = sanitizeUiText(source).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) { index += 1; continue; }
    const fence = /^(?<marker>`{3,}|~{3,})(?<language>[\w+-]*)\s*$/u.exec(line);
    if (fence?.groups) {
      const content: string[] = [];
      const marker = fence.groups.marker ?? "```";
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").startsWith(marker)) content.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      const language = fence.groups.language?.trim();
      blocks.push(Object.freeze({ kind: "code", ...(language ? { language } : {}), value: content.join("\n") }));
      continue;
    }
    if (line.trim() === "$$") {
      const content: string[] = [];
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim() !== "$$") content.push(lines[index++] ?? "");
      if (index < lines.length) index += 1;
      blocks.push(Object.freeze({ kind: "math", value: content.join("\n").trim() }));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      blocks.push(Object.freeze({ kind: "heading", level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6, children: parseInline(heading[2] ?? "") }));
      index += 1;
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) { blocks.push(Object.freeze({ kind: "rule" })); index += 1; continue; }
    if (line.startsWith("> ") || line === ">") {
      const quote: string[] = [];
      while (index < lines.length && ((lines[index] ?? "").startsWith("> ") || lines[index] === ">")) quote.push((lines[index++] ?? "").replace(/^> ?/u, ""));
      blocks.push(Object.freeze({ kind: "quote", children: parseMarkdown(quote.join("\n")).blocks }));
      continue;
    }
    if (isTableStart(lines, index)) {
      const header = splitTableRow(line).map(parseInline);
      index += 2;
      const rows: (readonly (readonly MarkdownInline[])[])[] = [];
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) rows.push(Object.freeze(splitTableRow(lines[index++] ?? "").map(parseInline)));
      blocks.push(Object.freeze({ kind: "table", header: Object.freeze(header), rows: Object.freeze(rows) }));
      continue;
    }
    const list = /^\s*(?:(\d+)[.)]|[-+*])\s+(?:\[([ xX])\]\s+)?(.+)$/u.exec(line);
    if (list) {
      const ordered = list[1] !== undefined;
      const items: { readonly checked?: boolean; readonly children: readonly MarkdownInline[] }[] = [];
      while (index < lines.length) {
        const match = /^\s*(?:(\d+)[.)]|[-+*])\s+(?:\[([ xX])\]\s+)?(.+)$/u.exec(lines[index] ?? "");
        if (!match || (match[1] !== undefined) !== ordered) break;
        const checked = match[2] === undefined ? undefined : match[2].toLowerCase() === "x";
        items.push(Object.freeze({ ...(checked === undefined ? {} : { checked }), children: parseInline(match[3] ?? "") }));
        index += 1;
      }
      blocks.push(Object.freeze({ kind: "list", ordered, items: Object.freeze(items) }));
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (index < lines.length && (lines[index] ?? "").trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++] ?? "");
    blocks.push(Object.freeze({ kind: "paragraph", children: parseInline(paragraph.join("\n")) }));
  }
  return Object.freeze({ schemaVersion: 1, blocks: Object.freeze(blocks) });
}

export function parseExternalHttpUrl(value: string): Readonly<{ href: string; domain: string }> | undefined {
  let url: URL;
  try { url = new URL(value); } catch { return undefined; }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return undefined;
  return Object.freeze({ href: url.href, domain: url.hostname.toLowerCase() });
}

export function renderMarkdownText(document: MarkdownDocument, columns = 80): string {
  return document.blocks.map((block) => renderBlock(block, Math.max(20, columns))).join("\n\n");
}

function parseInline(value: string): readonly MarkdownInline[] {
  const output: MarkdownInline[] = [];
  let rest = value;
  while (rest) {
    const match = INLINE_TOKEN.exec(rest);
    if (!match || match.index === undefined) { output.push(Object.freeze({ kind: "text", value: rest })); break; }
    if (match.index > 0) output.push(Object.freeze({ kind: "text", value: rest.slice(0, match.index) }));
    const token = match[0];
    if (token.startsWith("**") || token.startsWith("__")) output.push(Object.freeze({ kind: "strong", children: parseInline(token.slice(2, -2)) }));
    else if (token.startsWith("`") && token.endsWith("`")) output.push(Object.freeze({ kind: "code", value: token.slice(1, -1) }));
    else if (token.startsWith("$") && token.endsWith("$")) output.push(Object.freeze({ kind: "math", value: token.slice(1, -1) }));
    else if (token.startsWith("[")) {
      const link = LINK.exec(token);
      const safe = link ? parseExternalHttpUrl(link[2] ?? "") : undefined;
      output.push(safe ? Object.freeze({ kind: "link", ...safe, children: parseInline(link?.[1] ?? "") }) : Object.freeze({ kind: "text", value: token }));
    } else output.push(Object.freeze({ kind: "emphasis", children: parseInline(token.slice(1, -1)) }));
    rest = rest.slice(match.index + token.length);
  }
  return Object.freeze(output);
}

function isTableStart(lines: readonly string[], index: number): boolean {
  const current = lines[index] ?? "";
  const divider = lines[index + 1] ?? "";
  return current.includes("|") && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(divider);
}

function splitTableRow(value: string): string[] {
  return value.trim().replace(/^\||\|$/gu, "").split(/(?<!\\)\|/u).map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function isBlockStart(lines: readonly string[], index: number): boolean {
  const value = lines[index] ?? "";
  return /^(?:#{1,6}\s|```|~~~|>\s?|\s*(?:(?:\d+)[.)]|[-+*])\s+)/u.test(value) || value.trim() === "$$" || isTableStart(lines, index);
}

function renderInline(children: readonly MarkdownInline[]): string {
  return children.map((item) => {
    if (item.kind === "text") return item.value;
    if (item.kind === "break") return "\n";
    if (item.kind === "code") return `‹${item.value}›`;
    if (item.kind === "math") return renderTexForTerminal(item.value);
    if (item.kind === "link") return `${renderInline(item.children)} <${item.domain}>`;
    if (item.kind === "strong" || item.kind === "emphasis") return renderInline(item.children);
    return "";
  }).join("");
}

function renderBlock(block: MarkdownBlock, columns: number): string {
  switch (block.kind) {
    case "paragraph": return renderInline(block.children);
    case "heading": return `${"#".repeat(block.level)} ${renderInline(block.children)}`;
    case "code": return `${block.language ? `[${block.language}]\n` : ""}${block.value}`;
    case "math": return renderTexForTerminal(block.value);
    case "quote": return renderMarkdownText({ schemaVersion: 1, blocks: block.children }, columns - 2).split("\n").map((line) => `│ ${line}`).join("\n");
    case "list": return block.items.map((item, index) => `${block.ordered ? `${index + 1}.` : item.checked === undefined ? "•" : item.checked ? "☑" : "☐"} ${renderInline(item.children)}`).join("\n");
    case "table": return renderTable(block.header, block.rows, columns);
    case "rule": return "─".repeat(Math.min(columns, 72));
  }
}

function renderTable(header: readonly (readonly MarkdownInline[])[], rows: readonly (readonly (readonly MarkdownInline[])[])[], columns: number): string {
  const cells = [header, ...rows].map((row) => row.map(renderInline));
  const count = Math.max(1, ...cells.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, column) => Math.min(Math.max(3, ...cells.map((row) => (row[column] ?? "").length)), Math.max(3, Math.floor((columns - count * 3) / count))));
  const format = (row: readonly string[]) => `│ ${widths.map((width, column) => (row[column] ?? "").slice(0, width).padEnd(width)).join(" │ ")} │`;
  return [format(cells[0] ?? []), `├─${widths.map((width) => "─".repeat(width)).join("─┼─")}─┤`, ...cells.slice(1).map(format)].join("\n");
}

function renderTexForTerminal(value: string): string {
  const normalized = value
    .replace(/\\(?:times|cdot)\b/gu, "×").replace(/\\pm\b/gu, "±").replace(/\\leq?\b/gu, "≤").replace(/\\geq?\b/gu, "≥")
    .replace(/\\neq\b/gu, "≠").replace(/\\infty\b/gu, "∞").replace(/\\to\b/gu, "→").replace(/\\sum\b/gu, "∑").replace(/\\prod\b/gu, "∏")
    .replace(/\\alpha\b/gu, "α").replace(/\\beta\b/gu, "β").replace(/\\gamma\b/gu, "γ").replace(/\\theta\b/gu, "θ").replace(/\\lambda\b/gu, "λ").replace(/\\pi\b/gu, "π")
    .replace(/\^\{?2\}?/gu, "²").replace(/\^\{?3\}?/gu, "³");
  return /\\(?:begin|frac|sqrt|left|right|matrix|cases)\b|[{}]/u.test(normalized) ? `$${value}$` : normalized;
}
