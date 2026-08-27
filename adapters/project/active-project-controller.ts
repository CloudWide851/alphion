import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentApplication, ProjectManager } from "../../src/ports/index.js";
import type { ProjectRecord } from "../../src/domain/contracts.js";
import { AlphionError } from "../../src/application/errors.js";
import { openLocalAlphionApplication } from "../local/local-application.js";
import { defaultProjectRegistryPath, LocalProjectManager } from "./project-manager.js";

const DEFAULT_MAX_OPEN_PROJECTS = 8;

export interface ActiveProjectSnapshot {
  readonly project?: ProjectRecord;
  readonly domain: "project" | "unowned";
  readonly application: AgentApplication;
}

export interface BackgroundRunSummary {
  readonly projectId: string;
  readonly projectName: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly title: string;
  readonly updatedAt: string;
}

/** Owns one selected Project and a bounded set of busy background applications. */
export class WorkspaceController {
  readonly projects: ProjectManager;
  #active: ActiveProjectSnapshot | undefined;
  readonly #background = new Map<string, ActiveProjectSnapshot>();
  readonly #stateOverrides = new Map<string, string>();
  readonly #watching = new Set<string>();
  #tail: Promise<void> = Promise.resolve();

  constructor(projects: ProjectManager = new LocalProjectManager(), private readonly configRoot?: string, private readonly maxOpenProjects = DEFAULT_MAX_OPEN_PROJECTS, private readonly openApplication: (options: Parameters<typeof openLocalAlphionApplication>[0]) => Promise<AgentApplication> = openLocalAlphionApplication) {
    if (!Number.isSafeInteger(maxOpenProjects) || maxOpenProjects < 1 || maxOpenProjects > 32) throw new AlphionError("validation", "Workspace open Project limit must be between 1 and 32.", { stage: "project" });
    this.projects = projects;
  }

  current(): ActiveProjectSnapshot | undefined { return this.#active; }

  openApplications(): readonly ActiveProjectSnapshot[] {
    return Object.freeze([...(this.#active ? [this.#active] : []), ...this.#background.values()]);
  }

  async openCurrentOrDefault(): Promise<ActiveProjectSnapshot> {
    return this.#switch(await this.projects.current());
  }

  async activate(projectId: string): Promise<ActiveProjectSnapshot> {
    return this.#switch(await this.projects.activate(projectId));
  }

  async openProject(input: Readonly<{ root: string; name?: string; create?: boolean; statePath?: string }>): Promise<ActiveProjectSnapshot> {
    const project = await this.projects.open(input);
    if (input.statePath) this.#stateOverrides.set(project.id, input.statePath);
    return this.#switch(project);
  }

  async openUnowned(): Promise<ActiveProjectSnapshot> { return this.#switch(undefined); }

  async close(): Promise<void> {
    await this.#serialize(async () => {
      const active = this.#active;
      this.#active = undefined;
      const applications = [...this.#background.values(), ...(active ? [active] : [])];
      this.#background.clear();
      this.#watching.clear();
      await Promise.allSettled(applications.map((item) => item.application.close()));
    });
  }

  async backgroundRuns(): Promise<readonly BackgroundRunSummary[]> {
    const summaries = await Promise.all([...this.#background.values()].map(async (snapshot) => {
      if (!snapshot.project) return [];
      const sessions = await snapshot.application.sessions.list().catch(() => []);
      return sessions.filter((session) => session.status === "running" && session.activeRunId).map((session) => Object.freeze({
        projectId: snapshot.project!.id,
        projectName: snapshot.project!.name,
        sessionId: session.id,
        runId: session.activeRunId!,
        title: session.title,
        updatedAt: session.updatedAt,
      }));
    }));
    return Object.freeze(summaries.flat().sort((left, right) => left.projectName.localeCompare(right.projectName) || left.sessionId.localeCompare(right.sessionId)));
  }

  async #switch(project: ProjectRecord | undefined): Promise<ActiveProjectSnapshot> {
    let snapshot: ActiveProjectSnapshot | undefined;
    await this.#serialize(async () => {
      const previous = this.#active;
      const targetKey = workspaceKey(project);
      if (previous && workspaceKey(previous.project) === targetKey) { snapshot = previous; return; }
      const previousBusy = previous ? await hasActiveWork(previous.application) : false;
      const retained = this.#background.get(targetKey);
      const projectedCount = this.#background.size + (previousBusy ? 1 : 0) + (retained ? 0 : 1);
      if (projectedCount > this.maxOpenProjects) throw new AlphionError("conflict", "Workspace open Project limit was reached while background Runs are active.", { stage: "project" });
      snapshot = retained ?? await this.#open(project);
      if (retained) this.#background.delete(targetKey);
      if (previous) {
        previous.application.schedules.suspend();
        if (previousBusy) { const key = workspaceKey(previous.project); this.#background.set(key, previous); this.#watch(key, previous); }
        else await previous.application.close();
      }
      this.#active = snapshot;
      snapshot.application.schedules.start();
    });
    if (!snapshot) throw new AlphionError("internal", "Active Project switch did not produce an application.", { stage: "project" });
    return snapshot;
  }

  async #open(project: ProjectRecord | undefined): Promise<ActiveProjectSnapshot> {
    if (project) {
      const application = await this.openApplication({ projectRoot: project.root, statePath: this.#stateOverrides.get(project.id) ?? project.statePath, projectId: project.id, domainId: project.domainId });
      return Object.freeze({ project, domain: "project" as const, application });
    }
    const configRoot = this.configRoot ?? dirname(defaultProjectRegistryPath());
    const domainRoot = join(configRoot, "unowned");
    await mkdir(domainRoot, { recursive: true });
    const application = await this.openApplication({ projectRoot: domainRoot, statePath: join(configRoot, "default.sqlite3"), domainId: "domain_unowned", unowned: true });
    return Object.freeze({ domain: "unowned" as const, application });
  }

  #watch(key: string, snapshot: ActiveProjectSnapshot): void {
    if (this.#watching.has(key)) return;
    this.#watching.add(key);
    void (async () => {
      try {
        while (this.#background.get(key) === snapshot) {
          await delay(250);
          if (await this.#evictIfIdle(key, snapshot)) return;
        }
      } finally { this.#watching.delete(key); }
    })();
  }

  async #evictIfIdle(key: string, snapshot: ActiveProjectSnapshot): Promise<boolean> {
    let evicted = false;
    await this.#serialize(async () => {
      if (this.#background.get(key) !== snapshot || await hasActiveWork(snapshot.application)) return;
      this.#background.delete(key);
      await snapshot.application.close();
      evicted = true;
    });
    return evicted;
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.catch(() => undefined);
    await task;
  }
}

/** @deprecated Use WorkspaceController. */
export class ActiveProjectController extends WorkspaceController {}

function workspaceKey(project: ProjectRecord | undefined): string { return project?.id ?? "domain_unowned"; }
async function hasActiveWork(application: AgentApplication): Promise<boolean> { try { return await application.sessions.hasActiveWork(); } catch { return true; } }
function delay(milliseconds: number): Promise<void> { return new Promise((resolveValue) => { const timer = setTimeout(resolveValue, milliseconds); timer.unref(); }); }
