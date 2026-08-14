const { app, BrowserWindow } = require("electron");
const { mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { resolve } = require("node:path");

const root = process.cwd();
const sourcePath = resolve(root, "alphion-icon.svg");
const assetRoot = resolve(root, "assets");
const webRoot = resolve(root, "webui", "client", "public");
const sizes = Object.freeze([16, 24, 32, 48, 64, 128, 256]);

app.disableHardwareAcceleration();
void app.whenReady().then(async () => {
  const source = readFileSync(sourcePath);
  const svg = source.toString("utf8");
  if (!/<svg\b/u.test(svg) || !/#A377F6/iu.test(svg)) throw new Error("Canonical Alphion icon SVG is invalid.");
  const rasterSvg = svg.replace("<svg ", '<svg width="256" height="256" ');
  const window = new BrowserWindow({ width: 256, height: 256, show: false, frame: false, transparent: true, webPreferences: { offscreen: true, sandbox: true, nodeIntegration: false } });
  await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<style>html,body{margin:0;width:256px;height:256px;background:transparent;overflow:hidden}svg{display:block}</style>${rasterSvg}`)}`);
  const image = await window.webContents.capturePage({ x: 0, y: 0, width: 256, height: 256 });
  window.destroy();
  if (image.isEmpty()) throw new Error("Electron could not rasterize the canonical Alphion icon.");
  const pngs = sizes.map((size) => Object.freeze({ size, data: image.resize({ width: size, height: size, quality: "best" }).toPNG() }));
  mkdirSync(assetRoot, { recursive: true });
  mkdirSync(webRoot, { recursive: true });
  writeFileSync(resolve(assetRoot, "alphion.png"), pngs.at(-1).data);
  writeFileSync(resolve(assetRoot, "alphion.ico"), encodeIco(pngs));
  writeFileSync(resolve(webRoot, "alphion-icon.svg"), source);
  writeFileSync(resolve(webRoot, "favicon.svg"), source);
  writeFileSync(resolve(webRoot, "favicon-32.png"), pngs.find((item) => item.size === 32).data);
  writeFileSync(resolve(webRoot, "alphion-icon-192.png"), image.resize({ width: 192, height: 192, quality: "best" }).toPNG());
  process.stdout.write(`generated Alphion brand assets from ${sourcePath}\n`);
}).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; }).finally(() => app.quit());

function encodeIco(images) {
  const headerBytes = 6 + images.length * 16;
  const header = Buffer.alloc(headerBytes);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = headerBytes;
  images.forEach(({ size, data }, index) => {
    const entry = 6 + index * 16;
    header.writeUInt8(size === 256 ? 0 : size, entry);
    header.writeUInt8(size === 256 ? 0 : size, entry + 1);
    header.writeUInt8(0, entry + 2);
    header.writeUInt8(0, entry + 3);
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...images.map((item) => item.data)]);
}
