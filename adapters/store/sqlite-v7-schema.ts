import type { SqliteDatabase } from "./database.js";

/** Creates the v7 credential, compaction, Goal, and scheduler authority tables. */
export function createRuntimeSchemaV7(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE device_vault_metadata (
      id INTEGER PRIMARY KEY CHECK (id = 1), schema_version INTEGER NOT NULL,
      key_id TEXT NOT NULL, wrapped_key_nonce BLOB NOT NULL,
      wrapped_key_ciphertext BLOB NOT NULL, wrapped_key_tag BLOB NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE device_vault_secrets (
      secret_id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
      revision INTEGER NOT NULL, nonce BLOB NOT NULL, ciphertext BLOB NOT NULL,
      auth_tag BLOB NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE vault_legacy_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      state TEXT NOT NULL CHECK (state IN ('none', 'legacy-disabled')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO vault_legacy_state (id, state, updated_at)
    VALUES (1, CASE WHEN EXISTS(SELECT 1 FROM vault_metadata WHERE id = 1)
      OR EXISTS(SELECT 1 FROM vault_secrets LIMIT 1)
      THEN 'legacy-disabled' ELSE 'none' END,
      strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));

    CREATE TABLE compaction_records (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT NOT NULL, created_at TEXT NOT NULL, digest TEXT NOT NULL,
      record_json TEXT NOT NULL, UNIQUE(session_id, run_id, digest)
    );
    CREATE INDEX compaction_records_session ON compaction_records(session_id, created_at DESC, id);

    CREATE TABLE goals (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain_id TEXT NOT NULL,
      session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id) ON DELETE RESTRICT,
      title TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'archived')),
      current_revision INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived_at TEXT
    );
    CREATE INDEX goals_project_status ON goals(project_id, status, updated_at DESC, id);
    CREATE TABLE goal_revisions (
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
      parent_revision INTEGER, actor TEXT NOT NULL CHECK (actor IN ('user', 'agent', 'restore')),
      revision_json TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT NOT NULL,
      command_key TEXT NOT NULL UNIQUE, PRIMARY KEY(goal_id, revision)
    );
    CREATE TABLE goal_commands (
      idempotency_key TEXT PRIMARY KEY, goal_id TEXT NOT NULL, request_digest TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );

    CREATE TABLE schedules (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, domain_id TEXT NOT NULL,
      title TEXT NOT NULL, expression_json TEXT NOT NULL, timezone TEXT NOT NULL,
      payload_json TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'completed')),
      revision INTEGER NOT NULL, next_run_at TEXT, last_run_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX schedules_due ON schedules(status, next_run_at, id);
    CREATE TABLE schedule_executions (
      id TEXT PRIMARY KEY, schedule_id TEXT NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
      due_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('claimed', 'running', 'queued', 'completed', 'failed', 'skipped')),
      lease_owner TEXT, lease_expires_at TEXT, run_id TEXT, missed_count INTEGER NOT NULL,
      reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(schedule_id, due_at)
    );
    CREATE INDEX schedule_executions_schedule ON schedule_executions(schedule_id, created_at DESC, id);
    CREATE TABLE schedule_commands (
      idempotency_key TEXT PRIMARY KEY, schedule_id TEXT NOT NULL, request_digest TEXT NOT NULL,
      result_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    PRAGMA user_version = 7;
  `);
}
