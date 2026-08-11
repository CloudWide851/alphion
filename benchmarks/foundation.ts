import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { MemoryLruCache } from "../adapters/cache/memory-cache.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";

const directory = await mkdtemp(join(tmpdir(), "alphion-benchmark-"));
try {
  const memory = new MemoryLruCache({ maxEntries: 10_000, maxBytes: 64 * 1024 * 1024 });
  const startMemory = performance.now();
  for (let index = 0; index < 10_000; index += 1) {
    await memory.set({
      namespace: "benchmark",
      key: String(index),
      value: `value-${index}`,
      provenance: "{}",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  }
  for (let index = 0; index < 10_000; index += 1) await memory.get("benchmark", String(index));
  const memoryMs = performance.now() - startMemory;

  const store = new SqliteStore({ path: join(directory, "benchmark.sqlite3") });
  const runBase = { runId: "run_benchmark", sessionId: "session_benchmark", correlationId: "correlation_benchmark" };
  const startEvents = performance.now();
  await store.append({ ...runBase, kind: "run.started", payload: { benchmark: true } });
  for (let index = 0; index < 1000; index += 1) {
    await store.append({ ...runBase, kind: "model.delta", payload: { delta: String(index) } });
  }
  await store.append({ ...runBase, kind: "run.completed", payload: { benchmark: true } });
  const eventMs = performance.now() - startEvents;
  const valid = await store.verifyRun(runBase.runId);
  store.close();

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    memoryCache: { operations: 20_000, elapsedMs: Number(memoryMs.toFixed(2)) },
    sqliteEvents: { events: 1002, elapsedMs: Number(eventMs.toFixed(2)), hashChainValid: valid },
  }, null, 2)}\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
