import { createRequire } from "node:module";
import type BetterSqlite3 from "better-sqlite3";
import { AlphionError } from "../../src/application/errors.js";

export type SqliteDatabase = BetterSqlite3.Database;
type SqliteConstructor = new (path: string, options?: Readonly<{ readonly?: boolean; fileMustExist?: boolean }>) => SqliteDatabase;

const require = createRequire(import.meta.url);
let sqliteConstructor: SqliteConstructor | undefined;

export function probeSqliteDriver(): void { void loadSqliteDriver(); }

export function normalizeSqliteDriverError(error: unknown): AlphionError {
  const message = error instanceof Error ? error.message : "";
  const abiMismatch = /NODE_MODULE_VERSION|compiled against a different Node\.js version|was compiled against/iu.test(message);
  return new AlphionError(
    "dependency-unavailable",
    abiMismatch
      ? "SQLite native dependency is incompatible with this runtime (native-abi-mismatch)."
      : "SQLite native dependency is unavailable (native-driver-unavailable).",
    { stage: "database", cause: error },
  );
}

/** Keep the native driver private to the SQLite adapter boundary. */
export function openSqliteDatabase(path: string, options: Readonly<{ readOnly?: boolean }> = {}): SqliteDatabase {
  const Database = loadSqliteDriver();
  return new Database(path, {
    readonly: options.readOnly === true,
    fileMustExist: options.readOnly === true,
  });
}

function loadSqliteDriver(): SqliteConstructor {
  if (sqliteConstructor) return sqliteConstructor;
  try {
    sqliteConstructor = require("better-sqlite3") as SqliteConstructor;
    return sqliteConstructor;
  } catch (error) {
    throw normalizeSqliteDriverError(error);
  }
}
