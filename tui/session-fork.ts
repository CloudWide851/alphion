import type { AgentSessionContract, SessionForkReceipt } from "../src/index.js";
import type { TerminalLauncher } from "./terminal-launcher.js";

export interface TuiForkOutcome {
  readonly receipt: SessionForkReceipt;
  readonly message: string;
}

export async function forkTuiSession(session: AgentSessionContract, title: string | undefined, launcher: TerminalLauncher, idempotencyKey = `tui:fork:${Date.now()}`): Promise<TuiForkOutcome> {
  const record = await session.get();
  if (record.status !== "idle") throw new Error("仅空闲会话可 fork。");
  const receipt = await session.fork({ ...(title ? { title } : {}), expectedRevision: record.revision, idempotencyKey });
  const launched = await launcher.launchSession(receipt.session.id);
  const message = launched.launched
    ? `已 fork ${receipt.session.id} 并打开新终端。`
    : `Fork 已完成；终端启动失败。Session ${receipt.session.id}，手动运行：${launched.manualCommand.join(" ")}`;
  return Object.freeze({ receipt, message });
}
