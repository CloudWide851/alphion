import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { openSqliteDatabase, type SqliteDatabase } from "./database.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import {
  assertDatabaseHealthy, decodeProviderProfile, logicalDatabaseDigest, optionalRow, readNumber,
  pathKey, readString, requiredRow, tableColumns, validateProviderProfile,
} from "./sqlite-codecs.js";
import { SQLITE_SCHEMA_VERSION, VAULT_AUTO_LOCK_MS } from "./sqlite-constants.js";

const OPEN_DATABASES = new Set<string>();
const DEFAULT_RUN_LEASE_MS = 2 * 60 * 1000;

export interface SqliteStoreOptions {
  readonly path: string;
  readonly domainId?: string;
  readonly projectId?: string;
  readonly vaultAutoLockMs?: number;
  readonly runLeaseMs?: number;
}

export abstract class SqliteStoreBase {
  protected readonly database: SqliteDatabase;
  protected readonly databaseKey: string;
  protected readonly databasePath: string;
  protected readonly ownerId = createId("store");
  protected readonly runLeaseMs: number;
  protected readonly domainId: string;
  protected readonly projectId: string | undefined;
  protected leaseHeartbeat: NodeJS.Timeout | undefined;
  protected closed = false;
  protected vaultKey: Buffer | undefined;
  protected vaultLastActivity = 0;
  protected vaultLockTimer: NodeJS.Timeout | undefined;
  protected readonly vaultAutoLockMs: number;


  abstract lock(): void;

