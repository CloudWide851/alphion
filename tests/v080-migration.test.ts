import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { diagnoseLocalProject } from "../adapters/local/local-application.js";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";

test("SQLite v6 migration creates a verified adjacent backup and upgrades to v7", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "migration.sqlite3");
    createV6(path);
    const store = new SqliteStore({ path, projectId: "project_migration", domainId: "domain_migration" });
    store.close();
    assert.equal(version(path), 7);
    assert.equal(version(`${path}.v6-backup`), 6);
    const database = openSqliteDatabase(path, { readOnly: true });
    try {
      for (const table of ["device_vault_metadata", "compaction_records", "goals", "goal_revisions", "schedules", "schedule_executions"]) {
        assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { count: number }).count, 1);
      }
      assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
    } finally { database.close(); }
  });
});

test("v7 migration failure rolls back the live v6 database and retains its backup", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "rollback.sqlite3");
    createV6(path, true);
    assert.throws(() => new SqliteStore({ path, projectId: "project_rollback", domainId: "domain_rollback" }), /opened or validated|already exists/iu);
    assert.equal(version(path), 6);
    assert.equal(version(`${path}.v6-backup`), 6);
    const database = openSqliteDatabase(path, { readOnly: true });
    try {
      assert.equal(tableExists(database, "device_vault_metadata"), false);
      assert.equal(tableExists(database, "goals"), true);
      assert.equal((database.prepare("PRAGMA quick_check").get() as { quick_check: string }).quick_check, "ok");
    } finally { database.close(); }
  });
});

test("doctor reports v6 as pending without migrating and future schema fails closed", async () => {
  await temporary(async (directory) => {
    const path = join(directory, "doctor-v6.sqlite3");
    createV6(path);
    const report = await diagnoseLocalProject({ projectRoot: directory, statePath: path });
    assert.ok(report.checks.some((item) => item.id === "sqlite" && item.status === "warning" && /schema 6/u.test(item.summary)));
    assert.equal(version(path), 6);
    await assert.rejects(access(`${path}.v6-backup`));

    const database = openSqliteDatabase(path); database.exec("PRAGMA user_version = 8"); database.close();
    assert.throws(() => new SqliteStore({ path }), (error) => error instanceof Error && "code" in error && error.code === "incompatible-schema");
    assert.equal(version(path), 8);
  });
});

function createV6(path: string, conflictingGoalTable = false): void {
  const store = new SqliteStore({ path, projectId: "project_fixture", domainId: "domain_fixture" });
  store.close();
  const database = openSqliteDatabase(path);
  try {
    database.exec(`
      DROP TABLE schedule_commands; DROP TABLE schedule_executions; DROP TABLE schedules;
      DROP TABLE goal_commands; DROP TABLE goal_revisions; DROP TABLE goals;
      DROP TABLE compaction_records; DROP TABLE vault_legacy_state;
      DROP TABLE device_vault_secrets; DROP TABLE device_vault_metadata;
      PRAGMA user_version = 6;
    `);
    if (conflictingGoalTable) database.exec("CREATE TABLE goals (invalid TEXT)");
  } finally { database.close(); }
}

function version(path: string): number {
  const database = openSqliteDatabase(path, { readOnly: true });
  try { return (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version; }
  finally { database.close(); }
}

function tableExists(database: ReturnType<typeof openSqliteDatabase>, table: string): boolean {
  return (database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { count: number }).count === 1;
}

async function temporary(operation: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v080-migration-"));
  try { await operation(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}
