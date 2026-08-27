import type { SqliteDatabase } from "./database.js";
import { optionalRow, readString, requiredRow } from "./sqlite-codecs.js";

/** Creates Project-scoped credential envelopes and removes the legacy auth mode from public profiles. */
export function createProjectCredentialSchemaV8(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS project_credentials (
      secret_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL,
      nonce BLOB NOT NULL, ciphertext BLOB NOT NULL, auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS project_credentials_project ON project_credentials(project_id, profile_id);
    CREATE TABLE IF NOT EXISTS project_credential_migrations (
      profile_id TEXT PRIMARY KEY REFERENCES provider_profiles(id) ON DELETE CASCADE,
      source_secret_id TEXT,
      source_kind TEXT NOT NULL CHECK (source_kind IN ('device-vault', 'legacy-vault')),
      state TEXT NOT NULL CHECK (state IN ('pending', 'migrated', 'reentry-required')),
      updated_at TEXT NOT NULL
    );
    INSERT OR IGNORE INTO project_credential_migrations
      (profile_id, source_secret_id, source_kind, state, updated_at)
    SELECT p.id, p.auth_secret_id,
      CASE WHEN EXISTS(SELECT 1 FROM device_vault_secrets d WHERE d.secret_id = p.auth_secret_id)
        THEN 'device-vault' ELSE 'legacy-vault' END,
      CASE WHEN EXISTS(SELECT 1 FROM device_vault_secrets d WHERE d.secret_id = p.auth_secret_id)
        THEN 'pending' ELSE 'reentry-required' END,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM provider_profiles p WHERE p.auth_mode = 'encrypted-sqlite';
  `);
  rebuildProviderProfiles(database);
  database.exec("PRAGMA user_version = 8");
}

function rebuildProviderProfiles(database: SqliteDatabase): void {
  const row = optionalRow(database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'provider_profiles'").get());
  if (!row || readString(row, "sql").includes("encrypted-project")) return;
  database.exec(`
    CREATE TABLE provider_profiles_v8 (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      provider_kind TEXT NOT NULL CHECK (provider_kind IN ('custom-openai-compatible', 'deepseek', 'kimi', 'qwen', 'glm')),
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      protocol TEXT NOT NULL CHECK (protocol IN ('chat-completions', 'responses')),
      auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer-env', 'encrypted-project')),
      auth_environment_variable TEXT,
      auth_secret_id TEXT,
      capabilities_json TEXT NOT NULL,
      revision INTEGER NOT NULL,
      active INTEGER NOT NULL CHECK (active IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO provider_profiles_v8
      (id, name, provider_kind, base_url, model, protocol, auth_mode,
       auth_environment_variable, auth_secret_id, capabilities_json, revision,
       active, created_at, updated_at)
    SELECT id, name, provider_kind, base_url, model, protocol,
      CASE WHEN auth_mode = 'encrypted-sqlite' THEN 'none' ELSE auth_mode END,
      auth_environment_variable,
      CASE WHEN auth_mode = 'encrypted-sqlite' THEN NULL ELSE auth_secret_id END,
      capabilities_json,
      CASE WHEN auth_mode = 'encrypted-sqlite' THEN revision + 1 ELSE revision END,
      active, created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM provider_profiles;
    DROP INDEX IF EXISTS provider_profiles_one_active;
    DROP TABLE provider_profiles;
    ALTER TABLE provider_profiles_v8 RENAME TO provider_profiles;
    CREATE UNIQUE INDEX provider_profiles_one_active ON provider_profiles(active) WHERE active = 1;
  `);
  const violation = database.prepare("PRAGMA foreign_key_check").get();
  if (violation !== undefined) requiredRow(violation);
}
