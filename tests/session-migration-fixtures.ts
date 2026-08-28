import type { SqliteDatabase } from "../adapters/store/database.js";

/** Reconstructs the historical v2 shape before exercising the full migration chain. */
export function downgradeSessionSchemaFixtureToV2(database: SqliteDatabase): void {
  database.exec([
    "DROP TABLE message_attachments",
    "DROP TABLE attachments",
    "ALTER TABLE provider_profiles DROP COLUMN context_window_tokens",
    "DROP TABLE schedule_commands",
    "DROP TABLE schedule_executions",
    "DROP TABLE schedules",
    "DROP TABLE goal_commands",
    "DROP TABLE goal_revisions",
    "DROP TABLE goals",
    "DROP TABLE compaction_records",
    "DROP TABLE project_credential_migrations",
    "DROP TABLE project_credentials",
    "DROP TABLE vault_legacy_state",
    "DROP TABLE device_vault_secrets",
    "DROP TABLE device_vault_metadata",
    "DROP TABLE session_shapes",
    "DROP TABLE session_commands",
    "DROP TABLE pending_messages",
    "DROP TABLE session_entries",
    "DROP TABLE sessions",
    "DROP TABLE session_owners",
    "DROP INDEX events_session_sequence",
    "ALTER TABLE events DROP COLUMN session_sequence",
    "ALTER TABLE events DROP COLUMN schema_version",
    "ALTER TABLE runs DROP COLUMN shape_revision",
    "ALTER TABLE runs DROP COLUMN shape_digest",
    "CREATE TABLE backup_fixture (value TEXT NOT NULL)",
    "INSERT INTO backup_fixture VALUES ('wal-visible')",
    "PRAGMA user_version = 2",
  ].join("; "));
}
