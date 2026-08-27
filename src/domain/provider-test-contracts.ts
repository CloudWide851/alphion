import type { ProviderUsage } from "./contracts.js";

export interface ProviderTestResult {
  readonly schemaVersion: 1;
  readonly profileId: string;
  readonly profileName: string;
  readonly model: string;
  readonly status: "success" | "failed";
  readonly latencyMs: number;
  readonly usage: ProviderUsage;
  readonly response?: string;
  readonly errorCode?: string;
  readonly errorReason?: string;
}
