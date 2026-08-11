import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Box, Text, render, useApp, useInput } from "ink";
import {
  DEEPSEEK_DEFAULT_BASE_URL,
  DEEPSEEK_MODELS,
} from "../adapters/model/deepseek.js";
import { openLocalAlphionApplication } from "../adapters/local/local-application.js";
import type { ProviderProfile, ProviderProfileInput } from "../src/domain/contracts.js";
import type { AgentApplication, AgentRunHandle } from "../src/ports/index.js";
import { TuiApprovalPort, type PendingApproval } from "./approval-port.js";
import { EMPTY_RUN_PROJECTION, reduceRunProjection, sanitizeTerminalText } from "./run-projection.js";

export interface RunTuiOptions {
  readonly projectRoot: string;
  readonly statePath?: string;
}

type Screen = "loading" | "vault-setup" | "vault-unlock" | "providers" | "provider-form" | "credential" | "prompt" | "run";

interface ProviderDraft {
  readonly existing?: ProviderProfile;
  readonly name: string;
  readonly model: string;
  readonly baseUrl: string;
}

export async function runTui(options: RunTuiOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return 1;
  const application = await openLocalAlphionApplication(options);
  try {
    const instance = render(<AlphionTui application={application} projectRoot={options.projectRoot} />, {
      exitOnCtrlC: false,
    });
    await instance.waitUntilExit();
    return 0;
  } finally {
    application.close();
  }
}

function AlphionTui({ application, projectRoot }: Readonly<{ application: AgentApplication; projectRoot: string }>): React.JSX.Element {
  const { exit } = useApp();
  const [screen, setScreen] = useState<Screen>("loading");
  const [profiles, setProfiles] = useState<readonly ProviderProfile[]>([]);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState<ProviderDraft>({ name: "DeepSeek", model: DEEPSEEK_MODELS[0], baseUrl: DEEPSEEK_DEFAULT_BASE_URL });
  const [runPrompt, setRunPrompt] = useState("");
  const [runProviderId, setRunProviderId] = useState<string | undefined>();
  const approval = useMemo(() => new TuiApprovalPort(), []);

  useInput((input, key) => {
    if (key.ctrl && input === "c" && screen !== "run") exit();
  });

  const refresh = useCallback(async () => {
    const nextProfiles = await application.configuration.listProfiles();
    setProfiles(nextProfiles);
    setSelected((value) => Math.min(value, Math.max(0, nextProfiles.length - 1)));
    return nextProfiles;
  }, [application]);

  useEffect(() => {
    void (async () => {
      try {
        const [vault] = await Promise.all([application.configuration.vaultStatus(), refresh()]);
        setScreen(!vault.initialized ? "vault-setup" : vault.locked ? "vault-unlock" : "providers");
      } catch (cause) {
        setError(safeError(cause));
        setScreen("providers");
      }
    })();
  }, [application, refresh]);

  const current = profiles[selected];
  const runTask = (prompt: string) => {
    setRunPrompt(prompt);
    setRunProviderId(current?.id);
    setScreen("run");
  };

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">ALPHION v0.3.0</Text>
      <Text dimColor>Evidence-grounded local Agent · {sanitizeTerminalText(projectRoot)}</Text>
      {error ? <Text color="red">{sanitizeTerminalText(error)}</Text> : null}
      {screen === "loading" ? <Text>Loading local state…</Text> : null}
      {screen === "vault-setup" ? (
        <VaultSetup
          onComplete={async (password) => {
            await application.configuration.initializeVault(password);
            setError("");
            setScreen("providers");
          }}
          onError={(cause) => setError(safeError(cause))}
        />
      ) : null}
      {screen === "vault-unlock" ? (
        <TextEntry
          label="Master password"
          masked
          onSubmit={(password) => void application.configuration.unlockVault(password)
            .then(() => { setError(""); setScreen("providers"); })
            .catch((cause: unknown) => setError(safeError(cause)))}
          onCancel={() => exit()}
        />
      ) : null}
      {screen === "providers" ? (
        <ProviderList
          profiles={profiles}
          selected={selected}
          onSelected={setSelected}
          onNew={() => {
            setDraft({ name: "DeepSeek", model: DEEPSEEK_MODELS[0], baseUrl: DEEPSEEK_DEFAULT_BASE_URL });
            setScreen("provider-form");
          }}
          onEdit={() => {
            if (!current) return;
            setDraft({ existing: current, name: current.name, model: current.model, baseUrl: current.baseUrl });
            setScreen("provider-form");
          }}
          onActivate={() => current && void application.configuration.activateProfile(current.id)
            .then(() => refresh())
            .catch((cause: unknown) => setError(safeError(cause)))}
          onCredential={() => current && setScreen("credential")}
          onRemoveCredential={() => current && void application.configuration.removeCredential(current.id)
            .then(() => refresh())
            .catch((cause: unknown) => setError(safeError(cause)))}
          onRun={() => current && setScreen("prompt")}
          onLock={() => { application.configuration.lockVault(); setScreen("vault-unlock"); }}
          onExit={() => exit()}
        />
      ) : null}
      {screen === "provider-form" ? (
        <ProviderForm
          draft={draft}
          onSave={(value) => void application.configuration.upsertProfile(toProfileInput(value, profiles.length === 0))
            .then(async () => { await refresh(); setError(""); setScreen("providers"); })
            .catch((cause: unknown) => setError(safeError(cause)))}
          onCancel={() => setScreen("providers")}
        />
      ) : null}
      {screen === "credential" && current ? (
        <TextEntry
          label={`API key for ${current.name}`}
          masked
          onSubmit={(value) => void application.configuration.importCredential(current.id, value)
            .then(async () => { await refresh(); setError(""); setScreen("providers"); })
            .catch((cause: unknown) => setError(safeError(cause)))}
          onCancel={() => setScreen("providers")}
        />
      ) : null}
      {screen === "prompt" ? (
        <TextEntry label="Task" onSubmit={runTask} onCancel={() => setScreen("providers")} />
      ) : null}
      {screen === "run" ? (
        <RunView
          application={application}
          approval={approval}
          projectRoot={projectRoot}
          prompt={runPrompt}
          {...(runProviderId ? { providerId: runProviderId } : {})}
          onDone={() => { setRunPrompt(""); setScreen("providers"); }}
          onExit={() => exit()}
        />
      ) : null}
    </Box>
  );
}

