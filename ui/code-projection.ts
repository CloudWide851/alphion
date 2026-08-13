export type CodeTokenKind = "plain" | "keyword" | "string" | "number" | "comment" | "operator";
export interface CodeToken { readonly kind: CodeTokenKind; readonly value: string; }
export interface CodeProjection {
  readonly schemaVersion: 1;
  readonly language?: string;
  readonly code: string;
  readonly preview: string;
  readonly originalCharacters: number;
  readonly originalLines: number;
  readonly digest: string;
  readonly truncated: boolean;
  readonly closed: boolean;
  readonly tokens: readonly CodeToken[];
}

const MAX_CODE_CHARACTERS = 64 * 1024;
const MAX_CODE_LINES = 2_000;
const KNOWN_LANGUAGES = new Set(["js", "javascript", "jsx", "ts", "typescript", "tsx", "json", "css", "html", "xml", "sh", "bash", "shell", "powershell", "ps1", "py", "python", "sql", "yaml", "yml", "md", "markdown"]);
const KEYWORDS = new Set("as async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof interface let new null of return switch throw true try type typeof undefined var void while with yield SELECT FROM WHERE INSERT UPDATE DELETE CREATE TABLE JOIN ON AS AND OR NOT NULL VALUES INTO".split(" "));

export function projectCode(value: string, language?: string, closed = true): CodeProjection {
  const normalized = sanitizeCode(value).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const withinLines = lines.slice(0, MAX_CODE_LINES).join("\n");
  const code = withinLines.slice(0, MAX_CODE_CHARACTERS);
  const normalizedLanguage = normalizeLanguage(language);
  const truncated = code.length < normalized.length || lines.length > MAX_CODE_LINES;
  const preview = code.slice(0, 4_096);
  return Object.freeze({ schemaVersion: 1, ...(normalizedLanguage ? { language: normalizedLanguage } : {}), code, preview, originalCharacters: normalized.length, originalLines: lines.length, digest: sha256Text(normalized), truncated, closed, tokens: Object.freeze(closed ? tokenize(code, normalizedLanguage) : [{ kind: "plain", value: preview }]) });
}

export function renderTerminalCode(projection: CodeProjection, columns: number, color = process.env.NO_COLOR === undefined): string {
  const safeColumns = Math.max(20, columns);
  const rendered = projection.tokens.map((token) => colorize(token, color)).join("").split("\n").map((line) => cropAnsiFree(line, safeColumns)).join("\n");
  const label = `[${projection.language ?? "text"}] · ${projection.originalLines} lines · ${projection.digest.slice(0, 12)}${projection.closed ? "" : " · streaming"}`;
  return `${label}\n${rendered}${projection.truncated ? `\n… 已截断（原始 ${projection.originalCharacters} chars / ${projection.originalLines} lines）` : ""}`;
}

function tokenize(code: string, language: string | undefined): CodeToken[] {
  if (!language || !KNOWN_LANGUAGES.has(language)) return [Object.freeze({ kind: "plain", value: code })];
  const tokens: CodeToken[] = [];
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|--[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b|[{}()[\];,.<>:+*/%=&|!?~-]+)/gu;
  let offset = 0;
  for (const match of code.matchAll(pattern)) {
    const index = match.index ?? offset;
    if (index > offset) tokens.push(Object.freeze({ kind: "plain", value: code.slice(offset, index) }));
    const value = match[0];
    const kind: CodeTokenKind = /^(?:\/\*|\/\/|#|--)/u.test(value) ? "comment" : /^["'`]/u.test(value) ? "string" : /^\d/u.test(value) ? "number" : KEYWORDS.has(value) ? "keyword" : /^[A-Za-z_$]/u.test(value) ? "plain" : "operator";
    tokens.push(Object.freeze({ kind, value }));
    offset = index + value.length;
  }
  if (offset < code.length) tokens.push(Object.freeze({ kind: "plain", value: code.slice(offset) }));
  return tokens;
}

function normalizeLanguage(value: string | undefined): string | undefined {
  const language = value?.trim().toLowerCase();
  return language && /^[a-z0-9_+-]{1,32}$/u.test(language) ? language : undefined;
}
function sanitizeCode(value: string): string { return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu, ""); }
function cropAnsiFree(value: string, columns: number): string { return stripAnsi(value).length <= columns ? value : `${stripAnsi(value).slice(0, Math.max(1, columns - 1))}…`; }
function stripAnsi(value: string): string { return value.replace(/\u001b\[[0-9;]*m/gu, ""); }
function colorize(token: CodeToken, color: boolean): string {
  if (!color || token.kind === "plain") return token.value;
  const code = token.kind === "keyword" ? 35 : token.kind === "string" ? 32 : token.kind === "number" ? 36 : token.kind === "comment" ? 90 : 33;
  return `\u001b[${code}m${token.value}\u001b[0m`;
}

function sha256Text(value: string): string {
  const source = new TextEncoder().encode(value);
  const bitLength = source.length * 8;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source); bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0); view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000));
  const hash = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) { const a = words[index - 15]!; const b = words[index - 2]!; words[index] = (words[index - 16]! + (rotate(a, 7) ^ rotate(a, 18) ^ (a >>> 3)) + words[index - 7]! + (rotate(b, 17) ^ rotate(b, 19) ^ (b >>> 10))) >>> 0; }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) { const s1 = rotate(e!, 6) ^ rotate(e!, 11) ^ rotate(e!, 25); const choice = (e! & f!) ^ (~e! & g!); const t1 = (h! + s1 + choice + SHA256_K[index]! + words[index]!) >>> 0; const s0 = rotate(a!, 2) ^ rotate(a!, 13) ^ rotate(a!, 22); const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!); const t2 = (s0 + majority) >>> 0; h = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0; }
    hash[0] = (hash[0]! + a!) >>> 0; hash[1] = (hash[1]! + b!) >>> 0; hash[2] = (hash[2]! + c!) >>> 0; hash[3] = (hash[3]! + d!) >>> 0; hash[4] = (hash[4]! + e!) >>> 0; hash[5] = (hash[5]! + f!) >>> 0; hash[6] = (hash[6]! + g!) >>> 0; hash[7] = (hash[7]! + h!) >>> 0;
  }
  return [...hash].map((item) => item.toString(16).padStart(8, "0")).join("");
}
function rotate(value: number, bits: number): number { return (value >>> bits) | (value << (32 - bits)); }
const SHA256_K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
