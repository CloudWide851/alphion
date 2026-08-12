const { app } = require("electron");

void app.whenReady().then(() => {
  const Database = require("better-sqlite3");
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
