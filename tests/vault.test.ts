import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnoseLocalProject } from "../adapters/local/local-application.js";
import { FileProjectKeyProvider } from "../adapters/secrets/project-key.js";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { encryptValue } from "../adapters/store/sqlite-codecs.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { canonicalJson } from "../src/application/canonical.js";

const PROJECT_ID = "project_credential_test";
const DOMAIN_ID = "domain_credential_test";

test("Project credentials encrypt independently and restart without a password", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "project.sqlite3");
    const keyRoot = join(directory, "project-keys");
    const provider = new FileProjectKeyProvider(keyRoot);
    const credential = ["opaque", "project", "material".repeat(3)].join("-");
    let store = openStore(path, provider);
    assert.deepEqual(await store.credentialStatus(), { schemaVersion: 1, projectKeyAvailable: true, secretCount: 0, reentryRequiredProfileIds: [] });
    await store.upsertProfile(profile());
    const imported = await store.importCredential("deepseek", credential);
    assert.equal(imported.auth.mode, "encrypted-project");
    if (imported.auth.mode !== "encrypted-project") assert.fail("Expected encrypted Project auth.");
    assert.equal(await store.resolve(imported.auth.secretId), credential);
    assert.deepEqual(await store.credentialStatus(), { schemaVersion: 1, projectKeyAvailable: true, secretCount: 1, reentryRequiredProfileIds: [] });
    store.close();

    assert.equal((await readFile(provider.pathFor(PROJECT_ID))).byteLength, 32);
    store = openStore(path, new FileProjectKeyProvider(keyRoot));
    assert.equal(await store.resolve(imported.auth.secretId), credential);
    const replaced = await store.importCredential("deepseek", `${credential}-replacement`);
    if (replaced.auth.mode !== "encrypted-project") assert.fail("Expected encrypted Project auth.");
    assert.equal(replaced.auth.secretId, imported.auth.secretId);
    assert.equal(await store.resolve(replaced.auth.secretId), `${credential}-replacement`);
    assert.equal((await store.removeCredential("deepseek")).auth.mode, "none");
    store.close();

    const bytes = await readFile(path);
    assert.equal(bytes.includes(Buffer.from(credential)), false);
    assert.equal(bytes.includes(Buffer.from(`${credential}-replacement`)), false);
  });
});

test("Project key loss, corruption, and ciphertext tamper fail closed", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "tamper.sqlite3");
    const provider = new FileProjectKeyProvider(join(directory, "project-keys"));
    let store = openStore(path, provider);
    await store.upsertProfile(profile());
    const imported = await store.importCredential("deepseek", "opaque-project-tamper-material-123456");
    if (imported.auth.mode !== "encrypted-project") assert.fail("Expected encrypted Project auth.");
    store.close();

    const keyPath = provider.pathFor(PROJECT_ID);
    const lostPath = `${keyPath}.lost`;
    await rename(keyPath, lostPath);
    store = openStore(path, provider);
    await rejectsReason(store.resolve(imported.auth.secretId), "project-key-unavailable");
    store.close();
    await rename(lostPath, keyPath);
    const originalKey = await readFile(keyPath);
    await writeFile(keyPath, Buffer.from("corrupt"));
    store = openStore(path, provider);
    await rejectsReason(store.resolve(imported.auth.secretId), "project-key-corrupt");
    store.close();
    await writeFile(keyPath, originalKey);

    mutateBlob(path, "project_credentials", "ciphertext", "secret_id", imported.auth.secretId);
    store = openStore(path, provider);
    await rejectsReason(store.resolve(imported.auth.secretId), "credential-authentication-failed");
    store.close();
  });
});

test("doctor reports a missing Project key without modifying SQLite", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "doctor.sqlite3");
    const provider = new FileProjectKeyProvider(join(directory, "project-keys"));
    const store = openStore(path, provider);
    await store.upsertProfile(profile());
    await store.importCredential("deepseek", "opaque-doctor-material-123456789");
    store.close();
    await rm(provider.pathFor(PROJECT_ID));
    const before = await readFile(path);
    const beforeSize = (await stat(path)).size;
    const report = await diagnoseLocalProject({ projectRoot: directory, statePath: path, projectId: PROJECT_ID, projectKeyProvider: provider });
    const check = report.checks.find((item) => item.id === "project-credentials");
    assert.equal(check?.status, "fail");
    assert.match(check?.summary ?? "", /Project 密钥不可用/u);
    assert.equal((await stat(path)).size, beforeSize);
    assert.deepEqual(await readFile(path), before);
  });
});

test("v7 device credentials re-encrypt once or require explicit re-entry", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "migrate.sqlite3");
    const legacyKeyPath = join(directory, "device.key");
    const credential = "opaque-v7-device-material-123456";
    await createLegacyV7State(path, legacyKeyPath, credential);
    const provider = new FileProjectKeyProvider(join(directory, "project-keys"));
    const migrated = new SqliteStore({ path, projectId: PROJECT_ID, domainId: DOMAIN_ID, projectKeyProvider: provider, legacyDeviceKeyPath: legacyKeyPath });
    await migrated.migrateLegacyCredentials();
    const profileAfter = await migrated.getProfile("deepseek");
    assert.equal(profileAfter?.auth.mode, "encrypted-project");
    if (!profileAfter || profileAfter.auth.mode !== "encrypted-project") assert.fail("Expected migrated Project credential.");
    assert.equal(await migrated.resolve(profileAfter.auth.secretId), credential);
    migrated.close();
    assert.equal(version(`${path}.v7-backup`), 7);

    const missingPath = join(directory, "missing.sqlite3");
    const missingLegacyKey = join(directory, "missing-device.key");
    await createLegacyV7State(missingPath, missingLegacyKey, credential);
    await rm(missingLegacyKey);
    const pending = new SqliteStore({ path: missingPath, projectId: PROJECT_ID, domainId: DOMAIN_ID, projectKeyProvider: provider, legacyDeviceKeyPath: missingLegacyKey });
    await pending.migrateLegacyCredentials();
    assert.equal((await pending.getProfile("deepseek"))?.auth.mode, "none");
    assert.deepEqual((await pending.credentialStatus()).reentryRequiredProfileIds, ["deepseek"]);
    pending.close();
    const audit = openSqliteDatabase(missingPath, { readOnly: true });
    assert.equal((audit.prepare("SELECT COUNT(*) AS count FROM device_vault_secrets").get() as { count: number }).count, 1);
    audit.close();
  });
});

