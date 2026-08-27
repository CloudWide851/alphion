import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { openSqliteDatabase, probeSqliteDriver, type SqliteDatabase } from "../store/database.js";
import { Agent } from "../../src/application/agent.js";
import { sha256 } from "../../src/application/canonical.js";
import { AgentSession } from "../../src/application/agent-session.js";
import { DefaultSessionManager } from "../../src/application/session-manager.js";
import { createAgentEnvironment } from "../../src/application/agent-environment.js";
import { AgentShaper } from "../../src/application/agent-shaper.js";
import { TieredCache } from "../../src/application/cache.js";
import { AlphionError } from "../../src/application/errors.js";
import { CapabilityRegistry, planHarness } from "../../src/application/harness.js";
import { ProviderConfigurationManager } from "../../src/application/provider-configuration.js";
import { DefaultProviderTestService } from "../../src/application/provider-test.js";
import { DefaultGoalManager } from "../../src/application/goal-manager.js";
import { DefaultScheduleManager } from "../../src/application/schedule-manager.js";
import { ToolRegistry } from "../../src/application/tool-registry.js";
import type {
  AgentShapeRequest,
  DiagnosticCheck,
  DiagnosticReport,
  HarnessPlan,
  HarnessTaskOverlay,
  ProviderPreset,
  ProjectProfile,
  ResourceLoadRequest,
  ResourceResolution,
} from "../../src/domain/contracts.js";
import type { SessionActivity } from "../../src/domain/session-activity.js";
import type {
  AgentApplication,
  AgentContract,
  CacheStats,
  ProjectKeyProvider,
  GoalManager,
  ProviderConfigurationService,
  ProviderTestService,
  ScheduleManager,
  SessionManager,
} from "../../src/ports/index.js";
import { MemoryLruCache } from "../cache/memory-cache.js";
import { LOCAL_PROVIDER_PRESETS } from "../model/provider-catalog.js";
import { LocalModelResolver, LocalProviderFactory } from "../model/local-model-resolver.js";
import { NodeProjectProfiler } from "../project/project-profiler.js";
import { projectRevision } from "../project/project-revision.js";
import { CompositeSecretResolver } from "../secrets/composite-secret.js";
import { defaultLegacyDeviceKeyPath, FileProjectKeyProvider } from "../secrets/project-key.js";
import { EnvironmentSecretResolver } from "../secrets/environment-secret.js";
import { LocalResourceLoader } from "../resources/local-resource-loader.js";
import { ProjectCodeRecall } from "../recall/project-code-recall.js";
import { SqliteRuntimeStore } from "../store/sqlite-runtime-store.js";
import { SQLITE_SCHEMA_VERSION } from "../store/sqlite-constants.js";
import { EditTool, GoalProgressTool, GrepTool, ReadTool, SessionSendTool, ShellTool, WriteTool } from "../tools/index.js";

export interface LocalApplicationOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
  readonly projectId?: string;
  readonly domainId?: string;
  readonly unowned?: boolean;
  readonly projectKeyProvider?: ProjectKeyProvider;
  readonly legacyDeviceKeyPath?: string;
}

