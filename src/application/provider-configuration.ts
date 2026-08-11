import type { ProviderProfile, ProviderProfileInput, VaultStatus } from "../domain/contracts.js";
import type { ProviderConfigurationService, ProviderProfileStore, SecretVault } from "../ports/index.js";

export class ProviderConfigurationManager implements ProviderConfigurationService {
  readonly #profiles: ProviderProfileStore;
  readonly #vault: SecretVault;

  constructor(profiles: ProviderProfileStore, vault: SecretVault) {
    this.#profiles = profiles;
    this.#vault = vault;
  }

  listProfiles(): Promise<readonly ProviderProfile[]> {
    return this.#profiles.listProfiles();
  }

  upsertProfile(profile: ProviderProfileInput): Promise<ProviderProfile> {
    return this.#profiles.upsertProfile(profile);
  }

  activateProfile(idOrName: string): Promise<ProviderProfile> {
    return this.#profiles.activateProfile(idOrName);
  }

  vaultStatus(): Promise<VaultStatus> {
    return this.#vault.status();
  }

  initializeVault(masterPassword: string): Promise<void> {
    return this.#vault.initialize(masterPassword);
  }

  unlockVault(masterPassword: string): Promise<void> {
    return this.#vault.unlock(masterPassword);
  }

  lockVault(): void {
    this.#vault.lock();
  }

  importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    return this.#vault.importCredential(profileId, secret);
  }

  removeCredential(profileId: string): Promise<ProviderProfile> {
    return this.#vault.removeCredential(profileId);
  }

  rotateVaultPassword(currentPassword: string, nextPassword: string): Promise<void> {
    return this.#vault.rotateMasterPassword(currentPassword, nextPassword);
  }

  resetVault(): Promise<number> {
    return this.#vault.reset();
  }
}
