import type { UiCommandResult } from "./contracts.js";

export interface SurfaceSession {
  readonly id: string;
  readonly title: string;
  readonly revision: number;
  readonly status: string;
}

export async function forkAndSelectSession(
  execute: (command: Readonly<{ kind: "session.fork"; sessionId: string; title: string; expectedRevision: number; idempotencyKey: string }>) => Promise<UiCommandResult>,
  session: SurfaceSession,
  idempotencyKey: string,
  select: (sessionId: string) => Promise<void>,
): Promise<SurfaceSession> {
  if (session.status !== "idle") throw new Error("Only an idle Session can be forked.");
  const result = await execute({ kind: "session.fork", sessionId: session.id, title: `${session.title}（分支）`, expectedRevision: session.revision, idempotencyKey });
  const forked = (result.result as { session?: SurfaceSession }).session;
  if (!forked?.id) throw new Error("Fork response did not contain a Session.");
  await select(forked.id);
  return forked;
}
