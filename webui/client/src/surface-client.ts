import type { DesktopApprovalDecision } from "../../../desktop/contracts.js";
import type { UiCommand, UiCommandResult, UiEventFrame } from "../../../ui/contracts.js";

export interface SurfaceClient {
  readonly ready: boolean;
  execute(command: UiCommand): Promise<UiCommandResult>;
  subscribe(listener: (frame: UiEventFrame) => void): () => void;
  importProviderCredential(profileId: string, secret: string): Promise<void>;
  decideApproval(decision: DesktopApprovalDecision): Promise<void>;
}
