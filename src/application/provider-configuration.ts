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

  provisionVault(): Promise<void> { return this.#vault.provision(); }

  importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    return this.#vault.importCredential(profileId, secret);
  }

  removeCredential(profileId: string): Promise<ProviderProfile> {
    return this.#vault.removeCredential(profileId);
  }

  resetVault(): Promise<number> {
    return this.#vault.reset();
  }

  legacyVaultStatus(): Promise<Readonly<{ disabled: boolean; secretCount: number }>> { return this.#vault.legacyStatus(); }
  resetLegacyVault(): Promise<number> { return this.#vault.resetLegacy(); }
}
