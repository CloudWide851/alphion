import { execFile } from "node:child_process";
import type { AttachmentImportInput } from "../src/index.js";
import { AlphionError } from "../src/application/errors.js";

const WINDOWS_CLIPBOARD_SCRIPT = "Add-Type -AssemblyName System.Windows.Forms; $i=[Windows.Forms.Clipboard]::GetImage(); if($null -eq $i){exit 2}; $m=New-Object IO.MemoryStream; try{$i.Save($m,[Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($m.ToArray())} finally{$m.Dispose();$i.Dispose()}";

export function readClipboardImage(): Promise<AttachmentImportInput> {
  if (process.platform !== "win32") return Promise.reject(new AlphionError("dependency-unavailable", "当前终端不支持直接读取剪贴板图片；可拖入图片路径。", { stage: "attachment" }));
  return new Promise((resolve, reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLIPBOARD_SCRIPT], { windowsHide: true, timeout: 10_000, maxBuffer: 28 * 1024 * 1024 }, (error, stdout) => {
    if (error) { reject(new AlphionError("dependency-unavailable", "剪贴板中没有可读取的图片。", { stage: "attachment", cause: error })); return; }
    const bytes = Buffer.from(stdout.trim(), "base64");
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) { reject(new AlphionError("validation", "剪贴板图片为空或超过 20 MiB。", { stage: "attachment" })); return; }
    resolve(Object.freeze({ fileName: `clipboard-${Date.now()}.png`, bytes: Uint8Array.from(bytes) }));
  }));
}
