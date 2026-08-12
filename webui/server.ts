import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { AlphionError } from "../src/index.js";
import { decodeUiCommandEnvelope, type UiCommandClient } from "../ui/contracts.js";

const MAX_BODY_BYTES = 256 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;

export interface WebUiServer {
  readonly origin: string;
  close(): Promise<void>;
}

export async function createWebUiServer(options: Readonly<{ client: UiCommandClient; port?: number; assetsRoot?: string }>): Promise<WebUiServer> {
  const sessions = new Map<string, Readonly<{ csrf: string; expiresAt: number }>>();
  let expectedOrigin = "";
  const server = createServer((request, response) => void route(request, response, options.client, sessions, expectedOrigin, options.assetsRoot));
  await new Promise<void>((done, reject) => { server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); done(); }); });
  const address = server.address() as AddressInfo;
  expectedOrigin = `http://127.0.0.1:${address.port}`;
  return Object.freeze({ origin: expectedOrigin, close: () => closeServer(server, options.client) });
}

async function route(request: IncomingMessage, response: ServerResponse, client: UiCommandClient, sessions: Map<string, Readonly<{ csrf: string; expiresAt: number }>>, origin: string, assetsRoot?: string): Promise<void> {
  try {
    setSecurityHeaders(response);
    const url = new URL(request.url ?? "/", origin);
    if (request.method === "POST" && url.pathname === "/api/bootstrap") {
      assertOrigin(request, origin);
      deleteExpiredSessions(sessions);
      const sessionId = randomBytes(32).toString("base64url");
      const csrf = randomBytes(32).toString("base64url");
      sessions.set(digest(sessionId), Object.freeze({ csrf, expiresAt: Date.now() + SESSION_TTL_MS }));
      response.setHeader("set-cookie", `alphion_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`);
      return json(response, 200, { schemaVersion: 1, csrf });
    }
    if (request.method === "POST" && url.pathname === "/api/command") {
      const session = authorize(request, sessions, origin, true);
      assertCsrf(request, session.csrf);
      return json(response, 200, await client.execute(decodeUiCommandEnvelope(await readJson(request))));
    }
    if (request.method === "POST" && url.pathname.startsWith("/api/secret/provider/")) {
      const session = authorize(request, sessions, origin, true); assertCsrf(request, session.csrf);
      const profileId = decodeURIComponent(url.pathname.slice("/api/secret/provider/".length));
      if (!/^[A-Za-z0-9:_-]{1,200}$/u.test(profileId)) throw new AlphionError("validation", "Provider profile ID is invalid.", { stage: "webui" });
      const body = record(await readJson(request));
      exact(body, ["secret"]);
      if (typeof body.secret !== "string" || !body.secret || body.secret.length > 16 * 1024) throw new AlphionError("validation", "A bounded Provider credential is required.", { stage: "webui" });
      await client.importProviderCredential(profileId, body.secret);
      return json(response, 200, { schemaVersion: 1, imported: true });
    }
    if (request.method === "POST" && url.pathname === "/api/approval") {
      const session = authorize(request, sessions, origin, true); assertCsrf(request, session.csrf);
      const body = record(await readJson(request)); exact(body, ["requestId", "actionDigest", "shapeDigest", "approved"]);
      if (typeof body.requestId !== "string" || typeof body.actionDigest !== "string" || typeof body.approved !== "boolean") throw new Error("Invalid approval decision.");
      client.decideApproval({ requestId: body.requestId, actionDigest: body.actionDigest, ...(typeof body.shapeDigest === "string" ? { shapeDigest: body.shapeDigest } : {}), approved: body.approved });
      return json(response, 200, { schemaVersion: 1, resolved: true });
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      authorize(request, sessions, origin, false);
      const cursor = parseCursor(url.searchParams.get("cursor") ?? request.headers["last-event-id"]);
      response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
      const abort = new AbortController(); request.once("close", () => abort.abort());
      const iterator = client.subscribe(cursor)[Symbol.asyncIterator]();
      try {
        while (!abort.signal.aborted) {
          const next = await iterator.next(); if (next.done) break;
          if (!response.write(`id: ${next.value.cursor}\nevent: ${next.value.payload.kind}\ndata: ${JSON.stringify(next.value)}\n\n`)) await new Promise<void>((done) => response.once("drain", done));
        }
      } finally { await iterator.return?.(); response.end(); }
      return;
    }
    if (request.method === "GET") return serveAsset(url.pathname, response, assetsRoot);
    return json(response, 404, { error: { code: "not-found", message: "Route not found." } });
  } catch (error) {
    const safe = error instanceof AlphionError ? error : new AlphionError("validation", "WebUI request is invalid.", { stage: "webui" });
    json(response, errorStatus(safe), { error: { code: safe.code, message: safe.message, stage: safe.stage } });
  }
}

