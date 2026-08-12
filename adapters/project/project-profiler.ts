import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { SingleFlight, type TieredCache } from "../../src/application/cache.js";
import { canonicalJson, sha256 } from "../../src/application/canonical.js";
import { containsPotentialSecret } from "../../src/application/sensitive-data.js";
import type {
  ProfileDiagnostic,
  ProfileEvidence,
  ProfileFact,
  ProfileFactCategory,
  ProjectProfile,
} from "../../src/domain/contracts.js";
import type { ProjectProfiler } from "../../src/ports/index.js";
import {
  PROJECT_EXCLUDED_DIRECTORIES,
  PROJECT_SCAN_LIMIT,
  projectRevision,
} from "./project-revision.js";

const execFileAsync = promisify(execFile);
export const PROJECT_PROFILER_VERSION = "1.0.0";
export const PROJECT_PROFILE_RULES_VERSION = "node-typescript-v1";
export const PROJECT_CONFIG_LIMIT = 1024 * 1024;
export const PROJECT_PROFILE_LIMIT = 256 * 1024;
const PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PROFILE_CONFIG_FILES = new Set([
  "package.json", "tsconfig.json", "jsconfig.json", "pnpm-workspace.yaml", "turbo.json", "nx.json",
  "vite.config.js", "vite.config.ts", "next.config.js", "next.config.mjs", "eslint.config.js", "eslint.config.mjs",
]);
const LOCKFILES = Object.freeze([
  ["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"], ["bun.lockb", "bun"],
] as const);
const SECRET_PATH = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.pypirc$|credentials?(?:\.|$)|.*(?:secret|private[-_]?key).*)/iu;

export interface NodeProjectProfilerOptions {
  readonly cache?: TieredCache;
  readonly scanLimit?: number;
  readonly configLimitBytes?: number;
  readonly profileLimitBytes?: number;
}

interface ScanResult {
  readonly paths: readonly string[];
  readonly scannedPaths: number;
  readonly configs: ReadonlyMap<string, string>;
  readonly diagnostics: readonly ProfileDiagnostic[];
  readonly truncated: boolean;
}

export class NodeProjectProfiler implements ProjectProfiler {
  readonly #cache: TieredCache | undefined;
  readonly #scanLimit: number;
  readonly #configLimitBytes: number;
  readonly #profileLimitBytes: number;
  readonly #flights = new SingleFlight<ProjectProfile>();

  constructor(options: NodeProjectProfilerOptions = {}) {
    this.#cache = options.cache;
    this.#scanLimit = options.scanLimit ?? PROJECT_SCAN_LIMIT;
    this.#configLimitBytes = options.configLimitBytes ?? PROJECT_CONFIG_LIMIT;
    this.#profileLimitBytes = options.profileLimitBytes ?? PROJECT_PROFILE_LIMIT;
  }

