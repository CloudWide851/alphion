import { openSqliteDatabase } from "../dist/adapters/store/database.js";

const database = openSqliteDatabase(":memory:");
try {
  const result = database.prepare("select 1 as value").get();
  if (result?.value !== 1) throw new Error("Unexpected SQLite result.");
  process.stdout.write(`node-sqlite-abi-ok abi=${process.versions.modules}\n`);
} finally {
  database.close();
}
