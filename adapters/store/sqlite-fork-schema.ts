import type { SqliteDatabase } from "./database.js";
import { AlphionError } from "../../src/application/errors.js";
import { optionalRow, readString } from "./sqlite-codecs.js";

/** Adds immutable fork provenance and same-Session entry ancestry. */
export function createSessionForkSchemaV6(database: SqliteDatabase): void {
  assertExistingEntryOwnership(database);
  const sessionColumns = new Set(database.prepare("PRAGMA table_info('sessions')").all().map((value) => readString(value as Readonly<Record<string, unknown>>, "name")));
  for (const column of [
    "fork_source_session_id TEXT",
    "fork_source_entry_id TEXT",
    "fork_source_revision INTEGER",
    "fork_branch_digest TEXT",
    "forked_at TEXT",
  ]) if (!sessionColumns.has(column.split(" ")[0]!)) database.exec(`ALTER TABLE sessions ADD COLUMN ${column}`);
  database.exec(`
    DROP TRIGGER IF EXISTS sessions_current_leaf_insert;
    DROP TRIGGER IF EXISTS sessions_current_leaf_update;
    DROP TRIGGER IF EXISTS session_fork_identity_immutable;
    DROP TABLE IF EXISTS session_fork_entries;
    DROP TABLE IF EXISTS session_forks;
    DROP TABLE IF EXISTS session_entries_v5;
    ALTER TABLE session_entries RENAME TO session_entries_v5;
    CREATE TABLE session_entries (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT,
      timestamp TEXT NOT NULL,
      message_json TEXT NOT NULL,
      UNIQUE (session_id, id),
      FOREIGN KEY (session_id, parent_id) REFERENCES session_entries(session_id, id)
        DEFERRABLE INITIALLY DEFERRED
    );
    INSERT INTO session_entries (id, parent_id, session_id, run_id, timestamp, message_json)
      SELECT id, parent_id, session_id, run_id, timestamp, message_json FROM session_entries_v5;
    DROP TABLE session_entries_v5;
    CREATE INDEX session_entries_session ON session_entries(session_id, timestamp, id);
    CREATE TABLE session_forks (
      target_session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE RESTRICT,
      source_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE RESTRICT,
      source_entry_id TEXT,
      source_revision INTEGER NOT NULL,
      branch_digest TEXT NOT NULL,
      request_digest TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      forked_at TEXT NOT NULL
    );
    CREATE INDEX session_forks_source ON session_forks(source_session_id, forked_at, target_session_id);
    CREATE TABLE session_fork_entries (
      target_session_id TEXT NOT NULL REFERENCES session_forks(target_session_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      source_entry_id TEXT NOT NULL,
      target_entry_id TEXT NOT NULL,
      PRIMARY KEY (target_session_id, ordinal),
      UNIQUE (target_session_id, source_entry_id),
      UNIQUE (target_session_id, target_entry_id),
      FOREIGN KEY (target_session_id, target_entry_id) REFERENCES session_entries(session_id, id)
        DEFERRABLE INITIALLY DEFERRED
    );
    CREATE TRIGGER sessions_current_leaf_insert
    BEFORE INSERT ON sessions WHEN NEW.current_leaf_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_entries WHERE session_id = NEW.id AND id = NEW.current_leaf_id)
    BEGIN SELECT RAISE(ABORT, 'session-current-leaf-ownership'); END;
    CREATE TRIGGER sessions_current_leaf_update
    BEFORE UPDATE OF current_leaf_id ON sessions WHEN NEW.current_leaf_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM session_entries WHERE session_id = NEW.id AND id = NEW.current_leaf_id)
    BEGIN SELECT RAISE(ABORT, 'session-current-leaf-ownership'); END;
    CREATE TRIGGER session_fork_identity_immutable
    BEFORE UPDATE OF fork_source_session_id, fork_source_entry_id, fork_source_revision, fork_branch_digest, forked_at ON sessions
    WHEN OLD.fork_source_session_id IS NOT NULL
    BEGIN SELECT RAISE(ABORT, 'session-fork-identity-immutable'); END;
    PRAGMA user_version = 6;
  `);
}

function assertExistingEntryOwnership(database: SqliteDatabase): void {
  const crossParent = optionalRow(database.prepare(`
    SELECT child.id FROM session_entries child
    JOIN session_entries parent ON parent.id = child.parent_id
    WHERE child.session_id <> parent.session_id LIMIT 1
  `).get());
  if (crossParent) throw new AlphionError("integrity-failed", `Session entry ${readString(crossParent, "id")} has a cross-Session parent.`, { stage: "database" });
  const invalidLeaf = optionalRow(database.prepare(`
    SELECT sessions.id FROM sessions LEFT JOIN session_entries
      ON session_entries.id = sessions.current_leaf_id AND session_entries.session_id = sessions.id
    WHERE sessions.current_leaf_id IS NOT NULL AND session_entries.id IS NULL LIMIT 1
  `).get());
  if (invalidLeaf) throw new AlphionError("integrity-failed", `Session ${readString(invalidLeaf, "id")} has an invalid current leaf.`, { stage: "database" });
}
