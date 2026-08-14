import assert from "node:assert/strict";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnoseLocalProject } from "../adapters/local/local-application.js";
import { FileDeviceKeyProvider } from "../adapters/secrets/device-key.js";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";

test("device vault provisions on first import and restarts without a password", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "device.sqlite3");
    const keyPath = join(directory, "config", "device.key");
    const credential = ["opaque", "device", "material".repeat(3)].join("-");
    const provider = new FileDeviceKeyProvider(keyPath);
    let store = new SqliteStore({ path, deviceKeyProvider: provider });
    assert.deepEqual(await store.status(), { schemaVersion: 2, mode: "unprovisioned", provisioned: false, deviceKeyAvailable: false, secretCount: 0, legacySecretCount: 0 });
    await store.upsertProfile(profile());
    const imported = await store.importCredential("deepseek", credential);
    assert.equal(imported.auth.mode, "encrypted-sqlite");
    if (imported.auth.mode !== "encrypted-sqlite") assert.fail("Expected encrypted auth.");
    assert.equal(await store.resolve(imported.auth.secretId), credential);
    assert.deepEqual(await store.status(), { schemaVersion: 2, mode: "device", provisioned: true, deviceKeyAvailable: true, secretCount: 1, legacySecretCount: 0 });
    store.close();

    assert.equal((await readFile(keyPath)).byteLength, 32);
    store = new SqliteStore({ path, deviceKeyProvider: new FileDeviceKeyProvider(keyPath) });
    assert.equal(await store.resolve(imported.auth.secretId), credential);
    const replaced = await store.importCredential("deepseek", `${credential}-replacement`);
    if (replaced.auth.mode !== "encrypted-sqlite") assert.fail("Expected encrypted auth.");
    assert.equal(replaced.auth.secretId, imported.auth.secretId);
    assert.equal(await store.resolve(replaced.auth.secretId), `${credential}-replacement`);
    assert.equal((await store.removeCredential("deepseek")).auth.mode, "none");
    assert.equal(await store.reset(), 0);
    store.close();

    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from(credential)), false);
    assert.equal(bytes.includes(Buffer.from(`${credential}-replacement`)), false);
  });
});

test("device key loss, corruption, envelope tamper, and ciphertext tamper fail closed", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "tamper.sqlite3");
    const keyPath = join(directory, "device.key");
    const lostPath = join(directory, "device.key.lost");
    const provider = new FileDeviceKeyProvider(keyPath);
    let store = new SqliteStore({ path, deviceKeyProvider: provider });
    await store.upsertProfile(profile());
    const imported = await store.importCredential("deepseek", ["opaque", "tamper", "material", "123456"].join("-"));
    if (imported.auth.mode !== "encrypted-sqlite") assert.fail("Expected encrypted auth.");
    store.close();

    await rename(keyPath, lostPath);
    store = new SqliteStore({ path, deviceKeyProvider: provider });
    await rejectsReason(store.resolve(imported.auth.secretId), "device-key-unavailable");
    store.close();
    await rename(lostPath, keyPath);
    const originalKey = await readFile(keyPath);
    await writeFile(keyPath, Buffer.from("corrupt"));
    store = new SqliteStore({ path, deviceKeyProvider: provider });
    await rejectsReason(store.resolve(imported.auth.secretId), "device-key-corrupt");
    store.close();
    await writeFile(keyPath, originalKey);

    mutateBlob(path, "device_vault_metadata", "wrapped_key_ciphertext", "id", 1);
    store = new SqliteStore({ path, deviceKeyProvider: provider });
    await rejectsReason(store.resolve(imported.auth.secretId), "device-envelope-authentication-failed");
    store.close();
    mutateBlob(path, "device_vault_metadata", "wrapped_key_ciphertext", "id", 1);
    mutateBlob(path, "device_vault_secrets", "ciphertext", "secret_id", imported.auth.secretId);
    store = new SqliteStore({ path, deviceKeyProvider: provider });
    await rejectsReason(store.resolve(imported.auth.secretId), "credential-authentication-failed");
    store.close();
  });
});

