import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { Agent } from "../../src/application/agent.js";
import { AgentSession } from "../../src/application/agent-session.js";
import { DefaultSessionManager } from "../../src/application/session-manager.js";
import { createAgentEnvironment } from "../../src/application/agent-environment.js";
import { TieredCache } from "../../src/application/cache.js";
import { AlphionError } from "../../src/application/errors.js";
import { CapabilityRegistry, planHarness } from "../../src/application/harness.js";
import { ProviderConfigurationManager } from "../../src/application/provider-configuration.js";
import { ToolRegistry } from "../../src/application/tool-registry.js";
import type {
  AgentResource,
  DiagnosticCheck,
  DiagnosticReport,
  HarnessPlan,
  HarnessTaskOverlay,
  ProviderPreset,
  ProjectProfile,
} from "../../src/domain/contracts.js";
import type {
  AgentApplication,
  AgentContract,
  CacheStats,
  ProviderConfigurationService,
  SessionManager,
} from "../../src/ports/index.js";
import { MemoryLruCache } from "../cache/memory-cache.js";
import { DEEPSEEK_DEFAULT_BASE_URL, DEEPSEEK_MODELS } from "../model/deepseek.js";
import { LocalModelResolver } from "../model/local-model-resolver.js";
import { NodeProjectProfiler } from "../project/project-profiler.js";
import { projectRevision } from "../project/project-revision.js";
import { CompositeSecretResolver } from "../secrets/composite-secret.js";
import { EnvironmentSecretResolver } from "../secrets/environment-secret.js";
import { LocalResourceLoader } from "../resources/local-resource-loader.js";
import { ProjectCodeRecall } from "../recall/project-code-recall.js";
import { SqliteStore } from "../store/sqlite-store.js";
import { EditTool, GrepTool, ReadTool, ShellTool, WriteTool } from "../tools/index.js";

export interface LocalApplicationOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
}

const execFileAsync = promisify(execFile);
const LOCAL_PROVIDER_PRESETS: readonly ProviderPreset[] = Object.freeze([
  Object.freeze({
    id: "deepseek",
    label: "DeepSeek",
    kind: "deepseek",
    baseUrl: DEEPSEEK_DEFAULT_BASE_URL,
    models: DEEPSEEK_MODELS,
    protocol: "chat-completions",
  }),
  Object.freeze({
    id: "openai-compatible",
    label: "OpenAI 兼容接口",
    kind: "openai-compatible",
    baseUrl: "https://api.openai.com/v1",
    models: Object.freeze(["gpt-5-mini"]),
    protocol: "responses",
  }),
]);