  async inspect(options: Readonly<{ projectRoot: string; refresh?: boolean }>): Promise<ProjectProfile> {
    const root = await realpath(resolve(options.projectRoot));
    const revision = await projectRevision(root);
    const key = sha256(canonicalJson({ revision, profiler: PROJECT_PROFILER_VERSION, rules: PROJECT_PROFILE_RULES_VERSION }));
    if (!options.refresh && this.#cache) {
      const cached = await this.#cache.get("project-profile", key);
      if (cached.entry) {
        const decoded = decodeProfile(cached.entry.value);
        if (decoded?.projectRevision === revision) return decoded;
      }
    }
    const lease = this.#flights.acquire(key);
    if (!lease.owner) return lease.promise;
    try {
      const profile = await this.#inspectUncached(root, revision);
      if (this.#cache) {
        const now = Date.now();
        await this.#cache.set({
          namespace: "project-profile",
          key,
          value: JSON.stringify(profile),
          createdAt: new Date(now).toISOString(),
          expiresAt: new Date(now + PROFILE_CACHE_TTL_MS).toISOString(),
          provenance: canonicalJson({ revision, profiler: PROJECT_PROFILER_VERSION, rules: PROJECT_PROFILE_RULES_VERSION }),
        });
      }
      lease.complete(profile);
      return profile;
    } catch (error) {
      lease.fail(error);
      throw error;
    }
  }

  async #inspectUncached(root: string, revision: string): Promise<ProjectProfile> {
    const scan = await scanProject(root, this.#scanLimit, this.#configLimitBytes);
    const facts: ProfileFact[] = [];
    const diagnostics = [...scan.diagnostics];
    const packageText = scan.configs.get("package.json");
    const packageJson = packageText ? parsePackageJson(packageText, diagnostics) : undefined;
    addLanguageFacts(scan.paths, facts);
    addNodeFacts(packageJson, scan.paths, facts);
    addPackageManagerFacts(scan.paths, facts, diagnostics);
    addFrameworkFacts(packageJson, facts);
    addCiFacts(scan.paths, facts);
    const qualityCommands = addQualityFacts(packageJson, facts);
    await addGitFacts(root, facts, diagnostics);
    if (facts.length === 0) {
      diagnostics.push(Object.freeze({ code: "unknown-project", severity: "info", message: "No supported project signals were observed." }));
    }
    facts.sort((left, right) => compareText(left.id, right.id));
    diagnostics.sort((left, right) => compareText(`${left.code}:${left.path ?? ""}:${left.message}`, `${right.code}:${right.path ?? ""}:${right.message}`));
    const projectType = facts.some((fact) => fact.id === "language:typescript")
      ? "node-typescript"
      : facts.some((fact) => fact.id === "runtime:node")
        ? "node-javascript"
        : "unknown";
    const bounded = boundProfile({
      schemaVersion: 1,
      projectRevision: revision,
      profilerVersion: PROJECT_PROFILER_VERSION,
      rulesVersion: PROJECT_PROFILE_RULES_VERSION,
      projectType,
      facts,
      qualityCommands,
      diagnostics,
      scannedPaths: scan.scannedPaths,
      truncated: scan.truncated,
    }, this.#profileLimitBytes);
    const identity = { ...bounded, facts: Object.freeze(bounded.facts), qualityCommands: Object.freeze(bounded.qualityCommands), diagnostics: Object.freeze(bounded.diagnostics) };
    return Object.freeze({ ...identity, digest: sha256(canonicalJson(identity)) });
  }
}

async function scanProject(root: string, limit: number, configLimit: number): Promise<ScanResult> {
  const pending = [root];
  const paths: string[] = [];
  const configs = new Map<string, string>();
  const diagnostics: ProfileDiagnostic[] = [];
  let scannedPaths = 0;
  let truncated = false;
  while (pending.length > 0 && scannedPaths < limit) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => compareText(left.name, right.name));
    for (const entry of entries) {
      if (PROJECT_EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase())) continue;
      const absolute = join(directory, entry.name);
      const path = normalizePath(relative(root, absolute));
      const metadata = await lstat(absolute);
      scannedPaths += 1;
      if (metadata.isSymbolicLink()) {
        diagnostics.push(Object.freeze({ code: "path-skipped", severity: "info", message: "Symbolic link skipped.", path }));
        continue;
      }
      if (metadata.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!metadata.isFile()) continue;
      paths.push(path);
      if (SECRET_PATH.test(path)) {
        diagnostics.push(Object.freeze({ code: "path-skipped", severity: "info", message: "Secret-like path skipped.", path }));
      } else if (PROFILE_CONFIG_FILES.has(path) || PROFILE_CONFIG_FILES.has(entry.name)) {
        if (metadata.size > configLimit) {
          diagnostics.push(Object.freeze({ code: "oversize-config", severity: "warning", message: `Configuration exceeds ${configLimit} bytes.`, path }));
        } else {
          configs.set(path, await readFile(absolute, "utf8"));
        }
      }
      if (scannedPaths >= limit) {
        truncated = true;
        break;
      }
    }
  }
  if (pending.length > 0) truncated = true;
  if (truncated) diagnostics.push(Object.freeze({ code: "scan-truncated", severity: "warning", message: `Project scan stopped at ${limit} paths.` }));
  paths.sort();
  return { paths: Object.freeze(paths), scannedPaths, configs, diagnostics: Object.freeze(diagnostics), truncated };
}

