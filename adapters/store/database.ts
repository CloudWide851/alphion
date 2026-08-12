import BetterSqlite3 from "better-sqlite3";

export type SqliteDatabase = BetterSqlite3.Database;

/** Keep the native driver private to the SQLite adapter boundary. */
export function openSqliteDatabase(path: string, options: Readonly<{ readOnly?: boolean }> = {}): SqliteDatabase {
  return new BetterSqlite3(path, {
    readonly: options.readOnly === true,
    fileMustExist: options.readOnly === true,
  });
}
