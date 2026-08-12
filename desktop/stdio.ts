import type { Readable, Writable } from "node:stream";
import type { DesktopTransport } from "./host.js";
import { DESKTOP_RPC_MAX_LINE_BYTES, type RpcOutbound } from "./protocol.js";

const DEFAULT_MAX_PENDING_BYTES = 4 * 1024 * 1024;

export class StdioJsonlTransport implements DesktopTransport {
  #closed = false;
  #writeTail: Promise<void> = Promise.resolve();
  #pendingBytes = 0;
  constructor(private readonly input: Readable = process.stdin, private readonly output: Writable = process.stdout, private readonly maxPendingBytes = DEFAULT_MAX_PENDING_BYTES) { if (!Number.isSafeInteger(maxPendingBytes) || maxPendingBytes < DESKTOP_RPC_MAX_LINE_BYTES || maxPendingBytes > 64 * 1024 * 1024) throw new Error("Desktop output queue limit is invalid."); }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    let buffer = "";
    for await (const chunk of this.input) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/u, "");
        buffer = buffer.slice(index + 1);
        if (line) yield Buffer.byteLength(line) > DESKTOP_RPC_MAX_LINE_BYTES ? "{" : line;
      }
      if (Buffer.byteLength(buffer) > DESKTOP_RPC_MAX_LINE_BYTES) { buffer = ""; yield "{"; }
    }
    if (buffer.trim()) yield buffer;
  }
  send(message: RpcOutbound): Promise<void> {
    if (this.#closed) return Promise.reject(new Error("Desktop transport is closed."));
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (this.#pendingBytes + bytes > this.maxPendingBytes) return Promise.reject(new Error("Desktop output backpressure limit exceeded."));
    this.#pendingBytes += bytes;
    const write = this.#writeTail.then(() => writeLine(this.output, line));
    this.#writeTail = write.finally(() => { this.#pendingBytes -= bytes; });
    return this.#writeTail;
  }
  async close(): Promise<void> { this.#closed = true; await this.#writeTail; }
}

function writeLine(output: Writable, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let settled = false;
    const finish = (): void => { if (!settled && callbackDone && drained) { settled = true; cleanup(); resolve(); } };
    const onError = (error: Error): void => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const onDrain = (): void => { drained = true; finish(); };
    const cleanup = (): void => { output.off("error", onError); output.off("drain", onDrain); };
    output.once("error", onError);
    drained = output.write(line, () => { callbackDone = true; finish(); });
    if (!drained) output.once("drain", onDrain);
  });
}
