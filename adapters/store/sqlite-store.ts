import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ProviderProfile, ProviderProfileInput, ShellRule, VaultStatus } from "../../src/domain/contracts.js";
import type {
  CacheEntry,
  CacheStats,
  CacheStore,
  EventStore,
  ProviderProfileStore,
  SecretVault,
  ShellPolicyStore,
} from "../../src/ports/index.js";
import type { AgentEvent, AgentEventDraft } from "../../src/protocol/events.js";
import { canonicalJson, createId, sha256 } from "../../src/application/canonical.js";
import { AlphionError } from "../../src/application/errors.js";
import { containsPotentialSecret, sanitizeRecord } from "../../src/application/sensitive-data.js";

const SCHEMA_VERSION = 2;
const VAULT_SCHEMA_VERSION = 1;
const VAULT_AUTO_LOCK_MS = 15 * 60 * 1000;
const VAULT_VERIFIER = "alphion-vault-verifier-v1";
const SCRYPT_OPTIONS = Object.freeze({ N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
const OPEN_DATABASES = new Set<string>();

export interface SqliteStoreOptions {
  readonly path: string;
  readonly vaultAutoLockMs?: number;
}

export class SqliteStore
  implements EventStore, CacheStore, ProviderProfileStore, SecretVault, ShellPolicyStore
{
  readonly #database: DatabaseSync;
  readonly #databaseKey: string;
  #closed = false;
  #vaultKey: Buffer | undefined;
  #vaultLastActivity = 0;
  #vaultLockTimer: NodeJS.Timeout | undefined;
  readonly #vaultAutoLockMs: number;

  constructor(options: SqliteStoreOptions) {
    const databasePath = resolve(options.path);
    this.#databaseKey = pathKey(databasePath);
    this.#vaultAutoLockMs = options.vaultAutoLockMs ?? VAULT_AUTO_LOCK_MS;
    if (!Number.isSafeInteger(this.#vaultAutoLockMs) || this.#vaultAutoLockMs <= 0) {
      throw new AlphionError("validation", "Vault auto-lock duration must be a positive safe integer.", { stage: "vault" });
    }
    if (OPEN_DATABASES.has(this.#databaseKey)) {
      throw new AlphionError("conflict", "This process already has a writer open for the SQLite state file.", {
        stage: "database",
      });
    }
    mkdirSync(dirname(databasePath), { recursive: true });
    let database: DatabaseSync | undefined;
    OPEN_DATABASES.add(this.#databaseKey);
    try {
      database = new DatabaseSync(databasePath);
      this.#database = database;
      this.#database.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;");
      this.#assertIntegrity();
      this.#migrate();
    } catch (error) {
      database?.close();
      OPEN_DATABASES.delete(this.#databaseKey);
      if (error instanceof AlphionError) throw error;
      throw new AlphionError("integrity-failed", "SQLite state could not be opened or validated.", {
        stage: "database",
        cause: error,
      });
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.lock();
    this.#database.close();
    OPEN_DATABASES.delete(this.#databaseKey);
  }

  async append(draft: AgentEventDraft): Promise<AgentEvent> {
    const event = this.#transaction(() => {
      const safePayload = sanitizeRecord(draft.payload);
      const previousRow = this.#database
        .prepare("SELECT sequence, digest FROM events WHERE run_id = ? ORDER BY sequence DESC LIMIT 1")
        .get(draft.runId);
      const previous = optionalRow(previousRow);
      const sequence = previous ? readNumber(previous, "sequence") + 1 : 1;
      const previousDigest = previous ? readString(previous, "digest") : "0".repeat(64);
      const eventId = createId("event");
      const timestamp = new Date().toISOString();
      const digest = sha256(
        canonicalJson({
          schemaVersion: 1,
          eventId,
          sequence,
          runId: draft.runId,
          sessionId: draft.sessionId,
          correlationId: draft.correlationId,
          ...(draft.causationId ? { causationId: draft.causationId } : {}),
          timestamp,
          kind: draft.kind,
          payload: safePayload,
          previousDigest,
        }),
      );
      const event: AgentEvent = {
        schemaVersion: 1,
        eventId,
        sequence,
        runId: draft.runId,
        sessionId: draft.sessionId,
        correlationId: draft.correlationId,
        ...(draft.causationId ? { causationId: draft.causationId } : {}),
        timestamp,
        kind: draft.kind,
        payload: safePayload,
        previousDigest,
        digest,
      };
      if (event.kind === "run.started") {
        this.#database
          .prepare(
            "INSERT INTO runs (run_id, session_id, status, created_at, updated_at) VALUES (?, ?, 'running', ?, ?)",
          )
          .run(event.runId, event.sessionId, event.timestamp, event.timestamp);
      }
      this.#database
        .prepare(
          `INSERT INTO events
           (run_id, sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.runId,
          event.sequence,
          event.eventId,
          event.sessionId,
          event.correlationId,
          event.causationId ?? null,
          event.timestamp,
          event.kind,
          JSON.stringify(event.payload),
          event.previousDigest,
          event.digest,
        );
      if (event.kind === "run.completed" || event.kind === "run.failed" || event.kind === "run.cancelled") {
        const status = event.kind.slice("run.".length);
        this.#database.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE run_id = ?").run(status, event.timestamp, event.runId);
      }
      return event;
    });
    return event;
  }

  async verifyRun(runId: string): Promise<boolean> {
    const rows = this.#database
      .prepare(
        `SELECT sequence, event_id, session_id, correlation_id, causation_id, timestamp, kind, payload_json, previous_digest, digest
         FROM events WHERE run_id = ? ORDER BY sequence`,
      )
      .all(runId);
    let expectedSequence = 1;
    let previousDigest = "0".repeat(64);
    for (const value of rows) {
      const row = requiredRow(value);
      const sequence = readNumber(row, "sequence");
      if (sequence !== expectedSequence || readString(row, "previous_digest") !== previousDigest) return false;
      const payload = parseRecord(readString(row, "payload_json"));
      const eventShape = {
        schemaVersion: 1,
        eventId: readString(row, "event_id"),
        sequence,
        runId,
        sessionId: readString(row, "session_id"),
        correlationId: readString(row, "correlation_id"),
        ...(readNullableString(row, "causation_id") ? { causationId: readNullableString(row, "causation_id") } : {}),
        timestamp: readString(row, "timestamp"),
        kind: readString(row, "kind"),
        payload,
        previousDigest,
      };
      const digest = sha256(canonicalJson(eventShape));
      if (digest !== readString(row, "digest")) return false;
      previousDigest = digest;
      expectedSequence += 1;
    }
    return rows.length > 0;
  }

  async upsertProfile(
    input: ProviderProfileInput,
  ): Promise<ProviderProfile> {
    const normalized = validateProviderProfile(input);
    const profile = this.#transaction(() => {
      const existing = optionalRow(this.#database.prepare("SELECT revision, active FROM provider_profiles WHERE id = ?").get(input.id));
      const revision = existing ? readNumber(existing, "revision") + 1 : 1;
      const active = input.active ?? (existing ? readNumber(existing, "active") === 1 : false);
      if (input.auth.mode === "encrypted-sqlite") {
        const secret = optionalRow(
          this.#database
            .prepare("SELECT profile_id FROM vault_secrets WHERE secret_id = ?")
            .get(input.auth.secretId),
        );
        if (!secret || readString(secret, "profile_id") !== input.id) {
          throw new AlphionError("validation", "Vault credential reference does not belong to this profile.", {
            stage: "config",
          });
        }
      }
      if (active) this.#database.exec("UPDATE provider_profiles SET active = 0");
      const now = new Date().toISOString();
      this.#database
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
      return this.#getProfile(input.id);
    });
    return profile;
  }

  async listProfiles(): Promise<readonly ProviderProfile[]> {
    const rows = this.#database.prepare("SELECT * FROM provider_profiles ORDER BY active DESC, name").all();
    return rows.map((row) => decodeProviderProfile(requiredRow(row)));
  }

  async getProfile(idOrName: string): Promise<ProviderProfile | undefined> {
    const row = optionalRow(
      this.#database.prepare("SELECT * FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName),
    );
    return row ? decodeProviderProfile(row) : undefined;
  }

  async getActiveProfile(): Promise<ProviderProfile | undefined> {
    const row = optionalRow(this.#database.prepare("SELECT * FROM provider_profiles WHERE active = 1 LIMIT 1").get());
    return row ? decodeProviderProfile(row) : undefined;
  }

  async activateProfile(idOrName: string): Promise<ProviderProfile> {
    const profile = this.#transaction(() => {
      const found = optionalRow(
        this.#database.prepare("SELECT id FROM provider_profiles WHERE id = ? OR name = ? LIMIT 1").get(idOrName, idOrName),
      );
      if (!found) throw new AlphionError("validation", `Unknown provider profile: ${idOrName}`, { stage: "config" });
      const id = readString(found, "id");
      this.#database.exec("UPDATE provider_profiles SET active = 0");
      this.#database.prepare("UPDATE provider_profiles SET active = 1, revision = revision + 1, updated_at = ? WHERE id = ?").run(new Date().toISOString(), id);
      return this.#getProfile(id);
    });
    return profile;
  }

  async status(): Promise<VaultStatus> {
    this.#expireVaultIfNeeded();
    const initialized = optionalRow(this.#database.prepare("SELECT id FROM vault_metadata WHERE id = 1").get()) !== undefined;
    const count = requiredRow(this.#database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get());
    return {
      initialized,
      locked: this.#vaultKey === undefined,
      secretCount: readNumber(count, "count"),
      autoLockMs: this.#vaultAutoLockMs,
    };
  }

  async initialize(masterPassword: string): Promise<void> {
    validateMasterPassword(masterPassword);
    if (optionalRow(this.#database.prepare("SELECT id FROM vault_metadata WHERE id = 1").get())) {
      throw new AlphionError("conflict", "Credential vault is already initialized.", { stage: "vault" });
    }
    const salt = randomBytes(16);
    const key = deriveVaultKey(masterPassword, salt);
    const verifier = encryptValue(key, Buffer.from(VAULT_VERIFIER), vaultVerifierAad());
    try {
      this.#transaction(() => {
        this.#database
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
      this.#setVaultKey(key);
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }

  async unlock(masterPassword: string): Promise<void> {
    const metadata = this.#readVaultMetadata();
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
      this.#setVaultKey(key);
    } catch (error) {
      key.fill(0);
      throw new AlphionError("forbidden", "Credential vault could not be unlocked.", { stage: "vault", cause: error });
    }
  }

  lock(): void {
    if (this.#vaultLockTimer) clearTimeout(this.#vaultLockTimer);
    this.#vaultLockTimer = undefined;
    this.#vaultLastActivity = 0;
    this.#vaultKey?.fill(0);
    this.#vaultKey = undefined;
  }

  async resolve(reference: string): Promise<string | undefined> {
    if (!/^vault_[A-Za-z0-9_-]{8,}$/.test(reference)) return undefined;
    const key = this.#requireVaultKey();
    const row = optionalRow(
      this.#database
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
      this.#touchVault();
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
    const key = this.#requireVaultKey();
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    const existing = optionalRow(
      this.#database.prepare("SELECT secret_id, revision FROM vault_secrets WHERE profile_id = ?").get(profile.id),
    );
    const secretId = existing ? readString(existing, "secret_id") : createId("vault");
    const secretRevision = existing ? readNumber(existing, "revision") + 1 : 1;
    const encrypted = encryptValue(
      key,
      Buffer.from(secret, "utf8"),
      secretAad(secretId, profile.id, secretRevision),
    );
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database
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
      this.#database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'encrypted-sqlite', auth_environment_variable = NULL, auth_secret_id = ?, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(secretId, now, profile.id);
    });
    this.#touchVault();
    return this.#getProfile(profile.id);
  }

  async removeCredential(profileId: string): Promise<ProviderProfile> {
    this.#requireVaultKey();
    const profile = await this.getProfile(profileId);
    if (!profile) throw new AlphionError("validation", `Unknown provider profile: ${profileId}`, { stage: "vault" });
    this.#transaction(() => {
      this.#database.prepare("DELETE FROM vault_secrets WHERE profile_id = ?").run(profile.id);
      this.#database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'none', auth_environment_variable = NULL, auth_secret_id = NULL, revision = revision + 1, updated_at = ?
           WHERE id = ?`,
        )
        .run(new Date().toISOString(), profile.id);
    });
    this.#touchVault();
    return this.#getProfile(profile.id);
  }

  async rotateMasterPassword(currentPassword: string, nextPassword: string): Promise<void> {
    validateMasterPassword(nextPassword);
    const metadata = this.#readVaultMetadata();
    const currentKey = deriveVaultKey(currentPassword, metadata.salt);
    const rows = this.#database
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
        this.#transaction(() => {
          this.#database
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
          const update = this.#database.prepare(
            "UPDATE vault_secrets SET nonce = ?, ciphertext = ?, auth_tag = ?, updated_at = ? WHERE secret_id = ?",
          );
          for (const item of encrypted) {
            update.run(item.value.nonce, item.value.ciphertext, item.value.authTag, new Date().toISOString(), item.secretId);
          }
        });
        this.#setVaultKey(nextKey);
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
    const count = requiredRow(this.#database.prepare("SELECT COUNT(*) AS count FROM vault_secrets").get());
    const deleted = readNumber(count, "count");
    this.#transaction(() => {
      const now = new Date().toISOString();
      this.#database.prepare("DELETE FROM vault_secrets").run();
      this.#database
        .prepare(
          `UPDATE provider_profiles
           SET auth_mode = 'none', auth_environment_variable = NULL, auth_secret_id = NULL, revision = revision + 1, updated_at = ?
           WHERE auth_mode = 'encrypted-sqlite'`,
        )
        .run(now);
      this.#database.prepare("DELETE FROM vault_metadata WHERE id = 1").run();
    });
    this.lock();
    return deleted;
  }

  async get(namespace: string, key: string): Promise<CacheEntry | undefined> {
    const row = optionalRow(
      this.#database.prepare("SELECT * FROM cache_entries WHERE namespace = ? AND cache_key = ?").get(namespace, key),
    );
    if (!row || Date.parse(readString(row, "expires_at")) <= Date.now()) {
      if (row) this.#database.prepare("DELETE FROM cache_entries WHERE namespace = ? AND cache_key = ?").run(namespace, key);
      this.#database.prepare("UPDATE cache_metrics SET misses = misses + 1 WHERE id = 1").run();
      return undefined;
    }
    this.#database
      .prepare("UPDATE cache_entries SET hit_count = hit_count + 1, last_accessed_at = ? WHERE namespace = ? AND cache_key = ?")
      .run(new Date().toISOString(), namespace, key);
    this.#database.prepare("UPDATE cache_metrics SET hits = hits + 1 WHERE id = 1").run();
    return decodeCacheEntry(row);
  }

  async set(entry: CacheEntry): Promise<void> {
    if (containsPotentialSecret(entry.value) || containsPotentialSecret(entry.provenance)) {
      throw new AlphionError("forbidden", "Potential secrets cannot be written to persistent cache.", { stage: "cache" });
    }
    const bytes = Buffer.byteLength(entry.value) + Buffer.byteLength(entry.provenance);
    this.#database
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
    this.#pruneCache();
  }

  async delete(namespace?: string): Promise<number> {
    const result = namespace
      ? this.#database.prepare("DELETE FROM cache_entries WHERE namespace = ?").run(namespace)
      : this.#database.prepare("DELETE FROM cache_entries").run();
    return Number(result.changes);
  }

  async stats(): Promise<CacheStats> {
    const aggregate = requiredRow(
      this.#database.prepare("SELECT COUNT(*) AS entries, COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get(),
    );
    const metrics = requiredRow(this.#database.prepare("SELECT hits, misses FROM cache_metrics WHERE id = 1").get());
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
    this.#database
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
    return this.#database.prepare("SELECT * FROM shell_rules ORDER BY created_at").all().map((row) => decodeShellRule(requiredRow(row)));
  }

  async removeShellRule(id: string): Promise<boolean> {
    const result = this.#database.prepare("DELETE FROM shell_rules WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  async findAllowed(executablePath: string, args: readonly string[]): Promise<ShellRule | undefined> {
    const resolvedExecutable = await realpath(resolve(executablePath)).catch(() => undefined);
    if (!resolvedExecutable) return undefined;
    const rows = this.#database
      .prepare("SELECT * FROM shell_rules WHERE executable_key = ? AND enabled = 1 ORDER BY created_at")
      .all(pathKey(resolvedExecutable));
    for (const row of rows) {
      const rule = decodeShellRule(requiredRow(row));
      if (rule.argumentPrefix.every((argument, index) => args[index] === argument)) return rule;
    }
    return undefined;
  }

  #getProfile(id: string): ProviderProfile {
    const row = optionalRow(this.#database.prepare("SELECT * FROM provider_profiles WHERE id = ?").get(id));
    if (!row) throw new AlphionError("internal", "Provider profile disappeared during transaction.", { stage: "database" });
    return decodeProviderProfile(row);
  }

  #readVaultMetadata(): VaultMetadata {
    const row = optionalRow(this.#database.prepare("SELECT * FROM vault_metadata WHERE id = 1").get());
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

  #requireVaultKey(): Buffer {
    this.#expireVaultIfNeeded();
    if (!this.#vaultKey) {
      throw new AlphionError("forbidden", "Credential vault is locked.", { stage: "vault" });
    }
    this.#touchVault();
    return this.#vaultKey;
  }

  #setVaultKey(key: Buffer): void {
    this.lock();
    this.#vaultKey = key;
    this.#touchVault();
  }

  #touchVault(): void {
    if (!this.#vaultKey) return;
    this.#vaultLastActivity = Date.now();
    if (this.#vaultLockTimer) clearTimeout(this.#vaultLockTimer);
    this.#vaultLockTimer = setTimeout(() => this.lock(), this.#vaultAutoLockMs);
    this.#vaultLockTimer.unref();
  }

  #expireVaultIfNeeded(): void {
    if (this.#vaultKey && Date.now() - this.#vaultLastActivity >= this.#vaultAutoLockMs) this.lock();
  }

  #migrate(): void {
    const row = requiredRow(this.#database.prepare("PRAGMA user_version").get());
    const current = readNumber(row, "user_version");
    if (current > SCHEMA_VERSION) {
      throw new AlphionError("incompatible-schema", `SQLite schema ${current} is newer than supported ${SCHEMA_VERSION}.`, {
        stage: "database",
      });
    }
    if (current === SCHEMA_VERSION) return;
    if (current === 0) {
      this.#transaction(() => this.#createSchemaV2());
      return;
    }
    if (current !== 1) {
      throw new AlphionError("incompatible-schema", `SQLite schema ${current} cannot be migrated.`, { stage: "database" });
    }
    this.#transaction(() => {
      this.#database.exec(`
        DROP INDEX provider_profiles_one_active;
        ALTER TABLE provider_profiles RENAME TO provider_profiles_v1;
      `);
      this.#createProviderProfilesV2();
      const rows = this.#database.prepare("SELECT * FROM provider_profiles_v1 ORDER BY id").all().map(requiredRow);
      const insert = this.#database.prepare(
        `INSERT INTO provider_profiles
         (id, name, provider_kind, base_url, model, protocol, auth_mode, auth_environment_variable, auth_secret_id, capabilities_json, revision, active, created_at, updated_at)
         VALUES (?, ?, 'openai-compatible', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        const capabilities = parseRecord(readString(row, "capabilities_json"));
        insert.run(
          readString(row, "id"),
          readString(row, "name"),
          readString(row, "base_url"),
          readString(row, "model"),
          readString(row, "protocol"),
          readString(row, "auth_mode"),
          readNullableString(row, "auth_environment_variable") ?? null,
          JSON.stringify({
            streaming: readBoolean(capabilities, "streaming"),
            tools: readBoolean(capabilities, "tools"),
            promptCaching: readBoolean(capabilities, "promptCaching"),
            reasoning: false,
          }),
          readNumber(row, "revision"),
          readNumber(row, "active"),
          readString(row, "created_at"),
          readString(row, "updated_at"),
        );
      }
      this.#database.exec("DROP TABLE provider_profiles_v1");
      this.#createVaultTables();
      this.#database.exec("PRAGMA user_version = 2");
    });
  }

  #createSchemaV2(): void {
    this.#createProviderProfilesV2();
    this.#database.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE events (
          run_id TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          event_id TEXT NOT NULL UNIQUE,
          session_id TEXT NOT NULL,
          correlation_id TEXT NOT NULL,
          causation_id TEXT,
          timestamp TEXT NOT NULL,
          kind TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          previous_digest TEXT NOT NULL,
          digest TEXT NOT NULL,
          PRIMARY KEY (run_id, sequence)
        );
        CREATE TABLE cache_entries (
          namespace TEXT NOT NULL,
          cache_key TEXT NOT NULL,
          value_text TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          provenance TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          hit_count INTEGER NOT NULL,
          last_accessed_at TEXT NOT NULL,
          PRIMARY KEY (namespace, cache_key)
        );
        CREATE INDEX cache_entries_lru ON cache_entries(last_accessed_at);
        CREATE TABLE cache_metrics (id INTEGER PRIMARY KEY CHECK (id = 1), hits INTEGER NOT NULL, misses INTEGER NOT NULL);
        INSERT INTO cache_metrics (id, hits, misses) VALUES (1, 0, 0);
        CREATE TABLE shell_rules (
          id TEXT PRIMARY KEY,
          executable_path TEXT NOT NULL,
          executable_key TEXT NOT NULL,
          executable_digest TEXT,
          argument_prefix_json TEXT NOT NULL,
          enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL
        );
        CREATE INDEX shell_rules_lookup ON shell_rules(executable_key, enabled);
    `);
    this.#createVaultTables();
    this.#database.exec("PRAGMA user_version = 2");
  }

  #createProviderProfilesV2(): void {
    this.#database.exec(`
        CREATE TABLE provider_profiles (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          provider_kind TEXT NOT NULL CHECK (provider_kind IN ('openai-compatible', 'deepseek')),
          base_url TEXT NOT NULL,
          model TEXT NOT NULL,
          protocol TEXT NOT NULL CHECK (protocol IN ('chat-completions', 'responses')),
          auth_mode TEXT NOT NULL CHECK (auth_mode IN ('none', 'bearer-env', 'encrypted-sqlite')),
          auth_environment_variable TEXT,
          auth_secret_id TEXT,
          capabilities_json TEXT NOT NULL,
          revision INTEGER NOT NULL,
          active INTEGER NOT NULL CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX provider_profiles_one_active ON provider_profiles(active) WHERE active = 1;
    `);
  }

  #createVaultTables(): void {
    this.#database.exec(`
      CREATE TABLE vault_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        kdf TEXT NOT NULL,
        salt BLOB NOT NULL,
        work_factor INTEGER NOT NULL,
        block_size INTEGER NOT NULL,
        parallelism INTEGER NOT NULL,
        verifier_nonce BLOB NOT NULL,
        verifier_ciphertext BLOB NOT NULL,
        verifier_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE vault_secrets (
        secret_id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL UNIQUE REFERENCES provider_profiles(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL,
        nonce BLOB NOT NULL,
        ciphertext BLOB NOT NULL,
        auth_tag BLOB NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  #assertIntegrity(): void {
    const rows = this.#database.prepare("PRAGMA quick_check").all();
    const valid = rows.length === 1 && Object.values(requiredRow(rows[0]))[0] === "ok";
    if (!valid) {
      throw new AlphionError("integrity-failed", "SQLite quick integrity check failed.", { stage: "database" });
    }
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #pruneCache(): void {
    const maxBytes = 256 * 1024 * 1024;
    const row = requiredRow(this.#database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get());
    if (readNumber(row, "bytes") <= maxBytes) return;
    const targetBytes = Math.floor(maxBytes * 0.8);
    while (true) {
      const current = requiredRow(this.#database.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM cache_entries").get());
      if (readNumber(current, "bytes") <= targetBytes) break;
      this.#database.prepare("DELETE FROM cache_entries WHERE rowid IN (SELECT rowid FROM cache_entries ORDER BY last_accessed_at LIMIT 32)").run();
    }
  }
}

function validateProviderProfile(
  input: ProviderProfileInput,
): { readonly baseUrl: string } {
  if (
    input.schemaVersion !== 2 ||
    input.id.trim().length === 0 ||
    input.name.trim().length === 0 ||
    input.model.trim().length === 0 ||
    input.id.length > 128 ||
    input.name.length > 256 ||
    input.model.length > 256
  ) {
    throw new AlphionError("validation", "Provider id, name, model, and schema version 2 are required.", { stage: "config" });
  }
  if (containsPotentialSecret([input.id, input.name, input.model, input.baseUrl])) {
    throw new AlphionError("validation", "Provider profile fields must not contain credential material.", { stage: "config" });
  }
  if (input.protocol !== "chat-completions" && input.protocol !== "responses") {
    throw new AlphionError("validation", "Provider protocol is unsupported.", { stage: "config" });
  }
  if (input.kind !== "openai-compatible" && input.kind !== "deepseek") {
    throw new AlphionError("validation", "Provider kind is unsupported.", { stage: "config" });
  }
  if (input.kind === "deepseek" && input.protocol !== "chat-completions") {
    throw new AlphionError("validation", "DeepSeek profiles only support Chat Completions.", { stage: "config" });
  }
  if (
    typeof input.capabilities.streaming !== "boolean" ||
    typeof input.capabilities.tools !== "boolean" ||
    typeof input.capabilities.promptCaching !== "boolean" ||
    typeof input.capabilities.reasoning !== "boolean"
  ) {
    throw new AlphionError("validation", "Provider capabilities must be booleans.", { stage: "config" });
  }
  if (input.auth.mode !== "none" && input.auth.mode !== "bearer-env" && input.auth.mode !== "encrypted-sqlite") {
    throw new AlphionError("validation", "Provider authentication mode is unsupported.", { stage: "config" });
  }
  let url: URL;
  try {
    url = new URL(input.baseUrl);
  } catch (error) {
    throw new AlphionError("validation", "Provider URL is invalid.", { stage: "config", cause: error });
  }
  if (!isAllowedProviderUrl(url)) {
    throw new AlphionError("validation", "Provider URL must use HTTPS, or HTTP on a loopback host, without credentials/query/fragment.", {
      stage: "config",
    });
  }
  if (input.auth.mode === "bearer-env" && !/^[A-Z_][A-Z0-9_]*$/.test(input.auth.environmentVariable)) {
    throw new AlphionError("validation", "Secret references must be portable uppercase environment-variable names.", { stage: "config" });
  }
  if (input.auth.mode === "encrypted-sqlite" && !/^vault_[A-Za-z0-9_-]{8,}$/.test(input.auth.secretId)) {
    throw new AlphionError("validation", "Vault secret reference is invalid.", { stage: "config" });
  }
  return { baseUrl: url.toString().replace(/\/$/, "") };
}

function isAllowedProviderUrl(url: URL): boolean {
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}

function decodeProviderProfile(row: Readonly<Record<string, unknown>>): ProviderProfile {
  const kind = readString(row, "provider_kind");
  if (kind !== "openai-compatible" && kind !== "deepseek") {
    throw new AlphionError("integrity-failed", `Invalid provider kind: ${kind}`, { stage: "database" });
  }
  const protocol = readString(row, "protocol");
  if (protocol !== "chat-completions" && protocol !== "responses") {
    throw new AlphionError("integrity-failed", `Invalid provider protocol: ${protocol}`, { stage: "database" });
  }
  const authMode = readString(row, "auth_mode");
  const capabilities = parseRecord(readString(row, "capabilities_json"));
  const streaming = readBoolean(capabilities, "streaming");
  const tools = readBoolean(capabilities, "tools");
  const promptCaching = readBoolean(capabilities, "promptCaching");
  const reasoning = readBoolean(capabilities, "reasoning");
  const auth = authMode === "none"
    ? ({ mode: "none" } as const)
    : authMode === "bearer-env"
      ? ({ mode: "bearer-env", environmentVariable: requireNullableString(row, "auth_environment_variable") } as const)
      : authMode === "encrypted-sqlite"
        ? ({ mode: "encrypted-sqlite", secretId: requireNullableString(row, "auth_secret_id") } as const)
        : undefined;
  if (!auth) throw new AlphionError("integrity-failed", `Invalid provider auth mode: ${authMode}`, { stage: "database" });
  return {
    schemaVersion: 2,
    id: readString(row, "id"),
    name: readString(row, "name"),
    kind,
    baseUrl: readString(row, "base_url"),
    model: readString(row, "model"),
    protocol,
    auth,
    capabilities: { streaming, tools, promptCaching, reasoning },
    revision: readNumber(row, "revision"),
    active: readNumber(row, "active") === 1,
  };
}

function decodeCacheEntry(row: Readonly<Record<string, unknown>>): CacheEntry {
  return {
    namespace: readString(row, "namespace"),
    key: readString(row, "cache_key"),
    value: readString(row, "value_text"),
    createdAt: readString(row, "created_at"),
    expiresAt: readString(row, "expires_at"),
    provenance: readString(row, "provenance"),
  };
}

function decodeShellRule(row: Readonly<Record<string, unknown>>): ShellRule {
  const argumentsValue = JSON.parse(readString(row, "argument_prefix_json")) as unknown;
  if (!Array.isArray(argumentsValue) || !argumentsValue.every((item) => typeof item === "string")) {
    throw new AlphionError("integrity-failed", "Invalid shell rule argument prefix.", { stage: "database" });
  }
  const digest = readNullableString(row, "executable_digest");
  return {
    schemaVersion: 1,
    id: readString(row, "id"),
    executablePath: readString(row, "executable_path"),
    ...(digest ? { executableDigest: digest } : {}),
    argumentPrefix: argumentsValue,
    enabled: readNumber(row, "enabled") === 1,
  };
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function optionalRow(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value === undefined ? undefined : requiredRow(value);
}

function requiredRow(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AlphionError("integrity-failed", "SQLite returned an invalid row.", { stage: "database" });
  }
  return value as Readonly<Record<string, unknown>>;
}

function readString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new AlphionError("integrity-failed", `Expected text column ${key}.`, { stage: "database" });
  return value;
}

function readNullableString(row: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = row[key];
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new AlphionError("integrity-failed", `Expected nullable text column ${key}.`, { stage: "database" });
  return value;
}

function requireNullableString(row: Readonly<Record<string, unknown>>, key: string): string {
  const value = readNullableString(row, key);
  if (!value) throw new AlphionError("integrity-failed", `Missing text column ${key}.`, { stage: "database" });
  return value;
}

function readNumber(row: Readonly<Record<string, unknown>>, key: string): number {
  const value = row[key];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw new AlphionError("integrity-failed", `Expected numeric column ${key}.`, { stage: "database" });
}

function readBuffer(row: Readonly<Record<string, unknown>>, key: string): Buffer {
  const value = row[key];
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  if (value instanceof Uint8Array) return Buffer.from(value);
  throw new AlphionError("integrity-failed", `Expected binary column ${key}.`, { stage: "database" });
}

function readBoolean(row: Readonly<Record<string, unknown>>, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new AlphionError("integrity-failed", `Expected boolean field ${key}.`, { stage: "database" });
  return value;
}

function parseRecord(serialized: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new AlphionError("integrity-failed", "Stored JSON is invalid.", { stage: "database", cause: error });
  }
  return requiredRow(value);
}

interface VaultMetadata {
  readonly salt: Buffer;
  readonly verifierNonce: Buffer;
  readonly verifierCiphertext: Buffer;
  readonly verifierTag: Buffer;
}

interface EncryptedValue {
  readonly nonce: Buffer;
  readonly ciphertext: Buffer;
  readonly authTag: Buffer;
}

function validateMasterPassword(value: string): void {
  if (value.length < 12 || value.length > 1024 || value.includes("\0")) {
    throw new AlphionError("validation", "Master password must contain between 12 and 1024 characters.", {
      stage: "vault",
    });
  }
}

function deriveVaultKey(password: string, salt: Buffer): Buffer {
  try {
    return scryptSync(password, salt, 32, SCRYPT_OPTIONS);
  } catch (error) {
    throw new AlphionError("internal", "Credential vault key derivation failed.", { stage: "vault", cause: error });
  }
}

function encryptValue(key: Buffer, plaintext: Buffer, aad: Buffer): EncryptedValue {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { nonce, ciphertext, authTag: cipher.getAuthTag() };
}

function decryptValue(
  key: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  authTag: Buffer,
  aad: Buffer,
): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  decipher.setAAD(aad);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function vaultVerifierAad(): Buffer {
  return Buffer.from(canonicalJson({ schemaVersion: VAULT_SCHEMA_VERSION, kind: "vault-verifier" }), "utf8");
}

function secretAad(secretId: string, profileId: string, revision: number): Buffer {
  return Buffer.from(
    canonicalJson({ schemaVersion: VAULT_SCHEMA_VERSION, kind: "provider-credential", secretId, profileId, revision }),
    "utf8",
  );
}