export class LocalAlphionApplication implements AgentApplication {
  readonly configuration: ProviderConfigurationService;
  readonly agent: AgentContract;
  readonly sessions: SessionManager;
  readonly #projectRoot: string;
  readonly #store: SqliteStore;
  readonly #secrets: CompositeSecretResolver;
  readonly #cache: TieredCache;
  readonly #tools: ToolRegistry;
  readonly #profiler: NodeProjectProfiler;
  readonly #statePath: string;
  readonly #resources = new LocalResourceLoader();
  readonly #recall = new ProjectCodeRecall();
  readonly #models: LocalModelResolver;
  readonly #capabilities = new CapabilityRegistry([
    { id: "project.read", description: "Read bounded project context.", taskLabels: ["explain", "diagnose", "implement", "verify", "release"], permissions: ["project:read"], defaultBudget: 20 },
    { id: "project.write", description: "Modify project files.", taskLabels: ["implement", "release"], permissions: ["project:write"], defaultBudget: 12 },
    { id: "quality.verify", description: "Run project verification.", taskLabels: ["diagnose", "verify", "release"], permissions: ["process:approved"], defaultBudget: 8 },
  ]);
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(projectRoot: string, statePath: string, store: SqliteStore) {
    this.#projectRoot = projectRoot;
    this.#statePath = statePath;
    this.#store = store;
    this.#secrets = new CompositeSecretResolver([new EnvironmentSecretResolver(), store]);
    this.#cache = new TieredCache(new MemoryLruCache(), store);
    this.#tools = new ToolRegistry([
      new ReadTool(),
      new GrepTool(),
      new EditTool(),
      new WriteTool(),
      new ShellTool(store),
    ]);
    this.#profiler = new NodeProjectProfiler({ cache: this.#cache });
    this.configuration = new ProviderConfigurationManager(store, store);
    this.#models = new LocalModelResolver(store, this.#secrets);
    this.agent = new Agent({ models: this.#models, tools: this.#tools, eventStore: store, cache: this.#cache });
    this.sessions = new DefaultSessionManager({ store, session: (sessionId) => this.#session(sessionId), assertOpen: () => this.#assertOpen() });
  }

  static async open(options: LocalApplicationOptions): Promise<LocalAlphionApplication> {
    const projectRoot = await realpath(resolve(options.projectRoot));
    const statePath = resolve(options.statePath ?? join(projectRoot, ".alphion", "alphion.sqlite3"));
    return new LocalAlphionApplication(projectRoot, statePath, new SqliteStore({ path: statePath }));
  }

  planHarness(prompt: string, overlay?: HarnessTaskOverlay): Promise<HarnessPlan> { this.#assertOpen(); return Promise.resolve(planHarness(prompt, this.#capabilities, overlay)); }

  async loadResources(request: Readonly<{ disabledIds?: readonly string[]; additionalSafePaths?: readonly string[]; overrides?: Readonly<Record<string, string>>; maxResources?: number; maxBytes?: number }> = {}): Promise<readonly AgentResource[]> {
    this.#assertOpen();
    return (await this.#resources.load({ projectRoot: this.#projectRoot, ...request })).resources;
  }

  inspectProject(options: Readonly<{ refresh?: boolean }> = {}): Promise<ProjectProfile> {
    this.#assertOpen();
    return this.#profiler.inspect({ projectRoot: this.#projectRoot, ...(options.refresh ? { refresh: true } : {}) });
  }

  diagnose(): Promise<DiagnosticReport> {
    this.#assertOpen();
    return diagnoseLocalProject({ projectRoot: this.#projectRoot, statePath: this.#statePath });
  }

  providerPresets(): readonly ProviderPreset[] {
    return LOCAL_PROVIDER_PRESETS;
  }

  cacheStats(): Promise<CacheStats> {
    this.#assertOpen();
    return this.#store.stats();
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.sessions.close();
      this.#store.close();
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new AlphionError("conflict", "Local Alphion application is closed.", { stage: "application" });
  }

  #session(sessionId: string): AgentSession {
    return new AgentSession({ sessionId, store: this.#store, agent: this.agent, projectRoot: this.#projectRoot,
      projectProfile: () => this.#profiler.inspect({ projectRoot: this.#projectRoot }),
      environment: async (profile) => createAgentEnvironment({ projectRoot: this.#projectRoot, projectRevision: profile.projectRevision, capabilities: this.#capabilities.list().map((item) => item.id), policies: ["default-deny", "approval-for-side-effects"], loaded: await this.#resources.load({ projectRoot: this.#projectRoot }) }),
      plan: (prompt) => planHarness(prompt, this.#capabilities),
      models: this.#models,
      recall: this.#recall });
  }
}

export function openLocalAlphionApplication(options: LocalApplicationOptions): Promise<LocalAlphionApplication> {
  return LocalAlphionApplication.open(options);
}

export async function diagnoseLocalProject(options: LocalApplicationOptions): Promise<DiagnosticReport> {
  const checks: DiagnosticCheck[] = [];
  const projectRoot = await resolveProjectRoot(options.projectRoot, checks);
  checks.push(nodeCheck());
  checks.push(await fileCheck("build", "构建产物", join(projectRoot, "dist", "cli", "index.js"), "请运行 npm run build。"));
  checks.push(await gitCheck(projectRoot));
  checks.push(await codeGraphCheck(projectRoot));
  const statePath = resolve(options.statePath ?? join(projectRoot, ".alphion", "alphion.sqlite3"));
  checks.push(...await sqliteChecks(statePath));
  const overall = checks.some((check) => check.status === "fail")
    ? "unhealthy"
    : checks.some((check) => check.status === "warning" || check.status === "unknown")
      ? "attention"
      : "healthy";
  return Object.freeze({ schemaVersion: 1, projectRoot, overall, checks: Object.freeze(checks) });
}

async function resolveProjectRoot(value: string, checks: DiagnosticCheck[]): Promise<string> {
  try {
    const root = await realpath(resolve(value));
    checks.push(Object.freeze({ id: "project-root", label: "项目根目录", status: "pass", summary: "项目根目录可访问。" }));
    return root;
  } catch {
    const root = resolve(value);
    checks.push(Object.freeze({ id: "project-root", label: "项目根目录", status: "fail", summary: "项目根目录不可访问。", remediation: "请确认 --project-root 指向现有目录。" }));
    return root;
  }
}

function nodeCheck(): DiagnosticCheck {
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  const supported = major > 22 || (major === 22 && minor >= 13);
  return Object.freeze({
    id: "node",
    label: "Node.js",
    status: supported ? "pass" : "fail",
    summary: `Node.js ${process.versions.node}${supported ? " 满足要求" : " 低于 22.13"}。`,
    ...(!supported ? { remediation: "请安装 Node.js 22.13 或更高版本。" } : {}),
  });
}

async function fileCheck(id: string, label: string, path: string, remediation: string): Promise<DiagnosticCheck> {
  try {
    const metadata = await stat(path);
    return Object.freeze({ id, label, status: metadata.isFile() ? "pass" : "fail", summary: metadata.isFile() ? "文件存在。" : "路径不是文件。", ...(!metadata.isFile() ? { remediation } : {}) });
  } catch {
    return Object.freeze({ id, label, status: "warning", summary: "文件尚不存在。", remediation });
  }
}

async function gitCheck(root: string): Promise<DiagnosticCheck> {
  try {
    const result = await execFileAsync("git", ["-C", root, "status", "--porcelain=v1", "--branch"], { windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    const revision = await projectRevision(root);
    const lines = result.stdout.trim().split(/\r?\n/u).filter(Boolean);
    const dirty = lines.some((line) => !line.startsWith("##"));
    return Object.freeze({ id: "git", label: "Git / revision", status: dirty ? "warning" : "pass", summary: `${dirty ? "Git 工作区存在未提交变更" : "Git 工作区干净"}；revision ${revision.slice(0, 12)}。` });
  } catch {
    return Object.freeze({ id: "git", label: "Git / revision", status: "unknown", summary: "Git 不可用；将使用确定性文件系统 revision。" });
  }
}

async function codeGraphCheck(root: string): Promise<DiagnosticCheck> {
  try {
    await access(join(root, ".codegraph"));
    await execFileAsync("codegraph", ["status"], { cwd: root, windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
    return Object.freeze({ id: "codegraph", label: "CodeGraph", status: "pass", summary: "索引可用。" });
  } catch {
    return Object.freeze({ id: "codegraph", label: "CodeGraph", status: "warning", summary: "CodeGraph 索引或命令不可用。", remediation: "请在项目根目录运行 codegraph init / sync。" });
  }
}

async function sqliteChecks(path: string): Promise<readonly DiagnosticCheck[]> {
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return [Object.freeze({ id: "sqlite", label: "本地状态", status: "warning", summary: "SQLite 状态尚未创建。", remediation: "首次配置 Provider 时会创建本地状态。" })];
  }
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true });
    const schema = numericCell(database.prepare("PRAGMA user_version").get(), "user_version");
    const integrity = firstCell(database.prepare("PRAGMA quick_check").get()) === "ok";
    if (!integrity) return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: "SQLite 完整性检查失败。", remediation: "请备份 .alphion 后按 Runbook 恢复。" })];
    if (schema > 3) return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: `SQLite schema ${schema} 高于当前支持的 3。`, remediation: "请使用兼容版本的 Alphion。" })];
    if (schema < 3) return [Object.freeze({ id: "sqlite", label: "本地状态", status: "warning", summary: `SQLite schema ${schema} 尚未迁移至 3；doctor 未做修改。`, remediation: "备份后通过正常应用启动执行迁移。" })];
    const providerCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM provider_profiles").get(), "count");
    const activeCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM provider_profiles WHERE active = 1").get(), "count");
    const vaultCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM vault_metadata").get(), "count");
    return [Object.freeze({
      id: "sqlite",
      label: "本地状态",
      status: activeCount > 0 ? "pass" : "warning",
      summary: `schema ${schema} 完整；Provider ${providerCount} 个，活动 ${activeCount} 个，Vault ${vaultCount > 0 ? "已初始化" : "未初始化"}。`,
      ...(activeCount === 0 ? { remediation: "请在工程工作台中配置并激活 Provider。" } : {}),
    })];
  } catch {
    return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: "SQLite 无法以只读方式验证。", remediation: "请备份 .alphion 后检查数据库文件。" })];
  } finally {
    database?.close();
  }
}

function numericCell(value: unknown, key: string): number {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return -1;
  const cell = (value as Readonly<Record<string, unknown>>)[key];
  return typeof cell === "bigint" ? Number(cell) : typeof cell === "number" ? cell : -1;
}

function firstCell(value: unknown): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.values(value as Readonly<Record<string, unknown>>)[0]
    : undefined;
}
