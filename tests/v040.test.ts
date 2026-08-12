import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openSqliteDatabase } from "../adapters/store/database.js";
import { LocalResourceLoader, decodeManifest } from "../adapters/resources/local-resource-loader.js";
import { LocalProviderResolver } from "../adapters/model/provider-resolver.js";
import { SqliteStore } from "../adapters/store/sqlite-store.js";
import { AgentShaper } from "../src/application/agent-shaper.js";
import { canonicalJson, sha256 } from "../src/application/canonical.js";
import { DeterministicRoutingPolicy } from "../src/application/model-routing.js";
import { SystemPromptComposer } from "../src/application/system-prompt.js";
import type { AgentShape, HarnessPlan, ProjectProfile } from "../src/domain/contracts.js";
import type { AgentProvider, ModelRegistry, ProviderFactory } from "../src/ports/index.js";
import { AlphionError } from "../src/application/errors.js";

test("ResourceLoader v2 merges four scopes with provenance and stable digest", async () => {
  const root = await mkdtemp(join(tmpdir(), "alphion-v040-resource-"));
  const user = await mkdtemp(join(tmpdir(), "alphion-v040-user-"));
  try {
    await mkdir(join(root, ".alphion-resources"));
    await writeFile(join(user, "manifest.json"), JSON.stringify({ schemaVersion: 1, packageId: "user.shared", resources: [{ id: "shared", kind: "prompt", inline: "user" }, { id: "dependency", kind: "skill", inline: "dependency" }] }));
    await writeFile(join(root, ".alphion-resources", "manifest.json"), JSON.stringify({ schemaVersion: 1, packageId: "project.local", resources: [{ id: "shared", kind: "prompt", inline: "project", dependencies: ["dependency"] }] }));
    const loader = new LocalResourceLoader();
    const request = { projectRoot: root, userResourceRoot: user, sessionOverrides: [{ id: "shared", kind: "prompt" as const, inline: "session" }] };
    const first = await loader.resolve(request);
    const second = await loader.resolve(request);
    assert.equal(first.resources.find((item) => item.id === "shared")?.content, "session");
    assert.equal(first.resources.find((item) => item.id === "shared")?.provenance.scope, "session");
    assert.equal(first.shadows.length, 2);
    assert.equal(first.digest, second.digest);
    assert.throws(() => decodeManifest({ schemaVersion: 2, packageId: "bad", resources: [] }), /unsupported/iu);
    assert.throws(() => decodeManifest({ schemaVersion: 1, packageId: "bad", resources: [{ id: "x", kind: "unknown", inline: "x" }] }), /unknown resource kind/iu);
    await writeFile(join(root, ".alphion-resources", "manifest.json"), JSON.stringify({ schemaVersion: 1, packageId: "project.local", resources: [{ id: "escape", kind: "context", path: "../outside" }] }));
    await assert.rejects(loader.resolve({ projectRoot: root, userResourceRoot: user }), /missing|outside|escape/iu);
  } finally { await rm(root, { recursive: true, force: true }); await rm(user, { recursive: true, force: true }); }
});

test("SystemPromptComposer keeps root sections and omits optional resources deterministically", () => {
  const resource = { id: "large", kind: "prompt" as const, source: "inline", content: "x".repeat(5000), digest: sha256("x".repeat(5000)), dependencies: [], tags: [], provenance: { scope: "project" as const, packageId: "test", manifestPath: "manifest.json", sourcePath: "inline" } };
  const composer = new SystemPromptComposer();
  const input = { identity: { id: "alphion", name: "Alphion", description: "Agent" }, projectRevision: "revision", goal: "goal", sessionBehavior: { compaction: "hybrid", steering: true, followUps: true }, capabilities: ["project.read"], policies: ["default-deny"], resources: [resource], budgetTokens: 256 } as const;
  const plan = composer.compose(input);
  assert.deepEqual(plan.sections.slice(0, 4).map((item) => item.id), ["core.identity", "workspace", "session", "capability-policy"]);
  assert.deepEqual(plan.omissions, ["resource.large:budget"]);
  assert.equal(plan.digest, composer.compose(input).digest);
});

test("AgentShaper is policy bounded and produces deterministic content identity", () => {
  const shaper = new AgentShaper({ capabilities: ["project.read"], policies: ["default-deny"], tools: ["read"], toolCapabilities: { read: "project.read" } });
  const resources = { schemaVersion: 1 as const, resources: [], shadows: [], omissions: [], diagnostics: [], digest: "resources" };
  const harness: HarnessPlan = { schemaVersion: 1, task: "diagnose", taskLabels: ["diagnose"], risk: "low", capabilities: ["project.read"], reasons: [], permissions: ["project:read"], budgets: {}, evaluator: "quality-gate", omissions: [], digest: "harness" };
  const profile: ProjectProfile = { schemaVersion: 1, projectRevision: "revision", profilerVersion: "test", rulesVersion: "test", projectType: "unknown", facts: [], qualityCommands: [], diagnostics: [], scannedPaths: 0, truncated: false, digest: "profile" };
  const shape = shaper.shape({ sessionId: "session", revision: 1, request: { goal: "diagnose" }, profile, resources, harness });
  assert.equal(shape.toolIds[0], "read");
  assert.match(shape.systemPromptPlan.rendered, /Root safety/u);
  assert.equal(shape.digest, shaper.shape({ sessionId: "session", revision: 1, request: { goal: "diagnose" }, profile, resources, harness }).digest);
  assert.throws(() => shaper.shape({ sessionId: "session", revision: 2, request: { goal: "bad", capabilities: ["project.write"] }, profile, resources, harness }), /cannot widen capability/iu);
});