test("doctor reports a missing device key without modifying the database", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "doctor.sqlite3");
    const keyPath = join(directory, "device.key");
    const provider = new FileDeviceKeyProvider(keyPath);
    const store = new SqliteStore({ path, deviceKeyProvider: provider });
    await store.upsertProfile(profile());
    await store.importCredential("deepseek", ["opaque", "doctor", "material", "123456789"].join("-"));
    store.close();
    await rm(keyPath);
    const before = await readFile(path);
    const beforeSize = (await stat(path)).size;
    const report = await diagnoseLocalProject({ projectRoot: directory, statePath: path, deviceKeyProvider: provider });
    const check = report.checks.find((item) => item.id === "device-vault");
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /设备密钥不可用/u);
    assert.equal((await stat(path)).size, beforeSize);
    assert.deepEqual(await readFile(path), before);
  });
});

test("v6 password credentials migrate as legacy-disabled and reset only by explicit request", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "legacy.sqlite3");
    const store = new SqliteStore({ path, deviceKeyProvider: new FileDeviceKeyProvider(join(directory, "device.key")) });
    await store.upsertProfile(profile());
    store.close();
    createLegacyV6State(path);

    const migrated = new SqliteStore({ path, deviceKeyProvider: new FileDeviceKeyProvider(join(directory, "device.key")) });
    assert.deepEqual(await migrated.legacyStatus(), { disabled: true, secretCount: 1 });
    assert.equal((await migrated.status()).mode, "legacy-disabled");
    await rejectsReason(migrated.resolve("vault_legacy123"), "legacy-vault-disabled");
    assert.equal(await migrated.resetLegacy(), 1);
    assert.deepEqual(await migrated.legacyStatus(), { disabled: false, secretCount: 0 });
    assert.equal((await migrated.getProfile("deepseek"))?.auth.mode, "none");
    migrated.close();

    const backup = openSqliteDatabase(`${path}.v6-backup`, { readOnly: true });
    assert.equal((backup.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    assert.equal((backup.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get() as { count: number }).count, 1);
    backup.close();
  });
});

function profile() {
  return {
    schemaVersion: 2 as const,
    id: "deepseek", name: "DeepSeek", kind: "deepseek" as const, presetId: "deepseek",
    model: "deepseek-chat", protocol: "chat-completions" as const, auth: { mode: "none" as const },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false }, active: true,
  };
}

function mutateBlob(path: string, table: string, column: string, keyColumn: string, key: unknown): void {
  const database = openSqliteDatabase(path);
  try {
    const row = database.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`).get(key) as { value: Uint8Array };
    const value = Buffer.from(row.value); value[0] = (value[0] ?? 0) ^ 0xff;
    database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`).run(value, key);
  } finally { database.close(); }
}

function createLegacyV6State(path: string): void {
  const database = openSqliteDatabase(path);
  try {
    database.exec(`
      DROP TABLE schedule_commands; DROP TABLE schedule_executions; DROP TABLE schedules;
      DROP TABLE goal_commands; DROP TABLE goal_revisions; DROP TABLE goals;
      DROP TABLE compaction_records; DROP TABLE vault_legacy_state;
      DROP TABLE device_vault_secrets; DROP TABLE device_vault_metadata;
      INSERT INTO vault_metadata VALUES (1, 1, 'scrypt', X'00', 131072, 8, 1, X'00', X'00', X'00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO vault_secrets VALUES ('vault_legacy123', 'deepseek', 1, X'00', X'00', X'00', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      UPDATE provider_profiles SET auth_mode = 'encrypted-sqlite', auth_secret_id = 'vault_legacy123' WHERE id = 'deepseek';
      PRAGMA user_version = 6;
    `);
  } finally { database.close(); }
}

async function rejectsReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof Error && "reason" in error && error.reason === reason);
}

async function temporary(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v080-vault-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
