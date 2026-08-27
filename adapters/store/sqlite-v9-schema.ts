import type { SqliteDatabase } from "./database.js";

/** Adds explicit model context overrides and content-addressed image metadata. */
export function createMultimodalSchemaV9(database: SqliteDatabase): void {
  database.exec(`
    ALTER TABLE provider_profiles ADD COLUMN context_window_tokens INTEGER
      CHECK (context_window_tokens IS NULL OR context_window_tokens BETWEEN 4096 AND 4194304);
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY,
      domain_id TEXT NOT NULL,
      project_id TEXT,
      sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
      media_type TEXT NOT NULL CHECK (media_type IN ('image/png','image/jpeg','image/webp','image/gif')),
      byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 20971520),
      width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 32768),
      height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 32768),
      file_name TEXT NOT NULL,
      storage_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      referenced_at TEXT,
      UNIQUE(domain_id, sha256)
    );
    CREATE INDEX attachments_cleanup ON attachments(referenced_at, created_at);
    CREATE TABLE message_attachments (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL,
      attachment_id TEXT NOT NULL REFERENCES attachments(id),
      position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 7),
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, message_id, position),
      UNIQUE (session_id, message_id, attachment_id)
    );
    CREATE INDEX message_attachments_attachment ON message_attachments(attachment_id, session_id);
    PRAGMA user_version = 9;
  `);
}
