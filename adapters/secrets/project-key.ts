import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { AlphionError } from "../../src/application/errors.js";
import type { ProjectKeyProvider } from "../../src/ports/index.js";
import { defaultProjectRegistryPath } from "../project/project-manager.js";

const PROJECT_KEY_BYTES = 32;
const execFileAsync = promisify(execFile);

export class FileProjectKeyProvider implements ProjectKeyProvider {
  #writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly root = defaultProjectKeyRoot()) {}

  async load(projectId: string): Promise<Uint8Array | undefined> {
    const path = this.pathFor(projectId);
    try { return validateProjectKey(await readFile(path)); }
    catch (error) {
      if (hasCode(error, "ENOENT")) return undefined;
      if (error instanceof AlphionError) throw error;
      throw unavailable(error);
    }
  }

  async loadOrCreate(projectId: string): Promise<Uint8Array> {
    const present = await this.load(projectId);
    if (present) return present;
    let result: Uint8Array | undefined;
    let failure: unknown;
    const operation = this.#writeTail.then(async () => {
      try { result = await this.load(projectId) ?? await createProjectKey(this.pathFor(projectId)); }
      catch (error) { failure = error; }
    });
    this.#writeTail = operation;
    await operation;
    if (failure) throw failure;
    if (!result) throw unavailable(new Error("Project key creation did not return a key."));
    return result;
  }

  pathFor(projectId: string): string {
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(projectId)) {
      throw new AlphionError("validation", "Project credential identity is invalid.", { stage: "credential" });
    }
    return join(this.root, `${projectId}.key`);
  }
}

export function defaultProjectKeyRoot(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultProjectRegistryPath(environment)), "project-keys");
}

export function defaultLegacyDeviceKeyPath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultProjectRegistryPath(environment)), "device.key");
}

async function createProjectKey(path: string): Promise<Uint8Array> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(8).toString("hex")}`;
  const key = randomBytes(PROJECT_KEY_BYTES);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(key); await handle.sync(); }
    finally { await handle.close(); }
    await restrictAccess(temporary);
    try { await link(temporary, path); }
    catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    await unlink(temporary).catch(() => undefined);
    return validateProjectKey(await readFile(path));
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
    throw new AlphionError("dependency-unavailable", "Project credential key permissions could not be restricted.", { stage: "credential", reason: "project-key-permission-failed", cause: error });
  }
}

function windowsPrincipal(): string {
  const username = process.env.USERNAME?.trim() || userInfo().username;
  const domain = process.env.USERDOMAIN?.trim();
  return domain ? `${domain}\\${username}` : username;
}

function validateProjectKey(value: Uint8Array): Uint8Array {
  if (value.byteLength !== PROJECT_KEY_BYTES) throw new AlphionError("integrity-failed", "Project credential key has an invalid length.", { stage: "credential", reason: "project-key-corrupt" });
  return Uint8Array.from(value);
}

function unavailable(cause: unknown): AlphionError {
  return new AlphionError("dependency-unavailable", "Project credential key is unavailable.", { stage: "credential", reason: "project-key-unavailable", cause });
}

function hasCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { readonly code?: unknown }).code === code;
}