test("Provider routing prefers the Session profile and falls back only during construction", async () => {
  const profiles = [providerProfile("preferred", false), providerProfile("fallback", true)];
  const registry: ModelRegistry = { list: () => Promise.resolve(profiles), get: (id) => Promise.resolve(profiles.find((profile) => profile.id === id)), active: () => Promise.resolve(profiles[1]) };
  const constructed: string[] = [];
  const factory: ProviderFactory = { create: (profile) => { constructed.push(profile.id); if (profile.id === "preferred") throw new AlphionError("dependency-unavailable", "not configured", { stage: "model-resolution" }); return { profile, async *generate() { yield { type: "done", finishReason: "stop" }; } } as AgentProvider; } };
  const resolved = await new LocalProviderResolver(registry, new DeterministicRoutingPolicy(), factory).resolve({ sessionId: "session", providerId: "preferred", requiredCapabilities: ["tools"] });
  assert.deepEqual(constructed, ["preferred", "fallback"]);
  assert.equal(resolved.provider.profile.id, "fallback");
  assert.ok(resolved.reasons.some((reason) => reason.includes("session-preference")));
  const missingPreferred = await new LocalProviderResolver(registry, new DeterministicRoutingPolicy(), { create: (profile) => ({ profile, async *generate() { yield { type: "done", finishReason: "stop" }; } }) }).resolve({ sessionId: "session", providerId: "missing", requiredCapabilities: [] });
  assert.equal(missingPreferred.provider.profile.id, "fallback");
});

test("SQLite v3 to v4 creates backup and requires explicit reshape for migrated Sessions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alphion-v040-migrate-"));
  const path = join(directory, "state.sqlite3");
  try {
    let store = new SqliteStore({ path });
    const fresh = await store.createSession({ title: "legacy-v3", idempotencyKey: "create:migrate:0001" });
    store.close();
    const database = openSqliteDatabase(path);
    database.exec("DROP TABLE session_shapes; ALTER TABLE sessions DROP COLUMN shape_status; ALTER TABLE sessions DROP COLUMN shape_revision; ALTER TABLE sessions DROP COLUMN shape_digest; ALTER TABLE runs DROP COLUMN shape_revision; ALTER TABLE runs DROP COLUMN shape_digest; PRAGMA user_version = 3;");
    database.close();
    store = new SqliteStore({ path });
    try {
      assert.equal(existsSync(`${path}.v3-backup`), true);
      const migrated = await store.getSession(fresh.id);
      assert.equal(migrated?.shapeStatus, "legacy-unshaped");
      await assert.rejects(store.beginShapedSessionRun(fresh.id, "run", user("continue"), undefined, { expectedRevision: migrated?.revision ?? -1, idempotencyKey: "send:migrate:0001" }), /explicitly reshaped/iu);
      const shape = testShape(fresh.id, 1);
      const reshaped = await store.reshapeSession(fresh.id, shape, { expectedRevision: migrated?.revision ?? -1, idempotencyKey: "reshape:migrate:0001" });
      assert.equal(reshaped.shapeRevision, 1);
      const started = await store.beginShapedSessionRun(fresh.id, "run", user("continue"), undefined, { expectedRevision: reshaped.revision, idempotencyKey: "send:migrate:0002" });
      assert.equal(started.shape.digest, shape.digest);
    } finally { store.close(); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function user(content: string) { return { schemaVersion: 1 as const, kind: "user" as const, id: `message-${content}`, createdAt: new Date(0).toISOString(), content }; }
function providerProfile(id: string, active: boolean) { return { schemaVersion: 2 as const, id, name: id, kind: "openai-compatible" as const, baseUrl: "http://127.0.0.1:1/v1", model: id, protocol: "chat-completions" as const, auth: { mode: "none" as const }, capabilities: { streaming: true, tools: true, promptCaching: false, reasoning: false }, revision: 1, active }; }
function testShape(sessionId: string, revision: number): AgentShape { const systemPromptPlan = { schemaVersion: 1 as const, sections: [], omissions: [], budgetTokens: 2048, estimatedTokens: 1, rendered: "test", digest: "prompt" }; const harnessPlan: HarnessPlan = { schemaVersion: 1, task: "diagnose", taskLabels: ["diagnose"], risk: "low", capabilities: [], reasons: [], permissions: [], budgets: {}, evaluator: "test", omissions: [], digest: "plan" }; const base = { schemaVersion: 1 as const, sessionId, revision, goal: "continue", identity: { id: "alphion", name: "Alphion", description: "Agent" }, systemPromptPlan, resources: [], resourceIds: [], resourceDigest: "resources", toolIds: [], capabilities: [], policies: ["default-deny"], behavior: { compaction: "hybrid" as const, steering: true, followUps: true }, requiredProviderCapabilities: [], harnessPlan, omissions: [], diagnostics: [] }; return { ...base, digest: sha256(canonicalJson(base)) }; }
