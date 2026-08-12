const { app } = require("electron");
const { createRequire } = require("node:module");
const { resolve } = require("node:path");

const runtimeRoot = resolve(process.env.ALPHION_DESKTOP_RUNTIME || ".desktop-runtime");
const runtimeRequire = createRequire(resolve(runtimeRoot, "package.json"));

void app.whenReady().then(() => {
  const Database = runtimeRequire("better-sqlite3");
  const database = new Database(":memory:");
  try {
    const result = database.prepare("select 1 as value").get();
    if (result?.value !== 1) throw new Error("Unexpected SQLite result.");
    process.stdout.write("electron-sqlite-abi-ok\n");
  } finally {
    database.close();
    app.quit();
  }
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Electron ABI smoke failed."}\n`);
  app.exit(1);
});
