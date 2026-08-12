import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentApplication, ProjectManager } from "../../src/ports/index.js";
import type { ProjectRecord } from "../../src/domain/contracts.js";
import { AlphionError } from "../../src/application/errors.js";
import { openLocalAlphionApplication } from "../local/local-application.js";
import { defaultProjectRegistryPath, LocalProjectManager } from "./project-manager.js";

export interface ActiveProjectSnapshot {
  readonly project?: ProjectRecord;
  readonly domain: "project" | "unowned";
  readonly application: AgentApplication;
}

/** Owns the sole open Project application/SQLite writer for a process. */
export class ActiveProjectController {
  readonly projects: ProjectManager;
  #active: ActiveProjectSnapshot | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(projects: ProjectManager = new LocalProjectManager(), private readonly configRoot?: string) { this.projects = projects; }

  current(): ActiveProjectSnapshot | undefined { return this.#active; }

  async openCurrentOrDefault(): Promise<ActiveProjectSnapshot> {
    return this.#switch(await this.projects.current());
  }

  async activate(projectId: string): Promise<ActiveProjectSnapshot> {
    return this.#switch(await this.projects.activate(projectId));
  }

  async openUnowned(): Promise<ActiveProjectSnapshot> { return this.#switch(undefined); }

  async close(): Promise<void> {
    await this.#serialize(async () => {
      const active = this.#active;
      this.#active = undefined;
      await active?.application.close();
    });
  }

  async #switch(project: ProjectRecord | undefined): Promise<ActiveProjectSnapshot> {
    let snapshot: ActiveProjectSnapshot | undefined;
    await this.#serialize(async () => {
      const previous = this.#active;
      this.#active = undefined;
      await previous?.application.close();
      if (project) {
        const application = await openLocalAlphionApplication({ projectRoot: project.root, statePath: project.statePath, projectId: project.id, domainId: project.domainId });
        snapshot = Object.freeze({ project, domain: "project" as const, application });
      } else {
        const configRoot = this.configRoot ?? dirname(defaultProjectRegistryPath());
        const domainRoot = join(configRoot, "unowned");
        await mkdir(domainRoot, { recursive: true });
        const application = await openLocalAlphionApplication({ projectRoot: domainRoot, statePath: join(configRoot, "default.sqlite3"), domainId: "domain_unowned", unowned: true });
        snapshot = Object.freeze({ domain: "unowned" as const, application });
      }
      this.#active = snapshot;
    });
    if (!snapshot) throw new AlphionError("internal", "Active Project switch did not produce an application.", { stage: "project" });
    return snapshot;
  }

  async #serialize(operation: () => Promise<void>): Promise<void> {
    const task = this.#tail.then(operation, operation);
    this.#tail = task.catch(() => undefined);
    await task;
  }
}
