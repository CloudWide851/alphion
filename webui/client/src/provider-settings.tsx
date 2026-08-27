import React, { useState } from "react";
import type { SurfaceClient } from "./surface-client.js";

export interface ProviderSettingsItem {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly contextWindowTokens?: number;
  readonly capabilities?: Readonly<{ readonly vision?: boolean }>;
}

export function ProviderSettings(props: Readonly<{ client: SurfaceClient; profiles: readonly ProviderSettingsItem[]; onDiagnostic: (value: string) => void }>): React.JSX.Element {
  if (props.profiles.length === 0) return <p className="muted">尚未配置 Provider。</p>;
  return <div className="provider-settings">{props.profiles.map((profile) => <ProviderRow key={profile.id} client={props.client} profile={profile} onDiagnostic={props.onDiagnostic} />)}</div>;
}

function ProviderRow(props: Readonly<{ client: SurfaceClient; profile: ProviderSettingsItem; onDiagnostic: (value: string) => void }>): React.JSX.Element {
  const [context, setContext] = useState(String(props.profile.contextWindowTokens ?? 32_768));
  const [vision, setVision] = useState(props.profile.capabilities?.vision ?? false);
  const save = async () => {
    const contextWindowTokens = Number(context);
    if (!Number.isSafeInteger(contextWindowTokens) || contextWindowTokens < 4_096 || contextWindowTokens > 4_194_304) { props.onDiagnostic("上下文窗口必须为 4096–4194304 的整数"); return; }
    const result = await props.client.execute({ kind: "provider.configure", profileId: props.profile.id, contextWindowTokens, vision });
    props.onDiagnostic(`已保存 ${props.profile.name}\n${JSON.stringify(result.result, null, 2)}`);
  };
  return <div className="provider-row"><strong>{props.profile.name}</strong><small>{props.profile.model}</small><label>上下文 <input type="number" min={4096} max={4194304} value={context} onChange={(event) => setContext(event.target.value)} /></label><label><input type="checkbox" checked={vision} onChange={(event) => setVision(event.target.checked)} /> 支持图片</label><button onClick={() => void save()}>保存</button><button onClick={() => void props.client.execute({ kind: "provider.test", profileId: props.profile.id }).then((result) => props.onDiagnostic(JSON.stringify(result.result, null, 2)))}>实测</button></div>;
}