function parsePackageJson(value: string, diagnostics: ProfileDiagnostic[]): Readonly<Record<string, unknown>> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("manifest root is not an object");
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    diagnostics.push(Object.freeze({ code: "invalid-config", severity: "warning", message: "package.json is invalid JSON.", path: "package.json" }));
    return undefined;
  }
}

function addLanguageFacts(paths: readonly string[], facts: ProfileFact[]): void {
  const counts = new Map<string, number>();
  const languages = new Map([[".ts", "TypeScript"], [".tsx", "TypeScript"], [".js", "JavaScript"], [".mjs", "JavaScript"], [".cjs", "JavaScript"]]);
  for (const path of paths) {
    const language = languages.get(extname(path).toLowerCase());
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  for (const [language, count] of [...counts].sort()) {
    facts.push(fact("language", language.toLowerCase(), language, "observed", [{ path: ".", detail: `${count} source files` }]));
  }
}

function addNodeFacts(packageJson: Readonly<Record<string, unknown>> | undefined, paths: readonly string[], facts: ProfileFact[]): void {
  if (!packageJson && !paths.includes("package.json")) return;
  facts.push(fact("runtime", "node", stringField(recordField(packageJson, "engines"), "node") ?? "unspecified", "observed", [{ path: "package.json", detail: "Node package manifest" }]));
  const moduleType = stringField(packageJson, "type") === "module" ? "ESM" : "CommonJS/unspecified";
  facts.push(fact("module-system", "node", moduleType, "observed", [{ path: "package.json", detail: `type=${stringField(packageJson, "type") ?? "unspecified"}` }]));
  const nodeConstraint = stringField(recordField(packageJson, "engines"), "node");
  if (nodeConstraint) facts.push(fact("constraint", "node-engine", nodeConstraint, "observed", [{ path: "package.json", detail: "engines.node" }]));
}

function addPackageManagerFacts(paths: readonly string[], facts: ProfileFact[], diagnostics: ProfileDiagnostic[]): void {
  const matches = LOCKFILES.filter(([path]) => paths.includes(path));
  for (const [path, manager] of matches) facts.push(fact("package-manager", manager, manager, "observed", [{ path, detail: "lockfile" }]));
  if (matches.length > 1) diagnostics.push(Object.freeze({
    code: "conflicting-lockfiles",
    severity: "warning",
    message: `Multiple package-manager lockfiles found: ${matches.map(([path]) => path).join(", ")}.`,
  }));
}

function addFrameworkFacts(packageJson: Readonly<Record<string, unknown>> | undefined, facts: ProfileFact[]): void {
  const dependencies = { ...recordField(packageJson, "dependencies"), ...recordField(packageJson, "devDependencies") };
  const known = [["react", "React"], ["ink", "Ink"], ["next", "Next.js"], ["vite", "Vite"], ["express", "Express"], ["fastify", "Fastify"]] as const;
  for (const [name, label] of known) {
    const version = stringField(dependencies, name);
    if (version) facts.push(fact("framework", name, `${label} ${version}`, "observed", [{ path: "package.json", detail: `dependency ${name}` }]));
  }
}

function addQualityFacts(packageJson: Readonly<Record<string, unknown>> | undefined, facts: ProfileFact[]): readonly string[] {
  const scripts = recordField(packageJson, "scripts");
  const preferred = ["typecheck", "lint", "test", "build", "check"];
  const commands: string[] = [];
  for (const name of preferred) {
    const value = stringField(scripts, name);
    if (!value || containsPotentialSecret(value)) continue;
    const command = `npm run ${name}`;
    commands.push(command);
    facts.push(fact("quality-command", name, command, "observed", [{ path: "package.json", detail: `scripts.${name}` }]));
  }
  return Object.freeze(commands);
}

function addCiFacts(paths: readonly string[], facts: ProfileFact[]): void {
  if (paths.some((path) => path.startsWith(".github/workflows/") && /\.ya?ml$/iu.test(path))) {
    facts.push(fact("ci", "github-actions", "GitHub Actions", "observed", [{ path: ".github/workflows", detail: "workflow files" }]));
  }
  if (paths.includes(".gitlab-ci.yml")) facts.push(fact("ci", "gitlab", "GitLab CI", "observed", [{ path: ".gitlab-ci.yml", detail: "pipeline file" }]));
}

async function addGitFacts(root: string, facts: ProfileFact[], diagnostics: ProfileDiagnostic[]): Promise<void> {
  try {
    const [branch, status] = await Promise.all([
      execFileAsync("git", ["-C", root, "branch", "--show-current"], { windowsHide: true, maxBuffer: 1024 * 1024 }),
      execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=normal"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }),
    ]);
    const dirty = status.stdout.length > 0;
    facts.push(fact("git", "repository", dirty ? "dirty" : "clean", "observed", [{ path: ".git", detail: branch.stdout.trim() || "detached" }]));
    if (dirty) facts.push(fact("risk", "dirty-worktree", "Uncommitted changes present", "observed", [{ path: ".git", detail: "git status" }]));
  } catch {
    diagnostics.push(Object.freeze({ code: "git-unavailable", severity: "info", message: "Git repository metadata is unavailable." }));
  }
}

function fact(category: ProfileFactCategory, name: string, value: string, confidence: "observed" | "inferred", evidence: readonly ProfileEvidence[]): ProfileFact {
  return Object.freeze({ id: `${category}:${name}`, category, name, value, confidence, evidence: Object.freeze(evidence.map((item) => Object.freeze(item))) });
}

function boundProfile(profile: Omit<ProjectProfile, "digest">, limit: number): Omit<ProjectProfile, "digest"> {
  const facts = [...profile.facts];
  const diagnostics = [...profile.diagnostics];
  let truncated = profile.truncated;
  let profileTruncated = false;
  while (Buffer.byteLength(JSON.stringify({ ...profile, facts, diagnostics }), "utf8") > limit && facts.length > 0) {
    facts.pop();
    truncated = true;
    profileTruncated = true;
  }
  if (Buffer.byteLength(JSON.stringify({ ...profile, facts, diagnostics }), "utf8") > limit) profileTruncated = true;
  if (profileTruncated && !diagnostics.some((item) => item.code === "profile-truncated")) {
    diagnostics.unshift(Object.freeze({ code: "profile-truncated", severity: "warning", message: `Serialized project profile is limited to ${limit} bytes.` }));
  }
  while (Buffer.byteLength(JSON.stringify({ ...profile, facts, diagnostics }), "utf8") > limit && diagnostics.length > 1) {
    diagnostics.pop();
    truncated = true;
  }
  return { ...profile, facts: Object.freeze(facts), diagnostics: Object.freeze(diagnostics), truncated };
}

function decodeProfile(value: string): ProjectProfile | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || typeof parsed.projectRevision !== "string" || typeof parsed.digest !== "string" || !Array.isArray(parsed.facts) || !Array.isArray(parsed.qualityCommands) || !Array.isArray(parsed.diagnostics)) return undefined;
    const { digest, ...identity } = parsed;
    if (sha256(canonicalJson(identity)) !== digest) return undefined;
    return Object.freeze({
      ...parsed,
      facts: Object.freeze([...parsed.facts]),
      qualityCommands: Object.freeze([...parsed.qualityCommands]),
      diagnostics: Object.freeze([...parsed.diagnostics]),
    }) as unknown as ProjectProfile;
  } catch {
    return undefined;
  }
}

function recordField(value: Readonly<Record<string, unknown>> | undefined, key: string): Readonly<Record<string, unknown>> {
  const field = value?.[key];
  return isRecord(field) ? field : {};
}

function stringField(value: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePath(value: string): string {
  return value.replaceAll("\\", "/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
