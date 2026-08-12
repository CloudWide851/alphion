import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { SqliteStore } from "../adapters/store/sqlite-store.js";

const MASTER_ONE = "correct horse battery staple";
const MASTER_TWO = "another strong local password";

test("encrypted SQLite vault imports, locks, rotates, removes, and never stores plaintext", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "vault.sqlite3");
    const secret = `sk-${"vault-secret-material".repeat(3)}`;
    const store = new SqliteStore({ path });
    assert.deepEqual(await store.status(), { initialized: false, locked: true, secretCount: 0, autoLockMs: 900_000 });
    await store.initialize(MASTER_ONE);
    await store.upsertProfile({
      schemaVersion: 2,
      id: "deepseek",
      name: "DeepSeek",
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-reasoner",
      protocol: "chat-completions",
      auth: { mode: "none" },
      capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: true },
      active: true,
    });
    const imported = await store.importCredential("deepseek", secret);
    assert.equal(imported.auth.mode, "encrypted-sqlite");
    if (imported.auth.mode !== "encrypted-sqlite") assert.fail("Expected encrypted auth.");
    assert.equal(await store.resolve(imported.auth.secretId), secret);
    assert.equal((await store.status()).secretCount, 1);
    const initialNonce = readVaultNonce(path, imported.auth.secretId);

    store.lock();
    await assert.rejects(store.resolve(imported.auth.secretId), /locked/i);
    await assert.rejects(store.unlock("wrong password value"), /could not be unlocked/i);
    await store.unlock(MASTER_ONE);
    await store.rotateMasterPassword(MASTER_ONE, MASTER_TWO);
    assert.notDeepEqual(readVaultNonce(path, imported.auth.secretId), initialNonce);
    store.lock();
    await assert.rejects(store.unlock(MASTER_ONE), /could not be unlocked/i);
    await store.unlock(MASTER_TWO);
    assert.equal(await store.resolve(imported.auth.secretId), secret);

    const removed = await store.removeCredential("deepseek");
    assert.equal(removed.auth.mode, "none");
    assert.equal((await store.status()).secretCount, 0);
    store.close();

    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from(secret)), false);
    assert.equal(bytes.includes(Buffer.from(MASTER_ONE)), false);
    assert.equal(bytes.includes(Buffer.from(MASTER_TWO)), false);
  });
});

test("vault password rotation rolls back metadata and ciphertext together", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "rotation-rollback.sqlite3");
    const secret = ["sk", "rollback", "material", "123456"].join("-");
    const store = new SqliteStore({ path });
    await store.initialize(MASTER_ONE);
    await store.upsertProfile({
      schemaVersion: 2,
      id: "deepseek",
      name: "DeepSeek",
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      protocol: "chat-completions",
      auth: { mode: "none" },
      capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false },
      active: true,
    });
    const profile = await store.importCredential("deepseek", secret);
    if (profile.auth.mode !== "encrypted-sqlite") assert.fail("Expected encrypted auth.");

    const database = new DatabaseSync(path);
    database.exec(`
      CREATE TRIGGER reject_vault_rotation
      BEFORE UPDATE OF ciphertext ON vault_secrets
      BEGIN SELECT RAISE(ABORT, 'forced rotation rollback'); END;
    `);
    await assert.rejects(store.rotateMasterPassword(MASTER_ONE, MASTER_TWO), /rotation failed/i);
    database.exec("DROP TRIGGER reject_vault_rotation");
    database.close();

    store.lock();
    await store.unlock(MASTER_ONE);
    assert.equal(await store.resolve(profile.auth.secretId), secret);
    store.lock();
    await assert.rejects(store.unlock(MASTER_TWO), /could not be unlocked/i);
    store.close();
  });
});

