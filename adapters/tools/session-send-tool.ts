import { AlphionError } from "../../src/application/errors.js";
import type { ToolExecutor } from "../../src/ports/index.js";

export class SessionSendTool implements ToolExecutor {
  readonly contract = Object.freeze({
    name: "session.send",
    description: "Send one bounded collaboration message to another Session in the same Project domain.",
    inputSchema: Object.freeze({
      type: "object",
      properties: Object.freeze({
        targetSessionId: Object.freeze({ type: "string", minLength: 1, maxLength: 200 }),
        content: Object.freeze({ type: "string", minLength: 1, maxLength: 16_384 }),
        idempotencyKey: Object.freeze({ type: "string", pattern: "^[A-Za-z0-9._:-]{8,200}$" }),
      }),
      required: Object.freeze(["targetSessionId", "content", "idempotencyKey"]),
      additionalProperties: false,
    }),
    risk: "read",
    cachePolicy: "none",
    executionMode: "serial",
    sideEffect: "write",
    idempotent: true,
    approval: "never",
    timeoutMs: 10_000,
  } as const);

  async execute(input: Readonly<Record<string, unknown>>, context: Parameters<ToolExecutor["execute"]>[1]) {
    if (!context.sendSessionMessage) throw new AlphionError("forbidden", "Session collaboration is unavailable for this Run.", { stage: "tool:session.send" });
    const targetSessionId = requiredText(input.targetSessionId, "targetSessionId", 200);
    const content = requiredText(input.content, "content", 16_384);
    const idempotencyKey = requiredText(input.idempotencyKey, "idempotencyKey", 200);
    const receipt = await context.sendSessionMessage(targetSessionId, content, idempotencyKey);
    return { content: `Delivered collaboration message ${receipt.messageId} to ${receipt.targetSessionId} as ${receipt.delivery}.`, isError: false };
  }
}

function requiredText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) throw new AlphionError("validation", `${label} is invalid.`, { stage: "tool:session.send" });
  return value.trim();
}
