export type AlphionErrorCode =
  | "validation"
  | "forbidden"
  | "conflict"
  | "dependency-unavailable"
  | "budget-exceeded"
  | "timeout"
  | "cancelled"
  | "incompatible-schema"
  | "integrity-failed"
  | "internal";

export class AlphionError extends Error {
  readonly code: AlphionErrorCode;
  readonly retryable: boolean;
  readonly stage: string;
  readonly reason: string | undefined;

  constructor(
    code: AlphionErrorCode,
    message: string,
    options: Readonly<{ retryable?: boolean; stage?: string; reason?: string; cause?: unknown }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "AlphionError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.stage = options.stage ?? "unknown";
    this.reason = options.reason;
  }
}

export function normalizeError(error: unknown, stage: string): AlphionError {
  if (error instanceof AlphionError) {
    return error;
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return new AlphionError("timeout", "The operation timed out.", { stage, cause: error });
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new AlphionError("cancelled", "The operation was cancelled.", { stage, cause: error });
  }
  return new AlphionError("internal", error instanceof Error ? error.message : "Unknown failure.", {
    stage,
    cause: error,
  });
}