test("vault detects ciphertext tampering and reset preserves profiles", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "tamper.sqlite3");
    const store = new SqliteStore({ path });
    await store.initialize(MASTER_ONE);
    await store.upsertProfile({
      schemaVersion: 2,
      id: "deepseek",
      name: "DeepSeek",
      kind: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-chat",
      protocol: "chat-completions",
      auth: { mode: "none" },
      capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false },
      active: true,
    });
    const profile = await store.importCredential("deepseek", ["sk", "tamper", "detection", "material", "123456"].join("-"));
    if (profile.auth.mode !== "encrypted-sqlite") assert.fail("Expected encrypted auth.");
    const secretId = profile.auth.secretId;
    store.close();

    const database = new DatabaseSync(path);
    const row = database.prepare("SELECT ciphertext FROM vault_secrets WHERE secret_id = ?").get(secretId) as { ciphertext: Uint8Array };
    const corrupted = Buffer.from(row.ciphertext);
    corrupted[0] = (corrupted[0] ?? 0) ^ 0xff;
    database.prepare("UPDATE vault_secrets SET ciphertext = ? WHERE secret_id = ?").run(corrupted, secretId);
    database.close();

    const reopened = new SqliteStore({ path });
    await reopened.unlock(MASTER_ONE);
    await assert.rejects(reopened.resolve(secretId), /failed authentication/i);
    assert.equal(await reopened.reset(), 1);
    assert.equal((await reopened.getProfile("deepseek"))?.auth.mode, "none");
    assert.deepEqual(await reopened.status(), { initialized: false, locked: true, secretCount: 0, autoLockMs: 900_000 });
    reopened.close();
  });
});

test("vault auto-lock expires an unlocked key", async () => {
  await withTemporaryDirectory(async (directory) => {
    const store = new SqliteStore({ path: join(directory, "timeout.sqlite3"), vaultAutoLockMs: 10 });
    await store.initialize(MASTER_ONE);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal((await store.status()).locked, true);
    store.close();
  });
});

test("SQLite schema v1 profiles migrate through schema v3 without losing environment auth", async () => {
  await withTemporaryDirectory(async (directory) => {
    const path = join(directory, "v1.sqlite3");
    createV1Database(path);
    const store = new SqliteStore({ path });
    try {
      const profile = await store.getActiveProfile();
      assert.equal(profile?.schemaVersion, 2);
      assert.equal(profile?.kind, "openai-compatible");
      assert.equal(profile?.auth.mode, "bearer-env");
      assert.equal(profile?.capabilities.reasoning, false);
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal((database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });
});

function createV1Database(path: string): void {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
    CREATE TABLE provider_profiles (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, base_url TEXT NOT NULL, model TEXT NOT NULL,
      protocol TEXT NOT NULL, auth_mode TEXT NOT NULL, auth_environment_variable TEXT,
      capabilities_json TEXT NOT NULL, revision INTEGER NOT NULL, active INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX provider_profiles_one_active ON provider_profiles(active) WHERE active = 1;
    CREATE TABLE runs (run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE events (
      run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE, sequence INTEGER NOT NULL,
      event_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL, correlation_id TEXT NOT NULL,
      causation_id TEXT, timestamp TEXT NOT NULL, kind TEXT NOT NULL, payload_json TEXT NOT NULL,
      previous_digest TEXT NOT NULL, digest TEXT NOT NULL, PRIMARY KEY (run_id, sequence)
    );
    CREATE TABLE cache_entries (
      namespace TEXT NOT NULL, cache_key TEXT NOT NULL, value_text TEXT NOT NULL, created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL, provenance TEXT NOT NULL, size_bytes INTEGER NOT NULL, hit_count INTEGER NOT NULL,
      last_accessed_at TEXT NOT NULL, PRIMARY KEY (namespace, cache_key)
    );
    CREATE INDEX cache_entries_lru ON cache_entries(last_accessed_at);
    CREATE TABLE cache_metrics (id INTEGER PRIMARY KEY, hits INTEGER NOT NULL, misses INTEGER NOT NULL);
    INSERT INTO cache_metrics VALUES (1, 0, 0);
    CREATE TABLE shell_rules (
      id TEXT PRIMARY KEY, executable_path TEXT NOT NULL, executable_key TEXT NOT NULL, executable_digest TEXT,
      argument_prefix_json TEXT NOT NULL, enabled INTEGER NOT NULL, created_at TEXT NOT NULL
    );
    CREATE INDEX shell_rules_lookup ON shell_rules(executable_key, enabled);
    INSERT INTO provider_profiles VALUES (
      'legacy', 'Legacy', 'https://example.com/v1', 'legacy-model', 'chat-completions', 'bearer-env',
      'LEGACY_API_KEY', '{"streaming":true,"tools":true,"promptCaching":false}', 4, 1,
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version = 1;
    `);
  } finally {
    database.close();
  }
}

function readVaultNonce(path: string, secretId: string): Buffer {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const row = database.prepare("SELECT nonce FROM vault_secrets WHERE secret_id = ?").get(secretId) as {
      nonce: Uint8Array;
    };
    return Buffer.from(row.nonce);
  } finally {
    database.close();
  }
}

async function withTemporaryDirectory(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alphion-vault-test-"));
  try {
    await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
