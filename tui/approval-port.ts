import type { ApprovalDecision, ApprovalPort, ApprovalRequest } from "../src/ports/index.js";

export interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly decide: (approved: boolean) => void;
}

export class TuiApprovalPort implements ApprovalPort {
  readonly revision = "tui-per-call-approval-v1";
  #listener: ((pending: PendingApproval | undefined) => void) | undefined;
  #pendingReject: ((reason: unknown) => void) | undefined;

  subscribe(listener: (pending: PendingApproval | undefined) => void): () => void {
    this.#listener = listener;
    return () => {
      if (this.#listener === listener) this.#listener = undefined;
    };
  }

  async requestApproval(request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalDecision> {
    if (this.#pendingReject) return { approved: false, reason: "Another approval is already pending." };
    return new Promise<ApprovalDecision>((resolve, reject) => {
      let settled = false;
      const finish = (approved: boolean) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", abort);
        this.#pendingReject = undefined;
        this.#listener?.(undefined);
        resolve({
          approved,
          reason: approved ? "Approved in the TUI for this exact invocation." : "Declined in the TUI.",
        });
      };
      const abort = () => {
        if (settled) return;
        settled = true;
        this.#pendingReject = undefined;
        this.#listener?.(undefined);
        reject(signal.reason ?? new DOMException("Cancelled.", "AbortError"));
      };
      this.#pendingReject = reject;
      if (signal.aborted) abort();
      else {
        signal.addEventListener("abort", abort, { once: true });
        this.#listener?.({ request, decide: finish });
      }
    });
  }
}
