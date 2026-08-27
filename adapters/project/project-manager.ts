import { mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import type { ProjectRecord } from "../../src/domain/contracts.js";
import type { ProjectManager } from "../../src/ports/index.js";

interface ProjectRegistryFile {
  readonly schemaVersion: 1;
  readonly activeProjectId?: string;
  readonly projects: readonly ProjectRecord[];
}

export class LocalProjectManager implements ProjectManager {
  #writeTail: Promise<void> = Promise.resolve();
  constructor(private readonly registryPath = defaultProjectRegistryPath()) {}

  async register(input: Readonly<{ name: string; root: string }>): Promise<ProjectRecord> {
    return this.#mutate(async (registry) => {
      const name = validateProjectName(input.name);
      const root = await realpath(resolve(input.root));
      const existing = registry.projects.find((item) => normalizePath(item.root) === normalizePath(root));
      if (existing) return { registry, result: existing };
      assertUniqueProject(registry.projects, name, root);
      const now = new Date().toISOString();
      const id = createId("project");
      const record = Object.freeze({ schemaVersion: 1 as const, id, name, root, statePath: join(root, ".alphion", "alphion.sqlite3"), domainId: projectDomainId(root), createdAt: now, updatedAt: now });
      return { registry: { ...registry, projects: Object.freeze([...registry.projects, record].sort(compareProjects)) }, result: record };
    });
  }

  async create(input: Readonly<{ name?: string; root: string }>): Promise<ProjectRecord> {
    await mkdir(resolve(input.root), { recursive: true });
    return this.register({ name: input.name ?? defaultProjectName(input.root), root: input.root });
  }

  async open(input: Readonly<{ name?: string; root: string; create?: boolean }>): Promise<ProjectRecord> {
    if (input.create) await mkdir(resolve(input.root), { recursive: true });
    const root = await realpath(resolve(input.root)).catch((error) => { throw new AlphionError("dependency-unavailable", "Project root is unavailable.", { stage: "project", cause: error }); });
    return this.#mutate(async (registry) => {
      const existing = registry.projects.find((item) => normalizePath(item.root) === normalizePath(root));
      if (existing) return { registry: { ...registry, activeProjectId: existing.id }, result: existing };
      const name = validateProjectName(input.name ?? defaultProjectName(root));
      assertUniqueProject(registry.projects, name, root);
      const now = new Date().toISOString(); const id = createId("project");
      const record = Object.freeze({ schemaVersion: 1 as const, id, name, root, statePath: join(root, ".alphion", "alphion.sqlite3"), domainId: projectDomainId(root), createdAt: now, updatedAt: now });
      return { registry: { schemaVersion: 1 as const, activeProjectId: id, projects: Object.freeze([...registry.projects, record].sort(compareProjects)) }, result: record };
    });
  }

  async list(): Promise<readonly ProjectRecord[]> { return (await this.#read()).projects; }
  async get(projectId: string): Promise<ProjectRecord | undefined> { return (await this.#read()).projects.find((item) => item.id === projectId); }

  async activate(projectId: string): Promise<ProjectRecord> {
    return this.#mutate(async (registry) => {
      const project = registry.projects.find((item) => item.id === projectId);
      if (!project) throw new AlphionError("validation", "Unknown Project.", { stage: "project" });
      await realpath(project.root).catch((error) => { throw new AlphionError("dependency-unavailable", "Project root is unavailable.", { stage: "project", cause: error }); });
      return { registry: { ...registry, activeProjectId: project.id }, result: project };
    });
  }

  async remove(projectId: string): Promise<boolean> {
    return this.#mutate(async (registry) => {
      if (!registry.projects.some((item) => item.id === projectId)) return { registry, result: false };
      return { registry: { schemaVersion: 1, projects: Object.freeze(registry.projects.filter((item) => item.id !== projectId)), ...(registry.activeProjectId === projectId ? {} : registry.activeProjectId ? { activeProjectId: registry.activeProjectId } : {}) }, result: true };
    });
  }

  async current(): Promise<ProjectRecord | undefined> {
    const registry = await this.#read();
    return registry.projects.find((item) => item.id === registry.activeProjectId);
  }

  async #read(): Promise<ProjectRegistryFile> {
    let serialized: string;
    try { serialized = await readFile(this.registryPath, "utf8"); }
    catch (error) {
      if (isMissing(error)) return Object.freeze({ schemaVersion: 1, projects: Object.freeze([]) });
      throw new AlphionError("dependency-unavailable", "Project registry cannot be read.", { stage: "project", cause: error });
    }
    return decodeRegistry(serialized);
  }

  async #mutate<T>(operation: (registry: ProjectRegistryFile) => Promise<Readonly<{ registry: ProjectRegistryFile; result: T }>>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolveValue, rejectValue) => { resolveResult = resolveValue; rejectResult = rejectValue; });
    this.#writeTail = this.#writeTail.then(async () => {
      try {
        const outcome = await operation(await this.#read());
        await writeRegistry(this.registryPath, outcome.registry);
        resolveResult(outcome.result);
      } catch (error) { rejectResult(error); }
    });
    await this.#writeTail;
    return result;
  }
}