function openStore(path: string, projectKeyProvider: FileProjectKeyProvider): SqliteStore {
  return new SqliteStore({ path, projectId: PROJECT_ID, domainId: DOMAIN_ID, projectKeyProvider });
}

function profile() {
  return {
    schemaVersion: 3 as const,
    id: "deepseek", name: "DeepSeek", kind: "deepseek" as const, presetId: "deepseek",
    model: "deepseek-chat", protocol: "chat-completions" as const, auth: { mode: "none" as const },
    capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false, vision: false }, active: true,
  };
}

async function createLegacyV7State(path: string, legacyKeyPath: string, credential: string): Promise<void> {
  const initial = new SqliteStore({ path, projectId: PROJECT_ID, domainId: DOMAIN_ID });
  await initial.upsertProfile(profile());
  initial.close();
  const deviceKey = randomBytes(32);
  const dataKey = randomBytes(32);
  const plaintext = Buffer.from(credential, "utf8");
  const secretId = "vault_legacydevice123";
  const keyId = "device_key_legacy123";
  const wrapped = encryptValue(deviceKey, dataKey, legacyKeyAad(keyId));
  const encrypted = encryptValue(dataKey, plaintext, legacySecretAad(secretId, "deepseek", 1));
  await writeFile(legacyKeyPath, deviceKey);
  const database = openSqliteDatabase(path);
  try {
    database.exec("PRAGMA foreign_keys = OFF");
    database.exec(`
      DROP TABLE message_attachments; DROP TABLE attachments;
      DROP TABLE project_credential_migrations; DROP TABLE project_credentials;
      CREATE TABLE provider_profiles_v7 (
        id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
        provider_kind TEXT NOT NULL, base_url TEXT NOT NULL, model TEXT NOT NULL,
        protocol TEXT NOT NULL, auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer-env', 'encrypted-sqlite')),
        auth_environment_variable TEXT, auth_secret_id TEXT, capabilities_json TEXT NOT NULL,
        revision INTEGER NOT NULL, active INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO provider_profiles_v7
        (id, name, provider_kind, base_url, model, protocol, auth_mode,
         auth_environment_variable, auth_secret_id, capabilities_json, revision,
         active, created_at, updated_at)
      SELECT id, name, provider_kind, base_url, model, protocol, auth_mode,
        auth_environment_variable, auth_secret_id, capabilities_json, revision,
        active, created_at, updated_at FROM provider_profiles;
      DROP INDEX provider_profiles_one_active; DROP TABLE provider_profiles;
      ALTER TABLE provider_profiles_v7 RENAME TO provider_profiles;
      CREATE UNIQUE INDEX provider_profiles_one_active ON provider_profiles(active) WHERE active = 1;
    `);
    const now = new Date().toISOString();
    database.prepare("INSERT INTO device_vault_metadata VALUES (1, 1, ?, ?, ?, ?, ?, ?)").run(keyId, wrapped.nonce, wrapped.ciphertext, wrapped.authTag, now, now);
    database.prepare("INSERT INTO device_vault_secrets VALUES (?, 'deepseek', 1, ?, ?, ?, ?, ?)").run(secretId, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now, now);
    database.prepare("UPDATE provider_profiles SET auth_mode = 'encrypted-sqlite', auth_secret_id = ? WHERE id = 'deepseek'").run(secretId);
    database.exec("PRAGMA user_version = 7; PRAGMA foreign_keys = ON");
  } finally { database.close(); deviceKey.fill(0); dataKey.fill(0); plaintext.fill(0); }
}

function legacyKeyAad(keyId: string): Buffer { return Buffer.from(canonicalJson({ schemaVersion: 1, kind: "device-data-key", keyId }), "utf8"); }
function legacySecretAad(secretId: string, profileId: string, revision: number): Buffer { return Buffer.from(canonicalJson({ schemaVersion: 2, kind: "provider-credential", secretId, profileId, revision }), "utf8"); }

function mutateBlob(path: string, table: string, column: string, keyColumn: string, key: unknown): void {
  const database = openSqliteDatabase(path);
  try {
    const row = database.prepare(`SELECT ${column} AS value FROM ${table} WHERE ${keyColumn} = ?`).get(key) as { value: Uint8Array };
    const value = Buffer.from(row.value); value[0] = (value[0] ?? 0) ^ 0xff;
    database.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`).run(value, key);
  } finally { database.close(); }
}

function version(path: string): number {
  const database = openSqliteDatabase(path, { readOnly: true });
  try { return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version; }
  finally { database.close(); }
}

async function rejectsReason(promise: Promise<unknown>, reason: string): Promise<void> {
  await assert.rejects(promise, (error) => error instanceof Error && "reason" in error && error.reason === reason);
}

async function temporary(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v090-credentials-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