  constructor(options: SqliteStoreOptions) {
    const databasePath = resolve(options.path);
    this.databasePath = databasePath;
    this.databaseKey = pathKey(databasePath);
    this.domainId = options.domainId ?? `domain_${sha256(pathKey(databasePath)).slice(0, 32)}`;
    this.projectId = options.projectId;
    this.vaultAutoLockMs = options.vaultAutoLockMs ?? VAULT_AUTO_LOCK_MS;
    this.runLeaseMs = options.runLeaseMs ?? DEFAULT_RUN_LEASE_MS;
    if (!Number.isSafeInteger(this.vaultAutoLockMs) || this.vaultAutoLockMs <= 0) {
      throw new AlphionError("validation", "Vault auto-lock duration must be a positive safe integer.", { stage: "vault" });
    }
    if (!Number.isSafeInteger(this.runLeaseMs) || this.runLeaseMs < 1_000 || this.runLeaseMs > 24 * 60 * 60 * 1000) {
      throw new AlphionError("validation", "Run lease duration must be between one second and 24 hours.", { stage: "session" });
    }
    if (OPEN_DATABASES.has(this.databaseKey)) {
      throw new AlphionError("conflict", "This process already has a writer open for the SQLite state file.", {
        stage: "database",
      });
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    let database: SqliteDatabase | undefined;
    OPEN_DATABASES.add(this.databaseKey);
    try {
      database = openSqliteDatabase(databasePath);
      this.database = database;
      this.database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      this.assertIntegrity();
      this.migrate();
      this.reconcileSessionSchemaV5();
      this.registerOwnerAndRecover();
      this.leaseHeartbeat = setInterval(() => this.heartbeatOwner(), Math.max(500, Math.floor(this.runLeaseMs / 3)));
      this.leaseHeartbeat.unref();
    } catch (error) {
      database?.close();
      OPEN_DATABASES.delete(this.databaseKey);
      if (error instanceof AlphionError) throw error;
      throw new AlphionError("integrity-failed", "SQLite state could not be opened or validated.", {
        stage: "database",
        cause: error,
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.leaseHeartbeat) clearInterval(this.leaseHeartbeat);
    this.leaseHeartbeat = undefined;
    try { this.retireOwner(); } catch { /* Closing still releases the local handle. Expiry remains the crash fallback. */ }
    try { this.database.exec("PRAGMA wal_checkpoint(PASSIVE)"); } catch { /* Checkpoint is maintenance-only; close still releases the handle. */ }
    this.lock();
    this.database.close();
    OPEN_DATABASES.delete(this.databaseKey);
  }


  protected migrate(): void {
    const row = requiredRow(this.database.prepare("PRAGMA user_version").get());
    const current = readNumber(row, "user_version");
    if (current > SQLITE_SCHEMA_VERSION) {
      throw new AlphionError("incompatible-schema", `SQLite schema ${current} is newer than supported ${SQLITE_SCHEMA_VERSION}.`, {
        stage: "database",
      });
    }
    if (current === SQLITE_SCHEMA_VERSION) return;
    if (current === 0) {
      this.transaction(() => {
        this.createSchemaV2();
        this.createSessionSchemaV3();
        this.createShapeSchemaV4(false);
        this.createProjectSessionSchemaV5();
      });
      return;
    }
    if (current === 2) {
      this.backupV2();
      this.transaction(() => { this.createSessionSchemaV3(); this.createShapeSchemaV4(false); this.createProjectSessionSchemaV5(); });
      return;
    }
    if (current === 3) {
      this.backupV3();
      this.transaction(() => { this.createShapeSchemaV4(true); this.createProjectSessionSchemaV5(); });
      return;
    }
    if (current === 4) {
      this.backupSchema(4, `${this.databasePath}.v4-backup`);
      this.transaction(() => this.createProjectSessionSchemaV5());
      return;
    }
    if (current !== 1) {
      throw new AlphionError("incompatible-schema", `SQLite schema ${current} cannot be migrated.`, { stage: "database" });
    }
    this.transaction(() => {
      this.database.exec(`
        DROP INDEX provider_profiles_one_active;
        ALTER TABLE provider_profiles RENAME TO provider_profiles_v1;
      `);
      this.createProviderProfilesV2();
      const rows = this.database.prepare("SELECT * FROM provider_profiles_v1 ORDER BY id").all().map(requiredRow);
      const insert = this.database.prepare(
        `INSERT INTO provider_profiles
         (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
         VALUES (?, ?, 'custom-openai-compatible', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const capabilities = parseRecord(readString(row, "capabilities_json"));
        insert.run(
          readString(row, "id"),
          readString(row, "name"),
          readString(row, "base_url"),
          readString(row, "model"),
          readString(row, "protocol"),
          readString(row, "auth_mode"),
          readNullableString(row, "auth_environment_variable") ?? null,
          JSON.stringify({
            streaming: readBoolean(capabilities, "streaming"),
            tools: readBoolean(capabilities, "tools"),
            promptCaching: readBoolean(capabilities, "promptCaching"),
            reasoning: false,
          }),
          readNumber(row, "revision"),
          readNumber(row, "active"),
          readString(row, "created_at"),
          readString(row, "updated_at"),
        );
      }
      this.database.exec("DROP TABLE provider_profiles_v1");
      this.createVaultTables();
      this.database.exec("PRAGMA user_version = 2");
      this.createSessionSchemaV3();
      this.createShapeSchemaV4(false);
      this.createProjectSessionSchemaV5();
    });
  }

  protected createSchemaV2(): void {
    this.createProviderProfilesV2();
    this.database.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          causation_id TEXT,
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_digest TEXT NOT NULL,
          digest TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
        CREATE TABLE cache_entries (
          namespace TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          value_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          provenance TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          hit_count INTEGER NOT NULL,
          last_accessed_at TEXT NOT NULL,
          PRIMARY KEY (namespace, cache_key)
        );
        CREATE INDEX cache_entries_lru ON cache_entries(last_accessed_at);
        CREATE TABLE cache_metrics (id INTEGER PRIMARY KEY CHECK (id = 1), hits INTEGER NOT NULL, misses INTEGER NOT NULL);
        INSERT INTO cache_metrics (id, hits, misses) VALUES (1, 0, 0);
        CREATE TABLE shell_rules (
          id TEXT PRIMARY KEY,
          executable_path TEXT NOT NULL,
          executable_key TEXT NOT NULL,
          executable_digest TEXT,
          argument_prefix_json TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL
        );
        CREATE INDEX shell_rules_lookup ON shell_rules(executable_key, enabled);
    `);
    this.createVaultTables();
    this.database.exec("PRAGMA user_version = 2");
  }

  protected backupV2(): void {
    if (this.databasePath === ":memory:") return;
    const backupPath = `${this.databasePath}.v2-backup`;
    const sourceDigest = logicalDatabaseDigest(this.database);
    if (existsSync(backupPath)) {
      const existing = openSqliteDatabase(backupPath, { readOnly: true });
      try {
        assertDatabaseHealthy(existing, "Existing v2 backup failed its integrity check.");
        const row = requiredRow(existing.prepare("PRAGMA user_version").get());
        if (readNumber(row, "user_version") !== 2) throw new AlphionError("conflict", "Existing v2 backup is not a schema-v2 database.", { stage: "database" });
        if (logicalDatabaseDigest(existing) !== sourceDigest) throw new AlphionError("conflict", "Existing v2 backup does not match the database being migrated.", { stage: "database" });
      } finally {
        existing.close();
      }
      return;
    }
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    this.database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    const backup = openSqliteDatabase(backupPath, { readOnly: true });
    try {
      assertDatabaseHealthy(backup, "Created v2 backup failed its integrity check.");
      const version = readNumber(requiredRow(backup.prepare("PRAGMA user_version").get()), "user_version");
      if (version !== 2 || logicalDatabaseDigest(backup) !== sourceDigest) throw new AlphionError("integrity-failed", "Created v2 backup is not a recoverable logical snapshot.", { stage: "database" });
    } finally { backup.close(); }
  }

  protected backupV3(): void { this.backupSchema(3, `${this.databasePath}.v3-backup`); }

  protected backupSchema(version: number, backupPath: string): void {
    if (this.databasePath === ":memory:") return;
    const sourceDigest = logicalDatabaseDigest(this.database);
    if (existsSync(backupPath)) {
      const existing = openSqliteDatabase(backupPath, { readOnly: true });
      try {
        assertDatabaseHealthy(existing, `Existing v${version} backup failed its integrity check.`);
        if (readNumber(requiredRow(existing.prepare("PRAGMA user_version").get()), "user_version") !== version || logicalDatabaseDigest(existing) !== sourceDigest) throw new AlphionError("conflict", `Existing v${version} backup does not match the database being migrated.`, { stage: "database" });
      } finally { existing.close(); }
      return;
    }
    this.database.exec("PRAGMA wal_checkpoint(FULL)");
    this.database.exec(`VACUUM INTO '${backupPath.replaceAll("'", "''")}'`);
    const backup = openSqliteDatabase(backupPath, { readOnly: true });
    try {
      assertDatabaseHealthy(backup, `Created v${version} backup failed its integrity check.`);
      if (readNumber(requiredRow(backup.prepare("PRAGMA user_version").get()), "user_version") !== version || logicalDatabaseDigest(backup) !== sourceDigest) throw new AlphionError("integrity-failed", `Created v${version} backup is not a recoverable snapshot.`, { stage: "database" });
    } finally { backup.close(); }
  }

  protected createSessionSchemaV3(): void {
    this.database.exec(`
      ALTER TABLE events ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE events ADD COLUMN session_sequence INTEGER;
      CREATE UNIQUE INDEX events_session_sequence ON events(session_id, session_sequence) WHERE session_sequence IS NOT NULL;
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        current_leaf_id TEXT,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'legacy-audit')),
        active_run_id TEXT,
        lease_owner TEXT,
        lease_expires_at TEXT,
        provider_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        audit_only INTEGER NOT NULL CHECK (audit_only IN (0, 1))
      );
      CREATE TABLE session_entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT REFERENCES session_entries(id),
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        run_id TEXT,
        timestamp TEXT NOT NULL,
        message_json TEXT NOT NULL
      );
      CREATE INDEX session_entries_session ON session_entries(session_id, timestamp, id);
      CREATE TABLE pending_messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('steer', 'follow-up')),
        message_json TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        claimed_run_id TEXT
        ,claimed_at TEXT
        ,claim_owner TEXT
      );
      CREATE INDEX pending_messages_fifo ON pending_messages(session_id, kind, created_at, id);
      CREATE TABLE session_commands (
        idempotency_key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE session_owners (
        owner_id TEXT PRIMARY KEY,
        expires_at TEXT NOT NULL
      );
      INSERT INTO sessions (id, title, current_leaf_id, revision, status, active_run_id, provider_id, created_at, updated_at, audit_only)
      SELECT DISTINCT session_id, '旧版审计 ' || substr(session_id, 1, 12), NULL, 0, 'legacy-audit', NULL, NULL,
        MIN(timestamp), MAX(timestamp), 1 FROM events GROUP BY session_id;
      PRAGMA user_version = 3;
    `);
  }

  protected createShapeSchemaV4(migratingV3: boolean): void {
    this.database.exec(`
      ALTER TABLE sessions ADD COLUMN shape_status TEXT NOT NULL DEFAULT '${migratingV3 ? "legacy-unshaped" : "unshaped"}' CHECK (shape_status IN ('unshaped', 'shaped', 'legacy-unshaped'));
      ALTER TABLE sessions ADD COLUMN shape_revision INTEGER;
      ALTER TABLE sessions ADD COLUMN shape_digest TEXT;
      ALTER TABLE runs ADD COLUMN shape_revision INTEGER;
      ALTER TABLE runs ADD COLUMN shape_digest TEXT;
      CREATE TABLE session_shapes (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        shape_revision INTEGER NOT NULL,
        shape_digest TEXT NOT NULL,
        shape_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        command_key TEXT NOT NULL UNIQUE,
        PRIMARY KEY (session_id, shape_revision),
        UNIQUE (session_id, shape_digest)
      );
      CREATE INDEX session_shapes_digest ON session_shapes(shape_digest);
      UPDATE sessions SET shape_status = 'legacy-unshaped' WHERE audit_only = 1;
      PRAGMA user_version = 4;
    `);
  }

  protected createProjectSessionSchemaV5(): void {
    this.migrateProviderProfilesV5();
    const sessionColumns = tableColumns(this.database, "sessions");
    if (!sessionColumns.has("domain_id")) this.database.exec("ALTER TABLE sessions ADD COLUMN domain_id TEXT");
    if (!sessionColumns.has("project_id")) this.database.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
    this.database.prepare("UPDATE sessions SET domain_id = ? WHERE domain_id IS NULL").run(this.domainId);
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS sessions_domain ON sessions(domain_id, updated_at, id);
      CREATE TABLE IF NOT EXISTS collaboration_messages (
        message_id TEXT PRIMARY KEY,
        source_session_id TEXT NOT NULL REFERENCES sessions(id),
        source_run_id TEXT NOT NULL,
        target_session_id TEXT NOT NULL REFERENCES sessions(id),
        target_revision INTEGER NOT NULL,
        domain_id TEXT NOT NULL,
        shape_digest TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        hop INTEGER NOT NULL CHECK (hop BETWEEN 1 AND 8),
        delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'follow-up')),
        content_digest TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS collaboration_target ON collaboration_messages(target_session_id, created_at, message_id);
      CREATE TABLE IF NOT EXISTS collaboration_run_budgets (
        source_run_id TEXT PRIMARY KEY,
        sent_count INTEGER NOT NULL CHECK (sent_count BETWEEN 0 AND 4)
      );
      PRAGMA user_version = 5;
    `);
  }

  protected migrateProviderProfilesV5(): void {
    const schemaRow = optionalRow(this.database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'provider_profiles'").get());
    const sql = schemaRow ? readString(schemaRow, "sql") : "";
    if (sql.includes("custom-openai-compatible") && sql.includes("kimi") && sql.includes("qwen") && sql.includes("glm")) return;
    this.database.exec(`
      DROP INDEX IF EXISTS provider_profiles_one_active;
      ALTER TABLE vault_secrets RENAME TO vault_secrets_v4;
      ALTER TABLE provider_profiles RENAME TO provider_profiles_v4;
    `);
    this.createProviderProfilesV2();
    const rows = this.database.prepare("SELECT * FROM provider_profiles_v4 ORDER BY id").all().map(requiredRow);
    const insert = this.database.prepare(`INSERT INTO provider_profiles
      (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const row of rows) {
      const previousKind = readString(row, "provider_kind");
      const previousUrl = readString(row, "base_url").replace(/\/$/u, "");
      const deepSeekOfficial = previousKind === "deepseek" && previousUrl === "https://api.deepseek.com";
      insert.run(
        readString(row, "id"), readString(row, "name"),
        deepSeekOfficial ? "deepseek" : "custom-openai-compatible",
        deepSeekOfficial ? "deepseek" : previousUrl,
        readString(row, "model"), readString(row, "protocol"), readString(row, "auth_mode"),
        readNullableString(row, "auth_environment_variable") ?? null, readNullableString(row, "auth_secret_id") ?? null,
        readString(row, "capabilities_json"), readNumber(row, "revision"), readNumber(row, "active"),
        readString(row, "created_at"), readString(row, "updated_at"),
      );
    }
    this.database.exec(`
      CREATE TABLE vault_secrets (
        secret_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO vault_secrets SELECT * FROM vault_secrets_v4;
      DROP TABLE vault_secrets_v4;
      DROP TABLE provider_profiles_v4;
    `);
  }

  protected reconcileSessionSchemaV5(): void {
    const sessionColumns = tableColumns(this.database, "sessions");
    const pendingColumns = tableColumns(this.database, "pending_messages");
    this.transaction(() => {
      this.migrateProviderProfilesV5();
      if (!sessionColumns.has("lease_owner")) this.database.exec("ALTER TABLE sessions ADD COLUMN lease_owner TEXT");
      if (!sessionColumns.has("lease_expires_at")) this.database.exec("ALTER TABLE sessions ADD COLUMN lease_expires_at TEXT");
      if (!pendingColumns.has("claimed_at")) this.database.exec("ALTER TABLE pending_messages ADD COLUMN claimed_at TEXT");
      if (!pendingColumns.has("claim_owner")) this.database.exec("ALTER TABLE pending_messages ADD COLUMN claim_owner TEXT");
      this.database.exec("CREATE TABLE IF NOT EXISTS session_owners (owner_id TEXT PRIMARY KEY, expires_at TEXT NOT NULL)");
      if (!sessionColumns.has("domain_id")) this.database.exec("ALTER TABLE sessions ADD COLUMN domain_id TEXT");
      if (!sessionColumns.has("project_id")) this.database.exec("ALTER TABLE sessions ADD COLUMN project_id TEXT");
      this.database.prepare("UPDATE sessions SET domain_id = ? WHERE domain_id IS NULL").run(this.domainId);
    });
  }

  protected registerOwnerAndRecover(): void {
    this.transaction(() => {
      const expiresAt = new Date(Date.now() + this.runLeaseMs).toISOString();
      this.database.prepare("INSERT INTO session_owners (owner_id, expires_at) VALUES (?, ?) ON CONFLICT(owner_id) DO UPDATE SET expires_at = excluded.expires_at").run(this.ownerId, expiresAt);
      this.recoverExpiredLeases();
    });
  }

  protected heartbeatOwner(): void {
    if (this.closed) return;
    try {
      this.transaction(() => {
        const expiresAt = new Date(Date.now() + this.runLeaseMs).toISOString();
        this.database.prepare("UPDATE session_owners SET expires_at = ? WHERE owner_id = ?").run(expiresAt, this.ownerId);
        this.database.prepare("UPDATE sessions SET lease_expires_at = ? WHERE lease_owner = ? AND status = 'running'").run(expiresAt, this.ownerId);
      });
    } catch { /* A busy peer cannot make an existing bounded lease immortal. */ }
  }

  protected retireOwner(): void {
    this.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare("UPDATE pending_messages SET claimed_run_id = NULL, claimed_at = NULL, claim_owner = NULL WHERE claim_owner = ?").run(this.ownerId);
      this.database.prepare("UPDATE sessions SET status = 'idle', active_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL, revision = revision + 1, updated_at = ? WHERE lease_owner = ? AND status = 'running'").run(now, this.ownerId);
      this.database.prepare("DELETE FROM session_owners WHERE owner_id = ?").run(this.ownerId);
    });
  }

  protected recoverExpiredLeases(): void {
    const now = new Date().toISOString();
    this.database.prepare("DELETE FROM session_owners WHERE expires_at <= ?").run(now);
    this.database.prepare(`
      UPDATE sessions SET status = 'idle', active_run_id = NULL, lease_owner = NULL, lease_expires_at = NULL,
        revision = revision + 1, updated_at = ?
      WHERE status = 'running' AND (
        active_run_id IS NULL OR lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ? OR
        lease_owner NOT IN (SELECT owner_id FROM session_owners)
      )
    `).run(now, now);
    this.database.prepare(`
      UPDATE pending_messages SET claimed_run_id = NULL, claimed_at = NULL, claim_owner = NULL
      WHERE claimed_run_id IS NOT NULL AND (
        claimed_at IS NULL OR claim_owner IS NULL OR
        claim_owner NOT IN (SELECT owner_id FROM session_owners) OR
        NOT EXISTS (SELECT 1 FROM sessions WHERE sessions.id = pending_messages.session_id AND sessions.active_run_id = pending_messages.claimed_run_id AND sessions.status = 'running')
      )
    `).run();
  }

  protected createProviderProfilesV2(): void {
    this.database.exec(`
        CREATE TABLE provider_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          provider_kind TEXT NOT NULL CHECK (provider_kind IN ('custom-openai-compatible', 'deepseek', 'kimi', 'qwen', 'glm')),
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK (protocol IN ('chat-completions', 'responses')),
          auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer-env', 'encrypted-sqlite')),
          auth_environment_variable TEXT,
          auth_secret_id TEXT,
          capabilities_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX provider_profiles_one_active ON provider_profiles(active) WHERE active = 1;
    `);
  }

  protected createVaultTables(): void {
    this.database.exec(`
      CREATE TABLE vault_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        kdf TEXT NOT NULL,
        salt BLOB NOT NULL,
        work_factor INTEGER NOT NULL,
        block_size INTEGER NOT NULL,
        parallelism INTEGER NOT NULL,
        verifier_nonce BLOB NOT NULL,
        verifier_ciphertext BLOB NOT NULL,
        verifier_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE vault_secrets (
        secret_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }


  protected assertIntegrity(): void {
    const rows = this.database.prepare("PRAGMA quick_check").all();
    const valid = rows.length === 1 && Object.values(requiredRow(rows[0]))[0] === "ok";
    if (!valid) {
      throw new AlphionError("integrity-failed", "SQLite quick integrity check failed.", { stage: "database" });
    }
  }

  protected transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

}
