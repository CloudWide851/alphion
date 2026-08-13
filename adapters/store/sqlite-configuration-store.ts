import { randomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ProviderProfile, ProviderProfileInput, ShellRule, VaultStatus } from "../../src/domain/contracts.js";
import type { CacheEntry, CacheStats, CacheStore, ProviderProfileStore, SecretVault, ShellPolicyStore } from "../../src/ports/index.js";
import { createId } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { containsPotentialSecret } from "../../src/application/sensitive-data.js";
import { SqliteStoreBase } from "./sqlite-store-base.js";
import { SCRYPT_OPTIONS, VAULT_SCHEMA_VERSION, VAULT_VERIFIER } from "./sqlite-constants.js";
import {
  decodeCacheEntry, decodeProviderProfile, decodeShellRule, decryptValue, deriveVaultKey, encryptValue,
  optionalRow, pathKey, readBuffer, readNumber, readString, requiredRow, secretAad,
  type VaultMetadata, validateMasterPassword, validateProviderProfile, vaultVerifierAad,
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
            .prepare("SELECT profile_id FROM vault_secrets WHERE secret_id = ?")
            .get(input.auth.secretId),
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
    this.expireVaultIfNeeded();
    const initialized = optionalRow(this.database.prepare("SELECT id FROM vault_metadata WHERE id = 1").get()) !== undefined;
    const count = requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get());
    return {
      initialized,
      locked: this.vaultKey === undefined,
      secretCount: readNumber(count, "count"),
      autoLockMs: this.vaultAutoLockMs,
    };
  }

  async initialize(masterPassword: string): Promise<void> {
    validateMasterPassword(masterPassword);
    if (optionalRow(this.database.prepare("SELECT id FROM vault_metadata WHERE id = 1").get())) {
      throw new AlphionError("conflict", "Credential vault is already initialized.", { stage: "vault" });
    }
    const salt = randomBytes(16);
    const key = deriveVaultKey(masterPassword, salt);
    const verifier = encryptValue(key, Buffer.from(VAULT_VERIFIER), vaultVerifierAad());
    try {
      this.transaction(() => {
        this.database
          .prepare(
            `INSERT INTO vault_metadata
             (id, schema_version, kdf, salt, work_factor, block_size, parallelism, verifier_nonce, verifier_ciphertext, verifier_tag, created_at, updated_at)
             VALUES (1, ?, 'scrypt', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            VAULT_SCHEMA_VERSION,
            salt,
            SCRYPT_OPTIONS.N,
            SCRYPT_OPTIONS.r,
            SCRYPT_OPTIONS.p,
            verifier.nonce,
            verifier.ciphertext,
            verifier.authTag,
            new Date().toISOString(),
            new Date().toISOString(),
          );
      });
      this.setVaultKey(key);
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  async unlock(masterPassword: string): Promise<void> {
    const metadata = this.readVaultMetadata();
    const key = deriveVaultKey(masterPassword, metadata.salt);
    try {
      const verifier = decryptValue(
        key,
        metadata.verifierNonce,
        metadata.verifierCiphertext,
        metadata.verifierTag,
        vaultVerifierAad(),
      );
      if (verifier.toString("utf8") !== VAULT_VERIFIER) {
        throw new Error("Vault verifier mismatch.");
      }
      this.setVaultKey(key);
    } catch (error) {
      key.fill(0);
      throw new AlphionError("forbidden", "Credential vault could not be unlocked.", { stage: "vault", cause: error });
    }
  }

  lock(): void {
    if (this.vaultLockTimer) clearTimeout(this.vaultLockTimer);
    this.vaultLockTimer = undefined;
    this.vaultLastActivity = 0;
    this.vaultKey?.fill(0);
    this.vaultKey = undefined;
  }

  async resolve(reference: string): Promise<string | undefined> {
    if (!/^vault_[A-Za-z0-9_-]{8,}$/.test(reference)) return undefined;
    const key = this.requireVaultKey();
    const row = optionalRow(
      this.database
        .prepare("SELECT secret_id, profile_id, revision, nonce, ciphertext, auth_tag FROM vault_secrets WHERE secret_id = ?")
        .get(reference),
    );
    if (!row) return undefined;
    try {
      const plaintext = decryptValue(
        key,
        readBuffer(row, "nonce"),
        readBuffer(row, "ciphertext"),
        readBuffer(row, "auth_tag"),
        secretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")),
      );
      this.touchVault();
      return plaintext.toString("utf8");
    } catch (error) {
      throw new AlphionError("integrity-failed", "Encrypted credential failed authentication.", {
        stage: "vault",
        cause: error,
      });
    }
  }

  async importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    if (secret.length === 0 || secret.length > 16_384 || secret.includes("\0")) {
      throw new AlphionError("validation", "Credential must be between 1 and 16384 characters.", { stage: "vault" });
    }
    const key = this.requireVaultKey();
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    const existing = optionalRow(
      this.database.prepare("SELECT secret_id, revision FROM vault_secrets WHERE profile_id = ?").get(profile.id),
    );
    const secretId = existing ? readString(existing, "secret_id") : createId("vault");
    const secretRevision = existing ? readNumber(existing, "revision") + 1 : 1;
    const encrypted = encryptValue(
      key,
      Buffer.from(secret, "utf8"),
      secretAad(secretId, profile.id, secretRevision),
    );
    this.transaction(() => {
      const now = new Date().toISOString();
      this.database
        .prepare(
          `INSERT INTO vault_secrets
           (secret_id, profile_id, revision, nonce, ciphertext, auth_tag, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(profile_id) DO UPDATE SET
             secret_id = excluded.secret_id,
             revision = excluded.revision,
             nonce = excluded.nonce,
             ciphertext = excluded.ciphertext,
             auth_tag = excluded.auth_tag,
             updated_at = excluded.updated_at`,
        )
        .run(secretId, profile.id, secretRevision, encrypted.nonce, encrypted.ciphertext, encrypted.authTag, now, now);
      this.database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'encrypted-sqlite', auth_environment_variable = NULL, auth_secret_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(secretId, now, profile.id);
    });
    this.touchVault();
    return this.requireProfile(profile.id);
  }

  async removeCredential(profileId: string): Promise<ProviderProfile> {
    this.requireVaultKey();
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    this.transaction(() => {
      this.database.prepare("DELETE FROM vault_secrets WHERE profile_id = ?").run(profile.id);
      this.database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'none', auth_environment_variable = NULL, auth_secret_id = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), profile.id);
    });
    this.touchVault();
    return this.requireProfile(profile.id);
  }

  async rotateMasterPassword(currentPassword: string, nextPassword: string): Promise<void> {
    validateMasterPassword(nextPassword);
    const metadata = this.readVaultMetadata();
    const currentKey = deriveVaultKey(currentPassword, metadata.salt);
    const rows = this.database
      .prepare("SELECT secret_id, profile_id, revision, nonce, ciphertext, auth_tag FROM vault_secrets ORDER BY secret_id")
      .all()
      .map(requiredRow);
    try {
      const verifier = decryptValue(
        currentKey,
        metadata.verifierNonce,
        metadata.verifierCiphertext,
        metadata.verifierTag,
        vaultVerifierAad(),
      );
      if (verifier.toString("utf8") !== VAULT_VERIFIER) throw new Error("Vault verifier mismatch.");
      const plaintext = rows.map((row) => ({
        row,
        value: decryptValue(
          currentKey,
          readBuffer(row, "nonce"),
          readBuffer(row, "ciphertext"),
          readBuffer(row, "auth_tag"),
          secretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")),
        ),
      }));
      const nextSalt = randomBytes(16);
      const nextKey = deriveVaultKey(nextPassword, nextSalt);
      try {
        const nextVerifier = encryptValue(nextKey, Buffer.from(VAULT_VERIFIER), vaultVerifierAad());
        const encrypted = plaintext.map(({ row, value }) => ({
          secretId: readString(row, "secret_id"),
          value: encryptValue(
            nextKey,
            value,
            secretAad(readString(row, "secret_id"), readString(row, "profile_id"), readNumber(row, "revision")),
          ),
        }));
        this.transaction(() => {
          this.database
            .prepare(
              `UPDATE vault_metadata
               SET salt = ?, work_factor = ?, block_size = ?, parallelism = ?, verifier_nonce = ?, verifier_ciphertext = ?, verifier_tag = ?, updated_at = ?
               WHERE id = 1`,
            )
            .run(
              nextSalt,
              SCRYPT_OPTIONS.N,
              SCRYPT_OPTIONS.r,
              SCRYPT_OPTIONS.p,
              nextVerifier.nonce,
              nextVerifier.ciphertext,
              nextVerifier.authTag,
              new Date().toISOString(),
            );
          const update = this.database.prepare(
            "UPDATE vault_secrets SET nonce = ?, ciphertext = ?, auth_tag = ?, updated_at = ? WHERE secret_id = ?",
          );
          for (const item of encrypted) {
            update.run(item.value.nonce, item.value.ciphertext, item.value.authTag, new Date().toISOString(), item.secretId);
          }
        });
        this.setVaultKey(nextKey);
      } catch (error) {
        nextKey.fill(0);
        throw error;
      } finally {
        for (const item of plaintext) item.value.fill(0);
      }
    } catch (error) {
      throw error instanceof AlphionError
        ? error
        : new AlphionError("forbidden", "Credential vault password rotation failed.", { stage: "vault", cause: error });
    } finally {
      currentKey.fill(0);
    }
  }

  async reset(): Promise<number> {
    const count = requiredRow(this.database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get());
    const deleted = readNumber(count, "count");
    this.transaction(() => {
      const now = new Date().toISOString();
      this.database.prepare("DELETE FROM vault_secrets").run();
      this.database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'none', auth_environment_variable = NULL, auth_secret_id = NULL, revision = revision + 1, updated_at = ?
           WHERE auth_mode = 'encrypted-sqlite'`,
        )
        .run(now);
      this.database.prepare("DELETE FROM vault_metadata WHERE id = 1").run();
    });
    this.lock();
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

  private readVaultMetadata(): VaultMetadata {
    const row = optionalRow(this.database.prepare("SELECT * FROM vault_metadata WHERE id = 1").get());
    if (!row) throw new AlphionError("conflict", "Credential vault is not initialized.", { stage: "vault" });
    if (
      readNumber(row, "schema_version") !== VAULT_SCHEMA_VERSION ||
      readString(row, "kdf") !== "scrypt" ||
      readNumber(row, "work_factor") !== SCRYPT_OPTIONS.N ||
      readNumber(row, "block_size") !== SCRYPT_OPTIONS.r ||
      readNumber(row, "parallelism") !== SCRYPT_OPTIONS.p
    ) {
      throw new AlphionError("incompatible-schema", "Credential vault parameters are unsupported.", { stage: "vault" });
    }
    return {
      salt: readBuffer(row, "salt"),
      verifierNonce: readBuffer(row, "verifier_nonce"),
      verifierCiphertext: readBuffer(row, "verifier_ciphertext"),
      verifierTag: readBuffer(row, "verifier_tag"),
    };
  }

  private requireVaultKey(): Buffer {
    this.expireVaultIfNeeded();
    if (!this.vaultKey) {
      throw new AlphionError("forbidden", "Credential vault is locked.", { stage: "vault" });
    }
    this.touchVault();
    return this.vaultKey;
  }

  private setVaultKey(key: Buffer): void {
    this.lock();
    this.vaultKey = key;
    this.touchVault();
  }

  private touchVault(): void {
    if (!this.vaultKey) return;
    this.vaultLastActivity = Date.now();
    if (this.vaultLockTimer) clearTimeout(this.vaultLockTimer);
    this.vaultLockTimer = setTimeout(() => this.lock(), this.vaultAutoLockMs);
    this.vaultLockTimer.unref();
  }

  private expireVaultIfNeeded(): void {
    if (this.vaultKey && Date.now() - this.vaultLastActivity >= this.vaultAutoLockMs) this.lock();
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