export function ProviderList(props: Readonly<{
  profiles: readonly ProviderProfile[];
  selected: number;
  onSelected: (index: number) => void;
  onNew: () => void;
  onEdit: () => void;
  onActivate: () => void;
  onCredential: () => void;
  onRemoveCredential: () => void;
  onRun: () => void;
  onLock: () => void;
  onExit: () => void;
}>): React.JSX.Element {
  useInput((input, key) => {
    if (key.upArrow) props.onSelected(Math.max(0, props.selected - 1));
    else if (key.downArrow) props.onSelected(Math.min(props.profiles.length - 1, props.selected + 1));
    else if (input === "n") props.onNew();
    else if (input === "e" && props.profiles.length > 0) props.onEdit();
    else if (input === "a" && props.profiles.length > 0) props.onActivate();
    else if (input === "k" && props.profiles.length > 0) props.onCredential();
    else if (input === "x" && props.profiles.length > 0) props.onRemoveCredential();
    else if ((input === "r" || key.return) && props.profiles.length > 0) props.onRun();
    else if (input === "l") props.onLock();
    else if (input === "q") props.onExit();
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Providers</Text>
      {props.profiles.length === 0 ? <Text dimColor>No profiles. Press n to add DeepSeek.</Text> : null}
      {props.profiles.map((profile, index) => (
        <Text key={profile.id} {...(index === props.selected ? { color: "cyan" as const } : {})}>
          {index === props.selected ? "›" : " "} {profile.active ? "●" : "○"} {profile.name} · {profile.kind} · {profile.model} · {authLabel(profile)}
        </Text>
      ))}
      <Text dimColor>↑/↓ select · n new · e edit · a activate · k import/rotate key · x remove key · r run · l lock · q quit</Text>
    </Box>
  );
}

function VaultSetup(props: Readonly<{
  onComplete: (password: string) => Promise<void>;
  onError: (cause: unknown) => void;
}>): React.JSX.Element {
  const [first, setFirst] = useState<string | undefined>();
  return first === undefined ? (
    <TextEntry label="Create master password (12+ characters)" masked onSubmit={setFirst} />
  ) : (
    <TextEntry
      label="Confirm master password"
      masked
      onSubmit={(second) => {
        if (second !== first) { props.onError(new Error("Master passwords do not match.")); setFirst(undefined); return; }
        void props.onComplete(first).catch(props.onError);
      }}
      onCancel={() => setFirst(undefined)}
    />
  );
}

function ProviderForm(props: Readonly<{
  draft: ProviderDraft;
  onSave: (draft: ProviderDraft) => void;
  onCancel: () => void;
}>): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [value, setValue] = useState(props.draft);
  if (step === 0) {
    return <TextEntry label="Profile name" initialValue={value.name} onSubmit={(name) => { setValue({ ...value, name }); setStep(1); }} onCancel={props.onCancel} />;
  }
  if (step === 1) {
    return <TextEntry label="Model" initialValue={value.model} onSubmit={(model) => { setValue({ ...value, model }); setStep(2); }} onCancel={() => setStep(0)} />;
  }
  return <TextEntry label="Base URL" initialValue={value.baseUrl} onSubmit={(baseUrl) => props.onSave({ ...value, baseUrl })} onCancel={() => setStep(1)} />;
}