function authorize(request: IncomingMessage, sessions: Map<string, Readonly<{ csrf: string; expiresAt: number }>>, origin: string, requireOrigin: boolean) {
  if (requireOrigin) assertOrigin(request, origin);
  const cookie = /(?:^|;\s*)alphion_session=([^;]+)/u.exec(request.headers.cookie ?? "")?.[1];
  const session = cookie ? sessions.get(digest(cookie)) : undefined;
  if (!session || session.expiresAt <= Date.now()) { if (cookie) sessions.delete(digest(cookie)); throw new AlphionError("forbidden", "WebUI session is missing or expired.", { stage: "webui" }); }
  return session;
}

function assertOrigin(request: IncomingMessage, expected: string): void { if (request.headers.origin !== expected) throw new Error("WebUI Origin is not allowed."); }
function assertCsrf(request: IncomingMessage, expected: string): void { const value = request.headers["x-alphion-csrf"]; if (typeof value !== "string" || !constantEqual(value, expected)) throw new Error("WebUI CSRF challenge is invalid."); }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function constantEqual(left: string, right: string): boolean { const a = Buffer.from(left); const b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b); }
function parseCursor(value: string | string[] | null | undefined): number { const parsed = Number.parseInt(Array.isArray(value) ? value[0] ?? "0" : value ?? "0", 10); return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0; }

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of request) { const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); bytes += buffer.byteLength; if (bytes > MAX_BODY_BYTES) throw new Error("WebUI request is too large."); chunks.push(buffer); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function deleteExpiredSessions(sessions: Map<string, Readonly<{ csrf: string; expiresAt: number }>>): void { const now = Date.now(); for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key); }
function record(value: unknown): Readonly<Record<string, unknown>> { if (!value || typeof value !== "object" || Array.isArray(value)) throw new AlphionError("validation", "WebUI request body must be an object.", { stage: "webui" }); return value as Readonly<Record<string, unknown>>; }
function exact(value: Readonly<Record<string, unknown>>, keys: readonly string[]): void { if (Object.keys(value).some((key) => !keys.includes(key))) throw new AlphionError("validation", "WebUI request contains an unknown field.", { stage: "webui" }); }
function errorStatus(error: AlphionError): number { return error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : error.code === "internal" || error.code === "integrity-failed" ? 500 : 400; }

async function serveAsset(pathname: string, response: ServerResponse, assetsRoot?: string): Promise<void> {
  const root = resolve(assetsRoot ?? join(process.cwd(), "dist", "webui", "client"));
  const requested = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  const path = resolve(root, requested);
  if (path !== root && !path.startsWith(`${root}\\`) && !path.startsWith(`${root}/`)) return json(response, 404, { error: { code: "not-found" } });
  let selected = path;
  if (!(await stat(selected).then((item) => item.isFile()).catch(() => false))) selected = join(root, "index.html");
  if (!(await stat(selected).then((item) => item.isFile()).catch(() => false))) {
    const fallback = await readFile(new URL("./client/index.html", import.meta.url), "utf8"); response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(fallback); return;
  }
  response.writeHead(200, { "content-type": mime(extname(selected)), "cache-control": selected.endsWith("index.html") ? "no-store" : "public, max-age=31536000, immutable" }); createReadStream(selected).pipe(response);
}

function setSecurityHeaders(response: ServerResponse): void { response.setHeader("content-security-policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"); response.setHeader("x-content-type-options", "nosniff"); response.setHeader("referrer-policy", "no-referrer"); response.setHeader("cross-origin-opener-policy", "same-origin"); }
function json(response: ServerResponse, status: number, value: unknown): void { if (response.headersSent) return; response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
function mime(extension: string): string { return extension === ".js" ? "text/javascript; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : extension === ".svg" ? "image/svg+xml" : "text/html; charset=utf-8"; }
async function closeServer(server: Server, client: UiCommandClient): Promise<void> { await client.close(); await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())); }
