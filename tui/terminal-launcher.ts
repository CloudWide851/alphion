import { spawn, type SpawnOptions } from "node:child_process";

export interface TerminalLaunchReceipt {
  readonly launched: boolean;
  readonly sessionId: string;
  readonly manualCommand: readonly string[];
  readonly terminal?: string;
  readonly error?: string;
}

export interface TerminalLauncher {
  launchSession(sessionId: string): Promise<TerminalLaunchReceipt>;
}

export type TerminalCandidate = Readonly<{ executable: string; args: readonly string[] }>;
export type TerminalCandidateRunner = (candidate: TerminalCandidate) => Promise<void>;

export class PlatformTerminalLauncher implements TerminalLauncher {
  constructor(private readonly executable = resolveAlphionExecutable(), private readonly platform = process.platform, private readonly runCandidate: TerminalCandidateRunner = spawnCandidate) {}
  async launchSession(sessionId: string): Promise<TerminalLaunchReceipt> {
    const manualCommand = Object.freeze([this.executable, "tui", "--session", sessionId]);
    const candidates = terminalCandidates(this.platform, manualCommand);
    for (const candidate of candidates) {
      try {
        await this.runCandidate(candidate);
        return Object.freeze({ launched: true, sessionId, manualCommand, terminal: candidate.executable });
      } catch { /* Try the next argv-only terminal candidate. */ }
    }
    return Object.freeze({ launched: false, sessionId, manualCommand, error: "No supported terminal could be launched." });
  }
}

export function terminalCandidates(platform: NodeJS.Platform, command: readonly string[]): readonly TerminalCandidate[] {
  if (platform === "win32") return Object.freeze([
    Object.freeze({ executable: "wt.exe", args: Object.freeze(["new-tab", "--", ...command]) }),
    Object.freeze({ executable: "cmd.exe", args: Object.freeze(["/d", "/c", "start", "", command[0]!, ...command.slice(1)]) }),
  ]);
  if (platform === "darwin") return Object.freeze([Object.freeze({ executable: "open", args: Object.freeze(["-a", "Terminal", command[0]!, "--args", ...command.slice(1)]) })]);
  return Object.freeze([
    Object.freeze({ executable: "x-terminal-emulator", args: Object.freeze(["-e", ...command]) }),
    Object.freeze({ executable: "gnome-terminal", args: Object.freeze(["--", ...command]) }),
    Object.freeze({ executable: "konsole", args: Object.freeze(["-e", ...command]) }),
  ]);
}

function resolveAlphionExecutable(): string { return process.env.ALPHION_EXECUTABLE?.trim() || (process.platform === "win32" ? "alphion.cmd" : "alphion"); }
function detachedOptions(): SpawnOptions { return { detached: true, windowsHide: false, stdio: "ignore", shell: false }; }
async function spawnCandidate(candidate: TerminalCandidate): Promise<void> {
  const child = spawn(candidate.executable, candidate.args, detachedOptions());
  await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  child.unref();
}