export function TextEntry(props: Readonly<{
  label: string;
  initialValue?: string;
  masked?: boolean;
  onSubmit: (value: string) => void;
  onCancel?: () => void;
}>): React.JSX.Element {
  const [value, setValue] = useState(props.initialValue ?? "");
  useInput((input, key) => {
    if (key.return) { if (value.length > 0) props.onSubmit(value); return; }
    if (key.escape) { props.onCancel?.(); return; }
    if (key.backspace || key.delete) { setValue((current) => current.slice(0, -1)); return; }
    if (!key.ctrl && !key.meta && input) setValue((current) => current + input);
  });
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>{props.label}</Text>
      <Text color="cyan">› {props.masked ? "•".repeat(value.length) : sanitizeTerminalText(value)}</Text>
      <Text dimColor>Enter confirm · Esc back</Text>
    </Box>
  );
}

function RunView(props: Readonly<{
  application: AgentApplication;
  approval: TuiApprovalPort;
  projectRoot: string;
  prompt: string;
  providerId?: string;
  onDone: () => void;
  onExit: () => void;
}>): React.JSX.Element {
  const [projection, dispatch] = useReducer(reduceRunProjection, EMPTY_RUN_PROJECTION);
  const [showReasoning, setShowReasoning] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<PendingApproval | undefined>();
  const handle = useRef<AgentRunHandle | undefined>(undefined);
  const started = useRef(false);

  useEffect(() => props.approval.subscribe(setPendingApproval), [props.approval]);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    dispatch({ type: "reset" });
    let active = true;
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let answerBuffer = "";
    let reasoningBuffer = "";
    let lastFlush = Date.now();
    const flush = () => {
      if (flushTimer) clearTimeout(flushTimer);
      flushTimer = undefined;
      if (!active) return;
      if (answerBuffer) { dispatch({ type: "answer-delta", delta: answerBuffer }); answerBuffer = ""; }
      if (reasoningBuffer) { dispatch({ type: "reasoning-delta", delta: reasoningBuffer }); reasoningBuffer = ""; }
      lastFlush = Date.now();
    };
    const scheduleFlush = () => {
      if (!active || flushTimer) return;
      flushTimer = setTimeout(flush, Math.max(0, 33 - (Date.now() - lastFlush)));
    };
    void props.application.startRun(
      {
        prompt: props.prompt,
        projectRoot: props.projectRoot,
        ...(props.providerId ? { providerId: props.providerId } : {}),
      },
      props.approval,
    ).then(async (runHandle) => {
      handle.current = runHandle;
      for await (const event of runHandle.events) {
        if (event.kind === "model.delta" && typeof event.payload.delta === "string") {
          answerBuffer += event.payload.delta;
          scheduleFlush();
        } else if (event.kind === "model.reasoning.delta" && typeof event.payload.delta === "string") {
          reasoningBuffer += event.payload.delta;
          scheduleFlush();
        }
        else { flush(); dispatch({ type: "event", event }); }
      }
      flush();
      await runHandle.result;
    }).catch((cause: unknown) => {
      if (active) dispatch({ type: "run-error", message: safeError(cause) });
    });
    return () => {
      active = false;
      if (flushTimer) clearTimeout(flushTimer);
      handle.current?.cancel("TUI view closed.");
    };
  }, [props.application, props.approval, props.projectRoot, props.prompt, props.providerId]);

  useInput((input, key) => {
    if (pendingApproval && (input === "y" || input === "n")) pendingApproval.decide(input === "y");
    else if (input === "t") setShowReasoning((value) => !value);
    else if (key.ctrl && input === "c") {
      if (projection.status === "running") handle.current?.cancel("Cancelled from TUI.");
      else props.onExit();
    }
    else if (key.return && projection.status !== "running") props.onDone();
  });

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>Run · {projection.status}</Text>
      {projection.reasoning ? (
        <Box flexDirection="column">
          <Text color="yellow">Model reasoning (not evidence) · {showReasoning ? "press t to collapse" : "press t to expand"}</Text>
          {showReasoning ? <Text dimColor>{projection.reasoning}</Text> : <Text dimColor>[collapsed · {projection.reasoning.length} characters]</Text>}
        </Box>
      ) : null}
      <Text>{projection.answer || "Waiting for model output…"}</Text>
      <Text dimColor>tokens in={projection.inputTokens} out={projection.outputTokens} cached={projection.cachedInputTokens}</Text>
      {projection.message ? (
        <Text {...(projection.status === "failed" ? { color: "red" as const } : {})}>{projection.message}</Text>
      ) : null}
      {pendingApproval ? (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
          <Text bold>Approval required: {sanitizeTerminalText(pendingApproval.request.toolName)}</Text>
          <Text>{sanitizeTerminalText(pendingApproval.request.summary)}</Text>
          <Text>y approve exact action · n deny</Text>
        </Box>
      ) : null}
      <Text dimColor>{projection.status === "running" ? "Ctrl+C cancel · t reasoning" : "Enter return to providers"}</Text>
    </Box>
  );
}

