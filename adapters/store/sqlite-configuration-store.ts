import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ProjectCredentialStatus, ProviderProfile, ProviderProfileInput, ShellRule } from "../../src/domain/contracts.js";
import type { CacheEntry, CacheStats, CacheStore, ProjectCredentialStore, ProviderProfileStore, ShellPolicyStore } from "../../src/ports/index.js";
import { canonicalJson, createId } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { containsPotentialSecret } from "../../src/application/sensitive-data.js";
import { SqliteStoreBase } from "./sqlite-store-base.js";
import {
  decodeCacheEntry, decodeProviderProfile, decodeShellRule, decryptValue, encryptValue,
  optionalRow, pathKey, readBuffer, readNumber, readString, requiredRow, validateProviderProfile,
} from "./sqlite-codecs.js";

export abstract class SqliteConfigurationStore extends SqliteStoreBase
  implements CacheStore, ProviderProfileStore, ProjectCredentialStore, ShellPolicyStore {
  async upsertProfile(
    input: ProviderProfileInput,
  ): Promise<ProviderProfile> {
    const normalized = validateProviderProfile(input);
    const profile = this.transaction(() => {
      const existing = optionalRow(this.database.prepare("SELECT revision, active FROM provider_profiles WHERE id = ?").get(input.id));
      const revision = existing ? readNumber(existing, "revision") + 1 : 1;
      const active = input.active ?? (existing ? readNumber(existing, "active") === 1 : false);
      if (input.auth.mode === "encrypted-project") {
        const secret = optionalRow(
          this.database
            .prepare("SELECT profile_id, project_id FROM project_credentials WHERE secret_id = ?")
            .get(input.auth.secretId),
        );
        if (!secret || readString(secret, "profile_id") !== input.id || readString(secret, "project_id") !== this.credentialProjectId) {
          throw new AlphionError("validation", "Project credential reference does not belong to this profile.", {
            stage: "config",
          });
        }
      }
      if (active) this.database.exec("UPDATE provider_profiles SET active = 0");
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO provider_profiles
           (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, context_window_tokens, revision, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             provider_kind = excluded.provider_kind,
             base_url = excluded.base_url,
             model = excluded.model,
             protocol = excluded.protocol,
             auth_mode = excluded.auth_mode,
             auth_environment_variable = excluded.auth_environment_variable,
             auth_secret_id = excluded.auth_secret_id,
             capabilities_json = excluded.capabilities_json,
             context_window_tokens = excluded.context_window_tokens,
             revision = excluded.revision,
             active = excluded.active,
             updated_at = excluded.updated_at`,
        )
        .run(
          input.id,
          input.name,
          input.kind,
          normalized.baseUrl,
          input.model,
          input.protocol,
          input.auth.mode,
          input.auth.mode === "bearer-env" ? input.auth.environmentVariable : null,
          input.auth.mode === "encrypted-project" ? input.auth.secretId : null,
          JSON.stringify(input.capabilities),
          input.contextWindowTokens ?? null,
          revision,
          active ? 1 : 0,
          now,
          now,
        );
      return this.requireProfile(input.id);
    });
    return profile;
  }

  async listProfiles(): Promise<readonly ProviderProfile[]> {
    const rows = this.database.prepare("SELECT * FROM provider_profiles ORDER BY active DESC, name").all();
    return rows.map((row) => decodeProviderProfile(requiredRow(row)));
  }

  async getProfile(idOrName: string): Promise<ProviderProfile | undefined> {
    const row = optionalRow(
      this.database.prepare("SELECT * FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName),
    );
    return row ? decodeProviderProfile(row) : undefined;
  }

  async getActiveProfile(): Promise<ProviderProfile | undefined> {
    const row = optionalRow(this.database.prepare("SELECT * FROM provider_profiles WHERE active = 1 LIMIT 1").get());
    return row ? decodeProviderProfile(row) : undefined;
  }

  async activateProfile(idOrName: string): Promise<ProviderProfile> {
    const profile = this.transaction(() => {
      const found = optionalRow(
        this.database.prepare("SELECT id FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName),
      );
      if (!found) throw new AlphionError("validation", `Unknown provider profile: ${idOrName}`, { stage: "config" });
      const id = readString(found, "id");
      this.database.exec("UPDATE provider_profiles SET active = 0");
      this.database.prepare("UPDATE provider_profiles SET active = 1, revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return this.requireProfile(id);
    });
    return profile;
  }

  async credentialStatus(): Promise<ProjectCredentialStatus> {
    const secretCount = readNumber(requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM project_credentials WHERE project_id = ?").get(this.credentialProjectId)), "count");
    const reentryRequiredProfileIds = this.database.prepare("SELECT profile_id FROM project_credential_migrations WHERE state = 'reentry-required' ORDER BY profile_id").all()
      .map((row) => readString(requiredRow(row), "profile_id"));
    const projectKeyAvailable = secretCount === 0 || await this.projectKeyProvider.load(this.credentialProjectId).then((value) => value?.byteLength === 32, () => false);
    return Object.freeze({
      schemaVersion: 1,
      projectKeyAvailable,
      secretCount,
      reentryRequiredProfileIds: Object.freeze(reentryRequiredProfileIds),
    });
  }

  async resolve(reference: string): Promise<string | undefined> {
    if (!/^credential_[A-Za-z0-9_-]{8,}$/u.test(reference)) return undefined;
    const row = optionalRow(this.database.prepare(
      "SELECT secret_id, project_id, profile_id, revision, nonce, ciphertext, auth_tag FROM project_credentials WHERE secret_id = ? AND project_id = ?",
    ).get(reference, this.credentialProjectId));
    if (!row) return undefined;
    const key = await this.loadProjectKey(false);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptValue(key, readBuffer(row, "nonce"), readBuffer(row, "ciphertext"), readBuffer(row, "auth_tag"), projectCredentialAad(readString(row, "project_id"), readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")));
      return plaintext.toString("utf8");
    } catch (error) {
      throw new AlphionError("integrity-failed", "Project credential failed authentication.", { stage: "credential", reason: "credential-authentication-failed", cause: error });
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }

  async importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    if (secret.length === 0 || secret.length > 16_384 || secret.includes("\0")) throw new AlphionError("validation", "Credential must be between 1 and 16384 characters.", { stage: "credential" });
    const plaintext = Buffer.from(secret, "utf8");
    try { return await this.saveProjectCredential(profileId, plaintext); }
    finally { plaintext.fill(0); }
  }

  async removeCredential(profileId: string): Promise<ProviderProfile> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "credential" });
    this.transaction(() => {
      this.database.prepare("DELETE FROM project_credentials WHERE profile_id = ? AND project_id = ?").run(profile.id, this.credentialProjectId);
      this.database.prepare(
        `UPDATE provider_profiles SET auth_mode = 'none', auth_environment_variable = NULL,
         auth_secret_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), profile.id);
    });
    return this.requireProfile(profile.id);
  }

  async migrateLegacyCredentials(): Promise<void> {
    const rows = this.database.prepare("SELECT profile_id, source_secret_id FROM project_credential_migrations WHERE state = 'pending' ORDER BY profile_id").all().map(requiredRow);
    if (rows.length === 0) return;
    const metadata = optionalRow(this.database.prepare("SELECT * FROM device_vault_metadata WHERE id = 1").get());
    if (!metadata || !this.legacyDeviceKeyPath) { this.markLegacyReentry(rows); return; }
    let deviceKey: Buffer | undefined;
    let dataKey: Buffer | undefined;
    try {
      deviceKey = Buffer.from(await readFile(this.legacyDeviceKeyPath));
      if (deviceKey.byteLength !== 32 || readNumber(metadata, "schema_version") !== 1) throw new Error("Legacy key envelope is unavailable.");
      dataKey = decryptValue(deviceKey, readBuffer(metadata, "wrapped_key_nonce"), readBuffer(metadata, "wrapped_key_ciphertext"), readBuffer(metadata, "wrapped_key_tag"), legacyDeviceKeyAad(readString(metadata, "key_id")));
      if (dataKey.byteLength !== 32) throw new Error("Legacy data key is invalid.");
      for (const migration of rows) {
        const profileId = readString(migration, "profile_id");
        const sourceSecretId = readString(migration, "source_secret_id");
        const source = optionalRow(this.database.prepare("SELECT * FROM device_vault_secrets WHERE secret_id = ? AND profile_id = ?").get(sourceSecretId, profileId));
        if (!source) { this.markLegacyReentry([migration]); continue; }
        let plaintext: Buffer | undefined;
        try {
          plaintext = decryptValue(dataKey, readBuffer(source, "nonce"), readBuffer(source, "ciphertext"), readBuffer(source, "auth_tag"), legacyDeviceSecretAad(sourceSecretId, profileId, readNumber(source, "revision")));
          await this.saveProjectCredential(profileId, plaintext, true);
        } catch { this.markLegacyReentry([migration]); }
        finally { plaintext?.fill(0); }
      }
    } catch { this.markLegacyReentry(rows); }
    finally { deviceKey?.fill(0); dataKey?.fill(0); }
  }

  async get(namespace: string, key: string): Promise<CacheEntry | undefined> {
    const row = optionalRow(
      this.database.prepare("SELECT * FROM cache_entries WHERE namespace = ? AND cache_key = ?").get(namespace, key),
    );
    if (!row || Date.parse(readString(row, "expires_at")) <= Date.now()) {
      if (row) this.database.prepare("DELETE FROM cache_entries WHERE namespace = ? AND cache_key = ?").run(namespace, key);
      this.database.prepare("UPDATE cache_metrics SET misses = misses + 1 WHERE id = 1").run();
      return undefined;
    }
    this.database
      .prepare("UPDATE cache_entries SET hit_count = hit_count + 1, last_accessed_at = ? WHERE namespace = ? AND cache_key = ?")
      .run(new Date().toISOString(), namespace, key);
    this.database.prepare("UPDATE cache_metrics SET hits = hits + 1 WHERE id = 1").run();
    return decodeCacheEntry(row);
  }

  async set(entry: CacheEntry): Promise<void> {
    if (containsPotentialSecret(entry.value) || containsPotentialSecret(entry.provenance)) {
      throw new AlphionError("forbidden", "Potential secrets cannot be written to persistent cache.", { stage: "cache" });
    }
    const bytes = Buffer.byteLength(entry.value) + Buffer.byteLength(entry.provenance);
    this.database
      .prepare(
        `INSERT INTO cache_entries
         (namespace, cache_key, value_text, created_at, expires_at, provenance, size_bytes, hit_count, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(namespace, cache_key) DO UPDATE SET
           value_text = excluded.value_text,
           created_at = excluded.created_at,
           expires_at = excluded.expires_at,
           provenance = excluded.provenance,
           size_bytes = excluded.size_bytes,
           hit_count = 0,
           last_accessed_at = excluded.last_accessed_at`,
      )
      .run(
        entry.namespace,
        entry.key,
        entry.value,
        entry.createdAt,
        entry.expiresAt,
        entry.provenance,
        bytes,
        entry.createdAt,
      );
    this.pruneCache();
  }

  async delete(namespace?: string): Promise<number> {
    const result = namespace
      ? this.database.prepare("DELETE FROM cache_entries WHERE namespace = ?").run(namespace)
      : this.database.prepare("DELETE FROM cache_entries").run();
    return Number(result.changes);
  }

  async stats(): Promise<CacheStats> {
    const aggregate = requiredRow(
      this.database.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get(),
    );
    const metrics = requiredRow(this.database.prepare("SELECT hits, misses FROM cache_metrics WHERE id = 1").get());
    return {
      entries: readNumber(aggregate, "entries"),
      bytes: readNumber(aggregate, "bytes"),
      hits: readNumber(metrics, "hits"),
      misses: readNumber(metrics, "misses"),
    };
  }

  async addShellRule(input: Omit<ShellRule, "schemaVersion" | "id" | "enabled">): Promise<ShellRule> {
    if (!isAbsolute(input.executablePath)) {
      throw new AlphionError("validation", "Shell policy executable paths must be absolute.", { stage: "config" });
    }
    if (
      input.argumentPrefix.length > 128 ||
      !input.argumentPrefix.every((argument) => typeof argument === "string" && !argument.includes("\0")) ||
      (input.executableDigest !== undefined && !/^[a-f0-9]{64}$/.test(input.executableDigest))
    ) {
      throw new AlphionError("validation", "Shell policy digest or argument prefix is invalid.", { stage: "config" });
    }
    const executablePath = await realpath(resolve(input.executablePath)).catch((error: unknown) => {
      throw new AlphionError("validation", "Shell policy executable does not exist.", { stage: "config", cause: error });
    });
    if (!(await stat(executablePath)).isFile()) {
      throw new AlphionError("validation", "Shell policy executable must be a regular file.", { stage: "config" });
    }
    const id = createId("shell_rule");
    this.database
      .prepare(
        `INSERT INTO shell_rules
         (id, executable_path, executable_key, executable_digest, argument_prefix_json, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
      )
      .run(
        id,
        executablePath,
        pathKey(executablePath),
        input.executableDigest ?? null,
        JSON.stringify(input.argumentPrefix),
        new Date().toISOString(),
      );
    return { schemaVersion: 1, id, executablePath, ...(input.executableDigest ? { executableDigest: input.executableDigest } : {}), argumentPrefix: input.argumentPrefix, enabled: true };
  }

  listShellRules(): readonly ShellRule[] {
    return this.database.prepare("SELECT * FROM shell_rules ORDER BY created_at").all().map((row) => decodeShellRule(requiredRow(row)));
  }

  async removeShellRule(id: string): Promise<boolean> {
    const result = this.database.prepare("DELETE FROM shell_rules WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async findAllowed(executablePath: string, args: readonly string[]): Promise<ShellRule | undefined> {
    const resolvedExecutable = await realpath(resolve(executablePath)).catch(() => undefined);
    if (!resolvedExecutable) return undefined;
    const rows = this.database
      .prepare("SELECT * FROM shell_rules WHERE executable_key = ? AND enabled = 1 ORDER BY created_at")
      .all(pathKey(resolvedExecutable));
    for (const row of rows) {
      const rule = decodeShellRule(requiredRow(row));
      if (rule.argumentPrefix.every((argument, index) => args[index] === argument)) return rule;
    }
    return undefined;
  }

  private requireProfile(id: string): ProviderProfile {
    const row = optionalRow(this.database.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id));
    if (!row) throw new AlphionError("internal", "Provider profile disappeared during transaction.", { stage: "database" });
    return decodeProviderProfile(row);
  }

  private async saveProjectCredential(profileId: string, plaintext: Buffer, migrated = false): Promise<ProviderProfile> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "credential" });
    const existing = optionalRow(this.database.prepare("SELECT secret_id, revision FROM project_credentials WHERE profile_id = ? AND project_id = ?").get(profile.id, this.credentialProjectId));
    const secretId = existing ? readString(existing, "secret_id") : createId("credential");
    const secretRevision = existing ? readNumber(existing, "revision") + 1 : 1;
    const key = await this.loadProjectKey(true);
    try {
      const encrypted = encryptValue(key, plaintext, projectCredentialAad(this.credentialProjectId, secretId, profile.id, secretRevision));
      this.transaction(() => {
        const now = new Date().toISOString();
        this.database.prepare(
          `INSERT INTO project_credentials
           (secret_id, project_id, profile_id, revision, nonce, ciphertext, auth_tag, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET secret_id = excluded.secret_id, project_id = excluded.project_id,
             revision = excluded.revision, nonce = excluded.nonce, ciphertext = excluded.ciphertext,
             auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`,
        ).run(secretId, this.credentialProjectId, profile.id, secretRevision, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now, now);
        this.database.prepare(
          `UPDATE provider_profiles SET auth_mode = 'encrypted-project', auth_environment_variable = NULL,
           auth_secret_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).run(secretId, now, profile.id);
        if (migrated) this.database.prepare("UPDATE project_credential_migrations SET state = 'migrated', updated_at = ? WHERE profile_id = ?").run(now, profile.id);
        else this.database.prepare("DELETE FROM project_credential_migrations WHERE profile_id = ?").run(profile.id);
      });
      return this.requireProfile(profile.id);
    } finally { key.fill(0); }
  }

  private async loadProjectKey(create: boolean): Promise<Buffer> {
    const value = create ? await this.projectKeyProvider.loadOrCreate(this.credentialProjectId) : await this.projectKeyProvider.load(this.credentialProjectId);
    if (!value || value.byteLength !== 32) throw new AlphionError("dependency-unavailable", "Project credential key is unavailable.", { stage: "credential", reason: "project-key-unavailable" });
    return Buffer.from(value);
  }

  private markLegacyReentry(rows: readonly Readonly<Record<string, unknown>>[]): void {
    const now = new Date().toISOString();
    const update = this.database.prepare("UPDATE project_credential_migrations SET state = 'reentry-required', updated_at = ? WHERE profile_id = ?");
    this.transaction(() => { for (const row of rows) update.run(now, readString(row, "profile_id")); });
  }

  private pruneCache(): void {
    const maxBytes = 256 * 1024 * 1024;
    const row = requiredRow(this.database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get());
    if (readNumber(row, "bytes") <= maxBytes) return;
    const targetBytes = Math.floor(maxBytes * 0.8);
    while (true) {
      const current = requiredRow(this.database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get());
      if (readNumber(current, "bytes") <= targetBytes) break;
      this.database.prepare("DELETE FROM cache_entries WHERE rowid IN (SELECT rowid FROM cache_entries ORDER BY last_accessed_at LIMIT 32)").run();
    }
  }
}

function legacyDeviceKeyAad(keyId: string): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: 1, kind: "device-data-key", keyId }), "utf8");
}

function legacyDeviceSecretAad(secretId: string, profileId: string, revision: number): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: 2, kind: "provider-credential", secretId, profileId, revision }), "utf8");
}

function projectCredentialAad(projectId: string, secretId: string, profileId: string, revision: number): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: 1, kind: "project-provider-credential", projectId, secretId, profileId, revision }), "utf8");
}
