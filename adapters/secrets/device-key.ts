import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AlphionError } from "../../src/application/errors.js";
import type { DeviceKeyProvider } from "../../src/ports/index.js";
import { defaultProjectRegistryPath } from "../project/project-manager.js";

const DEVICE_KEY_BYTES = 32;
const execFileAsync = promisify(execFile);

export class FileDeviceKeyProvider implements DeviceKeyProvider {
  readonly #path: string;
  #writeTail: Promise<void> = Promise.resolve();

  constructor(path = defaultDeviceKeyPath()) { this.#path = path; }

  async load(): Promise<Uint8Array | undefined> {
    try { return validateDeviceKey(await readFile(this.#path)); }
    catch (error) {
      if (isMissing(error)) return undefined;
      if (error instanceof AlphionError) throw error;
      throw unavailable(error);
    }
  }

  async loadOrCreate(): Promise<Uint8Array> {
    const present = await this.load();
    if (present) return present;
    let result: Uint8Array | undefined;
    let failure: unknown;
    const operation = this.#writeTail.then(async () => {
      try { result = await this.load() ?? await createDeviceKey(this.#path); }
      catch (error) { failure = error; }
    });
    this.#writeTail = operation;
    await operation;
    if (failure) throw failure;
    if (!result) throw unavailable(new Error("Device key creation did not return a key."));
    return result;
  }
}

export function defaultDeviceKeyPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultProjectRegistryPath(environment)), "device.key");
}

async function createDeviceKey(path: string): Promise<Uint8Array> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}`;
  const key = randomBytes(DEVICE_KEY_BYTES);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(key); await handle.sync(); }
    finally { await handle.close(); }
    await restrictAccess(temporary);
    try { await link(temporary, path); }
    catch (error) {
      if (!isExists(error)) throw error;
    }
    await unlink(temporary).catch(() => undefined);
    const stored = await readFile(path);
    return validateDeviceKey(stored);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error instanceof AlphionError ? error : unavailable(error);
  } finally { key.fill(0); }
}

async function restrictAccess(path: string): Promise<void> {
  await chmod(path, 0o600);
  if (process.platform !== "win32") return;
  try {
    const resolved = await execFileAsync("whoami", [], { windowsHide: true });
    const principal = resolved.stdout.trim() || windowsPrincipal();
    await execFileAsync("icacls", [path, "/inheritance:r", "/grant:r", `${principal}:(F)`], { windowsHide: true });
  } catch (error) {
    throw new AlphionError("dependency-unavailable", "Device credential key permissions could not be restricted.", { stage: "vault", reason: "device-key-permission-failed", cause: error });
  }
}

function windowsPrincipal(): string {
  const username = process.env.USERNAME?.trim() || userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function validateDeviceKey(value: Uint8Array): Uint8Array {
  if (value.byteLength !== DEVICE_KEY_BYTES) throw new AlphionError("integrity-failed", "Device credential key has an invalid length.", { stage: "vault", reason: "device-key-corrupt" });
  return Uint8Array.from(value);
}

function unavailable(cause: unknown): AlphionError {
  return new AlphionError("dependency-unavailable", "Device credential key is unavailable.", { stage: "vault", reason: "device-key-unavailable", cause });
}

function isMissing(error: unknown): boolean { return hasCode(error, "ENOENT"); }
function isExists(error: unknown): boolean { return hasCode(error, "EEXIST"); }
function hasCode(error: unknown, code: string): boolean { return !!error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === code; }