export function defaultProjectRegistryPath(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.ALPHION_HOME?.trim()) return join(resolve(environment.ALPHION_HOME), "projects.json");
  if (process.platform === "win32") return join(environment.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "alphion", "projects.json");
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "alphion", "projects.json");
  return join(environment.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"), "alphion", "projects.json");
}

export function projectDomainId(root: string): string { return `domain_${sha256(normalizePath(resolve(root))).slice(0, 32)}`; }

async function writeRegistry(path: string, registry: ProjectRegistryFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${createId("tmp")}`;
  const handle = await open(temporary, "wx", 0o600);
  try { await handle.writeFile(`${canonicalJson(registry)}\n`, "utf8"); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary).catch(() => undefined); throw new AlphionError("dependency-unavailable", "Project registry cannot be updated.", { stage: "project", cause: error }); }
}

function decodeRegistry(serialized: string): ProjectRegistryFile {
  let value: unknown;
  try { value = JSON.parse(serialized); } catch (error) { throw new AlphionError("integrity-failed", "Project registry JSON is invalid.", { stage: "project", cause: error }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AlphionError("integrity-failed", "Project registry must be an object.", { stage: "project" });
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !Array.isArray(record.projects) || Object.keys(record).some((key) => !["schemaVersion", "activeProjectId", "projects"].includes(key))) throw new AlphionError("incompatible-schema", "Unsupported Project registry schema.", { stage: "project" });
  const projects = record.projects.map(decodeProject);
  const activeProjectId = typeof record.activeProjectId === "string" ? record.activeProjectId : undefined;
  if (activeProjectId && !projects.some((item) => item.id === activeProjectId)) throw new AlphionError("integrity-failed", "Active Project does not exist in the registry.", { stage: "project" });
  for (const project of projects) assertUniqueProject(projects.filter((item) => item.id !== project.id), project.name, project.root);
  return Object.freeze({ schemaVersion: 1, ...(activeProjectId ? { activeProjectId } : {}), projects: Object.freeze(projects.sort(compareProjects)) });
}

function decodeProject(value: unknown): ProjectRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AlphionError("integrity-failed", "Stored Project is invalid.", { stage: "project" });
  const item = value as Record<string, unknown>;
  const keys = ["schemaVersion", "id", "name", "root", "statePath", "domainId", "createdAt", "updatedAt"];
  if (item.schemaVersion !== 1 || keys.some((key) => key !== "schemaVersion" && typeof item[key] !== "string") || Object.keys(item).some((key) => !keys.includes(key))) throw new AlphionError("integrity-failed", "Stored Project envelope is invalid.", { stage: "project" });
  return Object.freeze(item as unknown as ProjectRecord);
}

function validateProjectName(value: string): string { const name = value.trim(); if (name.length < 1 || name.length > 80 || /[\u0000-\u001f]/u.test(name)) throw new AlphionError("validation", "Project name must be 1-80 printable characters.", { stage: "project" }); return name; }
function defaultProjectName(root: string): string { return basename(resolve(root)) || "Alphion Project"; }
function assertUniqueProject(projects: readonly ProjectRecord[], name: string, root: string): void { if (projects.some((item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) throw new AlphionError("conflict", "Project name already exists.", { stage: "project" }); if (projects.some((item) => normalizePath(item.root) === normalizePath(root))) throw new AlphionError("conflict", "Project root is already registered.", { stage: "project" }); }
function normalizePath(value: string): string { const normalized = resolve(value).replaceAll("\\", "/"); return process.platform === "win32" ? normalized.toLowerCase() : normalized; }
function compareProjects(left: ProjectRecord, right: ProjectRecord): number { return left.name.localeCompare(right.name) || left.id.localeCompare(right.id); }
function isMissing(error: unknown): boolean { return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT"; }