const execFileAsync = promisify(execFile);
export class LocalAlphionApplication implements AgentApplication {
  readonly configuration: ProviderConfigurationService;
  readonly providerTests: ProviderTestService;
  readonly agent: AgentContract;
  readonly sessions: SessionManager;
  readonly goals: GoalManager;
  readonly schedules: ScheduleManager;
  readonly #projectRoot: string;
  readonly #store: SqliteRuntimeStore;
  readonly #secrets: CompositeSecretResolver;
  readonly #cache: TieredCache;
  readonly #tools: ToolRegistry;
  readonly #profiler: NodeProjectProfiler;
  readonly #statePath: string;
  readonly #resources = new LocalResourceLoader();
  readonly #recall = new ProjectCodeRecall();
  readonly #models: LocalModelResolver;
  readonly #projectKeyProvider: ProjectKeyProvider;
  readonly #credentialProjectId: string;
  readonly #unowned: boolean;
  readonly #capabilities = new CapabilityRegistry([
    { id: "project.read", description: "Read bounded project context.", taskLabels: ["explain", "diagnose", "implement", "verify", "release"], permissions: ["project:read"], defaultBudget: 20 },
    { id: "project.write", description: "Modify project files.", taskLabels: ["implement", "release"], permissions: ["project:write"], defaultBudget: 12 },
    { id: "quality.verify", description: "Run project verification.", taskLabels: ["diagnose", "verify", "release"], permissions: ["process:approved"], defaultBudget: 8 },
    { id: "session.collaborate", description: "Send bounded messages to shaped Sessions in the same Project domain.", taskLabels: ["explain", "diagnose", "implement", "verify", "release"], permissions: ["session:send"], defaultBudget: 4 },
    { id: "goal.progress", description: "Append Evidence-backed progress to the current dedicated Goal Session.", taskLabels: ["explain", "diagnose", "implement", "verify", "release"], permissions: ["goal:progress"], defaultBudget: 4 },
  ]);
  readonly #shaper: AgentShaper;
  #closed = false;
  #closePromise: Promise<void> | undefined;

  private constructor(projectRoot: string, statePath: string, store: SqliteRuntimeStore, unowned: boolean, projectKeyProvider: ProjectKeyProvider, credentialProjectId: string) {
    this.#projectRoot = projectRoot;
    this.#unowned = unowned;
    this.#statePath = statePath;
    this.#store = store;
    this.#projectKeyProvider = projectKeyProvider;
    this.#credentialProjectId = credentialProjectId;
    this.#secrets = new CompositeSecretResolver([new EnvironmentSecretResolver(), store]);
    this.#cache = new TieredCache(new MemoryLruCache(), store);
    this.goals = new DefaultGoalManager(store, () => this.#assertOpen());
    this.#tools = new ToolRegistry(unowned
      ? [new SessionSendTool()]
      : [new ReadTool(), new GrepTool(), new EditTool(), new WriteTool(), new ShellTool(store), new SessionSendTool(), new GoalProgressTool(this.goals)]);
    this.#profiler = new NodeProjectProfiler({ cache: this.#cache });
    this.configuration = new ProviderConfigurationManager(store, store);
    this.providerTests = new DefaultProviderTestService(store, new LocalProviderFactory(this.#secrets));
    this.#models = new LocalModelResolver(store, this.#secrets);
    this.#shaper = new AgentShaper({ capabilities: this.#capabilities.list().map((item) => item.id).filter((id) => !unowned || id === "session.collaborate"), policies: ["default-deny", "approval-for-side-effects", "same-domain-session-collaboration", ...(unowned ? ["no-project-filesystem"] : [])], tools: this.#tools.names(), toolCapabilities: { read: "project.read", grep: "project.read", edit: "project.write", write: "project.write", shell: "quality.verify", "session.send": "session.collaborate", "goal.progress": "goal.progress" } });
    this.agent = new Agent({ models: this.#models, tools: this.#tools, eventStore: store, cache: this.#cache });
    this.sessions = new DefaultSessionManager({ store, session: (sessionId, publishActivity) => this.#session(sessionId, publishActivity), assertOpen: () => this.#assertOpen() });
    this.schedules = new DefaultScheduleManager({ store, sessions: this.sessions, goals: this.goals, assertOpen: () => this.#assertOpen(), enabled: !unowned });
    this.schedules.start();
  }

  static async open(options: LocalApplicationOptions): Promise<LocalAlphionApplication> {
    const projectRoot = await realpath(resolve(options.projectRoot));
    const statePath = resolve(options.statePath ?? join(projectRoot, ".alphion", "alphion.sqlite3"));
    const projectKeyProvider = options.projectKeyProvider ?? new FileProjectKeyProvider();
    const projectId = options.unowned === true ? undefined : options.projectId ?? derivedProjectId(projectRoot);
    const credentialProjectId = projectId ?? options.domainId ?? "domain_unowned";
    const store = new SqliteRuntimeStore({ path: statePath, projectKeyProvider, legacyDeviceKeyPath: options.legacyDeviceKeyPath ?? defaultLegacyDeviceKeyPath(), ...(projectId ? { projectId } : {}), ...(options.domainId ? { domainId: options.domainId } : {}) });
    try { await store.migrateLegacyCredentials(); }
    catch (error) { store.close(); throw error; }
    return new LocalAlphionApplication(projectRoot, statePath, store, options.unowned === true, projectKeyProvider, credentialProjectId);
  }

  planHarness(prompt: string, overlay?: HarnessTaskOverlay): Promise<HarnessPlan> { this.#assertOpen(); return Promise.resolve(planHarness(prompt, this.#capabilities, overlay)); }

  async loadResources(request: Omit<ResourceLoadRequest, "projectRoot"> = {}): Promise<ResourceResolution> {
    this.#assertOpen();
    const disabledScopes = this.#unowned ? Object.freeze([...(request.disabledScopes ?? []), "project" as const]) : request.disabledScopes;
    return this.#resources.resolve({ projectRoot: this.#projectRoot, ...request, ...(disabledScopes ? { disabledScopes } : {}) });
  }

  inspectProject(options: Readonly<{ refresh?: boolean }> = {}): Promise<ProjectProfile> {
    this.#assertOpen();
    return this.#profiler.inspect({ projectRoot: this.#projectRoot, ...(options.refresh ? { refresh: true } : {}) });
  }

  diagnose(): Promise<DiagnosticReport> {
    this.#assertOpen();
    return diagnoseLocalProject({ projectRoot: this.#projectRoot, statePath: this.#statePath, projectId: this.#credentialProjectId, projectKeyProvider: this.#projectKeyProvider });
  }

  providerPresets(): readonly ProviderPreset[] {
    return LOCAL_PROVIDER_PRESETS;
  }

  cacheStats(): Promise<CacheStats> {
    this.#assertOpen();
    return this.#store.stats();
  }

  clearCache(namespace?: string): Promise<number> { this.#assertOpen(); return this.#store.delete(namespace); }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.schedules.close();
      await this.sessions.close();
      this.#store.close();
    })();
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.#closed) throw new AlphionError("conflict", "Local Alphion application is closed.", { stage: "application" });
  }

  #session(sessionId: string, publishActivity: (activity: SessionActivity) => void): AgentSession {
    return new AgentSession({ sessionId, store: this.#store, agent: this.agent, projectRoot: this.#projectRoot,
      projectProfile: () => this.#profiler.inspect({ projectRoot: this.#projectRoot }),
      environment: async (profile, shape) => createAgentEnvironment({ identity: shape.identity, projectRoot: this.#projectRoot, projectRevision: profile.projectRevision, capabilities: shape.capabilities, policies: shape.policies, loaded: { schemaVersion: 1, resources: shape.resources, shadows: [], omissions: shape.omissions, diagnostics: [], digest: shape.resourceDigest }, goal: shape.goal, behavior: shape.behavior, harnessPlan: shape.harnessPlan, systemPromptPlan: shape.systemPromptPlan }),
      shape: async (request: AgentShapeRequest, revision, profile, harness) => this.#shaper.shape({ sessionId, revision, request, profile, resources: await this.#resources.resolve({ projectRoot: this.#projectRoot, ...(this.#unowned ? { disabledScopes: ["project"] } : {}) }), harness }),
      plan: (prompt) => planHarness(prompt, this.#capabilities),
      models: this.#models,
      ...(this.#unowned ? {} : { recall: this.#recall }),
      deliverSessionMessage: (request) => this.sessions.deliver(request), publishActivity });
  }
}

function derivedProjectId(projectRoot: string): string {
  const identity = process.platform === "win32" ? projectRoot.toLocaleLowerCase("en-US") : projectRoot;
  return `project_${sha256(identity).slice(0, 32)}`;
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
  const credentialProjectId = options.projectId ?? options.domainId ?? (options.unowned ? "domain_unowned" : derivedProjectId(projectRoot));
  checks.push(...await sqliteChecks(statePath, credentialProjectId, options.projectKeyProvider ?? new FileProjectKeyProvider()));
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

async function sqliteChecks(path: string, credentialProjectId: string, projectKeyProvider: ProjectKeyProvider): Promise<readonly DiagnosticCheck[]> {
  try {
    probeSqliteDriver();
  } catch (error) {
    const abiMismatch = error instanceof AlphionError && error.message.includes("native-abi-mismatch");
    return [Object.freeze({
      id: "sqlite-native",
      label: "SQLite 原生运行时",
      status: "fail",
      summary: abiMismatch ? "SQLite 原生模块与当前 Node/Electron ABI 不兼容。" : "SQLite 原生模块不可用。",
      remediation: abiMismatch
        ? "Node/TUI 请运行 npm ci；Desktop 请运行 npm run desktop:deps。不要删除 SQLite 数据库。"
        : "请重新安装 Alphion 依赖后再次运行 doctor。不要删除 SQLite 数据库。",
    })];
  }
  try {
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("not a file");
  } catch {
    return [Object.freeze({ id: "sqlite", label: "本地状态", status: "warning", summary: "SQLite 状态尚未创建。", remediation: "首次配置 Provider 时会创建本地状态。" })];
  }
  let database: SqliteDatabase | undefined;
  try {
    database = openSqliteDatabase(path, { readOnly: true });
    const schema = numericCell(database.prepare("PRAGMA user_version").get(), "user_version");
    const integrity = firstCell(database.prepare("PRAGMA quick_check").get()) === "ok";
    if (!integrity) return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: "SQLite 完整性检查失败。", remediation: "请备份 .alphion 后按 Runbook 恢复。" })];
    if (schema > SQLITE_SCHEMA_VERSION) return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: `SQLite schema ${schema} 高于当前支持的 ${SQLITE_SCHEMA_VERSION}。`, remediation: "请使用兼容版本的 Alphion。" })];
    if (schema < SQLITE_SCHEMA_VERSION) return [Object.freeze({ id: "sqlite", label: "本地状态", status: "warning", summary: `SQLite schema ${schema} 尚未迁移至 ${SQLITE_SCHEMA_VERSION}；doctor 未做修改。`, remediation: "备份后通过正常应用启动执行迁移。" })];
    const providerCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM provider_profiles").get(), "count");
    const activeCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM provider_profiles WHERE active = 1").get(), "count");
    const credentialCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM project_credentials WHERE project_id = ?").get(credentialProjectId), "count");
    const reentryCount = numericCell(database.prepare("SELECT COUNT(*) AS count FROM project_credential_migrations WHERE state = 'reentry-required'").get(), "count");
    const credentialCheck = await projectCredentialCheck(credentialProjectId, credentialCount, projectKeyProvider);
    return [Object.freeze({
      id: "sqlite",
      label: "本地状态",
      status: activeCount > 0 ? "pass" : "warning",
      summary: `schema ${schema} 完整；Provider ${providerCount} 个，活动 ${activeCount} 个；Project 加密凭据 ${credentialCount} 个；需重新录入 ${reentryCount} 个。`,
      ...(activeCount === 0 ? { remediation: "请配置并激活 Provider。" } : {}),
    }), credentialCheck];
  } catch (error) {
    if (error instanceof AlphionError && error.code === "incompatible-schema") {
      return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: error.message, remediation: "请使用兼容版本的 Alphion。" })];
    }
    return [Object.freeze({ id: "sqlite", label: "本地状态", status: "fail", summary: "SQLite 数据库无法以只读方式验证。", remediation: "请保留并备份 .alphion 后按数据库 Runbook 检查；这与原生 ABI 错误不同。" })];
  } finally {
    database?.close();
  }
}

async function projectCredentialCheck(projectId: string, secretCount: number, provider: ProjectKeyProvider): Promise<DiagnosticCheck> {
  if (secretCount === 0) return Object.freeze({ id: "project-credentials", label: "Project 凭据", status: "pass", summary: "尚未保存加密凭据；首次导入时自动创建 Project 独立密钥。" });
  try {
    const key = await provider.load(projectId);
    if (!key || key.byteLength !== 32) return Object.freeze({ id: "project-credentials", label: "Project 凭据", status: "fail", summary: "Project 密钥不可用。", remediation: "请保留数据库并为受影响的 Provider 重新录入 API Key。" });
    key.fill(0);
    return Object.freeze({ id: "project-credentials", label: "Project 凭据", status: "pass", summary: `Project 密钥可用；已保护 ${secretCount} 个 Provider 凭据。` });
  } catch (error) {
    const corrupt = error instanceof AlphionError && error.reason === "project-key-corrupt";
    return Object.freeze({ id: "project-credentials", label: "Project 凭据", status: "fail", summary: corrupt ? "Project 密钥损坏。" : "Project 密钥不可用。", remediation: "不要删除 SQLite；保留状态并为受影响的 Provider 重新录入 API Key。" });
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