function toProfileInput(draft: ProviderDraft, firstProfile: boolean): ProviderProfileInput {
  const existing = draft.existing;
  const kind = existing?.kind ?? "deepseek";
  const id = existing?.id ?? toProfileId(draft.name);
  return {
    schemaVersion: 2,
    id,
    name: draft.name.trim(),
    kind,
    baseUrl: draft.baseUrl.trim(),
    model: draft.model.trim(),
    protocol: kind === "deepseek" ? "chat-completions" : existing?.protocol ?? "chat-completions",
    auth: existing?.auth ?? { mode: "none" },
    capabilities: {
      streaming: existing?.capabilities.streaming ?? true,
      tools: existing?.capabilities.tools ?? true,
      promptCaching: existing?.capabilities.promptCaching ?? false,
      reasoning: kind === "deepseek" && draft.model.trim() === "deepseek-reasoner",
    },
    active: existing?.active ?? firstProfile,
  };
}

function toProfileId(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized || "deepseek";
}

function authLabel(profile: ProviderProfile): string {
  if (profile.auth.mode === "encrypted-sqlite") return "encrypted key";
  if (profile.auth.mode === "bearer-env") return `env:${profile.auth.environmentVariable}`;
  return "no key";
}

function safeError(value: unknown): string {
  return sanitizeTerminalText(value instanceof Error ? value.message : "Unexpected TUI failure.");
}
