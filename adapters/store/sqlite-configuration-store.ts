import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ProviderProfile, ProviderProfileInput, ShellRule, VaultStatus } from "../../src/domain/contracts.js";
import type { CacheEntry, CacheStats, CacheStore, ProviderProfileStore, SecretVault, ShellPolicyStore } from "../../src/ports/index.js";
import { canonicalJson, createId } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { containsPotentialSecret } from "../../src/application/sensitive-data.js";
import { SqliteStoreBase } from "./sqlite-store-base.js";
import {
  decodeCacheEntry, decodeProviderProfile, decodeShellRule, decryptValue, encryptValue,
  optionalRow, pathKey, readBuffer, readNumber, readString, requiredRow, validateProviderProfile,
} from "./sqlite-codecs.js";

export abstract class SqliteConfigurationStore extends SqliteStoreBase
  implements CacheStore, ProviderProfileStore, SecretVault, ShellPolicyStore {
  async upsertProfile(
    input: ProviderProfileInput,
  ): Promise<ProviderProfile> {
    const normalized = validateProviderProfile(input);
    const profile = this.transaction(() => {
      const existing = optionalRow(this.database.prepare("SELECT revision, active FROM provider_profiles WHERE id = ?").get(input.id));
      const revision = existing ? readNumber(existing, "revision") + 1 : 1;
      const active = input.active ?? (existing ? readNumber(existing, "active") === 1 : false);
      if (input.auth.mode === "encrypted-sqlite") {
        const secret = optionalRow(
          this.database
            .prepare(`SELECT profile_id FROM device_vault_secrets WHERE secret_id = ?
              UNION ALL SELECT profile_id FROM vault_secrets WHERE secret_id = ? LIMIT 1`)
            .get(input.auth.secretId, input.auth.secretId),
        );
        if (!secret || readString(secret, "profile_id") !== input.id) {
          throw new AlphionError("validation", "Vault credential reference does not belong to this profile.", {
            stage: "config",
          });
        }
      }
      if (active) this.database.exec("UPDATE provider_profiles SET active = 0");
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO provider_profiles
           (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          input.auth.mode === "encrypted-sqlite" ? input.auth.secretId : null,
          JSON.stringify(input.capabilities),
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

  async status(): Promise<VaultStatus> {
    const deviceMetadata = optionalRow(this.database.prepare("SELECT id FROM device_vault_metadata WHERE id = 1").get());
    const deviceCount = readNumber(requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM device_vault_secrets").get()), "count");
    const legacyCount = readNumber(requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get()), "count");
    const deviceKeyAvailable = await this.deviceKeyProvider.load().then((value) => value?.byteLength === 32, () => false);
    return Object.freeze({
      schemaVersion: 2,
      mode: deviceMetadata ? "device" : legacyCount > 0 ? "legacy-disabled" : "unprovisioned",
      provisioned: deviceMetadata !== undefined,
      deviceKeyAvailable,
      secretCount: deviceCount,
      legacySecretCount: legacyCount,
    });
  }

  async provision(): Promise<void> {
    if (optionalRow(this.database.prepare("SELECT id FROM device_vault_metadata WHERE id = 1").get())) {
      const key = await this.loadDeviceDataKey();
      key.fill(0);
      return;
    }
    const deviceKey = await this.loadDeviceKey(true);
    const dataKey = randomBytes(32);
    const keyId = createId("device_key");
    try {
      const wrapped = encryptValue(deviceKey, dataKey, deviceVaultAad(keyId));
      const now = new Date().toISOString();
      this.transaction(() => this.database.prepare(
        `INSERT INTO device_vault_metadata
         (id, schema_version, key_id, wrapped_key_nonce, wrapped_key_ciphertext, wrapped_key_tag, created_at, updated_at)
         VALUES (1, 1, ?, ?, ?, ?, ?, ?)`,
      ).run(keyId, wrapped.nonce, wrapped.ciphertext, wrapped.authTag, now, now));
    } catch (error) {
      if (!optionalRow(this.database.prepare("SELECT id FROM device_vault_metadata WHERE id = 1").get())) throw error;
    } finally {
      deviceKey.fill(0);
      dataKey.fill(0);
    }
  }

  async resolve(reference: string): Promise<string | undefined> {
    if (!/^vault_[A-Za-z0-9_-]{8,}$/.test(reference)) return undefined;
    const row = optionalRow(this.database.prepare(
      "SELECT secret_id, profile_id, revision, nonce, ciphertext, auth_tag FROM device_vault_secrets WHERE secret_id = ?",
    ).get(reference));
    if (!row) {
      if (optionalRow(this.database.prepare("SELECT secret_id FROM vault_secrets WHERE secret_id = ?").get(reference))) {
        throw new AlphionError("dependency-unavailable", "Legacy password credential is disabled; reset and re-import it.", { stage: "vault", reason: "legacy-vault-disabled" });
      }
      return undefined;
    }
    const key = await this.loadDeviceDataKey();
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptValue(key, readBuffer(row, "nonce"), readBuffer(row, "ciphertext"), readBuffer(row, "auth_tag"), deviceSecretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")));
      return plaintext.toString("utf8");
    } catch (error) {
      throw new AlphionError("integrity-failed", "Encrypted credential failed authentication.", { stage: "vault", reason: "credential-authentication-failed", cause: error });
    } finally {
      key.fill(0);
      plaintext?.fill(0);
    }
  }

  async importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    if (secret.length === 0 || secret.length > 16_384 || secret.includes("\0")) throw new AlphionError("validation", "Credential must be between 1 and 16384 characters.", { stage: "vault" });
    await this.provision();
    const key = await this.loadDeviceDataKey();
    const profile = await this.getProfile(profileId);
    if (!profile) { key.fill(0); throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" }); }
    const existing = optionalRow(this.database.prepare("SELECT secret_id, revision FROM device_vault_secrets WHERE profile_id = ?").get(profile.id));
    const secretId = existing ? readString(existing, "secret_id") : createId("vault");
    const secretRevision = existing ? readNumber(existing, "revision") + 1 : 1;
    const plaintext = Buffer.from(secret, "utf8");
    try {
      const encrypted = encryptValue(key, plaintext, deviceSecretAad(secretId, profile.id, secretRevision));
      this.transaction(() => {
        const now = new Date().toISOString();
        this.database.prepare(
          `INSERT INTO device_vault_secrets
           (secret_id, profile_id, revision, nonce, ciphertext, auth_tag, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET secret_id = excluded.secret_id, revision = excluded.revision,
             nonce = excluded.nonce, ciphertext = excluded.ciphertext, auth_tag = excluded.auth_tag, updated_at = excluded.updated_at`,
        ).run(secretId, profile.id, secretRevision, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now, now);
        this.database.prepare(
          `UPDATE provider_profiles SET auth_mode = 'encrypted-sqlite', auth_environment_variable = NULL,
           auth_secret_id = ?, revision = revision + 1, updated_at = ? WHERE id = ?`,
        ).run(secretId, now, profile.id);
      });
      return this.requireProfile(profile.id);
    } finally {
      key.fill(0);
      plaintext.fill(0);
    }
  }

  async removeCredential(profileId: string): Promise<ProviderProfile> {
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    this.transaction(() => {
      this.database.prepare("DELETE FROM device_vault_secrets WHERE profile_id = ?").run(profile.id);
      this.database.prepare(
        `UPDATE provider_profiles SET auth_mode = 'none', auth_environment_variable = NULL,
         auth_secret_id = NULL, revision = revision + 1, updated_at = ? WHERE id = ?`,
      ).run(new Date().toISOString(), profile.id);
    });
    return this.requireProfile(profile.id);
  }

  async reset(): Promise<number> {
    const deleted = readNumber(requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM device_vault_secrets").get()), "count");
    this.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(
        `UPDATE provider_profiles SET auth_mode = 'none', auth_environment_variable = NULL,
         auth_secret_id = NULL, revision = revision + 1, updated_at = ?
         WHERE auth_secret_id IN (SELECT secret_id FROM device_vault_secrets)`,
      ).run(now);
      this.database.prepare("DELETE FROM device_vault_secrets").run();
      this.database.prepare("DELETE FROM device_vault_metadata WHERE id = 1").run();
    });
    return deleted;
  }

  async legacyStatus(): Promise<Readonly<{ disabled: boolean; secretCount: number }>> {
    const state = optionalRow(this.database.prepare("SELECT state FROM vault_legacy_state WHERE id = 1").get());
    const secretCount = readNumber(requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get()), "count");
    return Object.freeze({ disabled: state ? readString(state, "state") === "legacy-disabled" : false, secretCount });
  }

  async resetLegacy(): Promise<number> {
    const deleted = readNumber(requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get()), "count");
    this.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare(
        `UPDATE provider_profiles SET auth_mode = 'none', auth_environment_variable = NULL,
         auth_secret_id = NULL, revision = revision + 1, updated_at = ?
         WHERE auth_secret_id IN (SELECT secret_id FROM vault_secrets)`,
      ).run(now);
      this.database.prepare("DELETE FROM vault_secrets").run();
      this.database.prepare("DELETE FROM vault_metadata").run();
      this.database.prepare("UPDATE vault_legacy_state SET state = 'none', updated_at = ? WHERE id = 1").run(now);
    });
    return deleted;
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

  private async loadDeviceDataKey(): Promise<Buffer> {
    const row = optionalRow(this.database.prepare("SELECT * FROM device_vault_metadata WHERE id = 1").get());
    if (!row) throw new AlphionError("conflict", "Device credential vault is not provisioned.", { stage: "vault" });
    if (readNumber(row, "schema_version") !== 1) throw new AlphionError("incompatible-schema", "Device credential envelope is unsupported.", { stage: "vault" });
    const deviceKey = await this.loadDeviceKey(false);
    try {
      const value = decryptValue(
        deviceKey,
        readBuffer(row, "wrapped_key_nonce"),
        readBuffer(row, "wrapped_key_ciphertext"),
        readBuffer(row, "wrapped_key_tag"),
        deviceVaultAad(readString(row, "key_id")),
      );
      if (value.byteLength !== 32) { value.fill(0); throw new Error("Invalid data key length."); }
      return value;
    } catch (error) {
      throw new AlphionError("integrity-failed", "Device credential envelope failed authentication.", { stage: "vault", reason: "device-envelope-authentication-failed", cause: error });
    } finally {
      deviceKey.fill(0);
    }
  }

  private async loadDeviceKey(create: boolean): Promise<Buffer> {
    const value = create ? await this.deviceKeyProvider.loadOrCreate() : await this.deviceKeyProvider.load();
    if (!value || value.byteLength !== 32) throw new AlphionError("dependency-unavailable", "Device credential key is unavailable.", { stage: "vault", reason: "device-key-unavailable" });
    return Buffer.from(value);
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

function deviceVaultAad(keyId: string): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: 1, kind: "device-data-key", keyId }), "utf8");
}

function deviceSecretAad(secretId: string, profileId: string, revision: number): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: 2, kind: "provider-credential", secretId, profileId, revision }), "utf8");
}
