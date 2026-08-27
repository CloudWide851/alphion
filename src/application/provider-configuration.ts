import type { ProjectCredentialStatus, ProviderProfile, ProviderProfileInput } from "../domain/contracts.js";
import type { ProjectCredentialStore, ProviderConfigurationService, ProviderProfileStore } from "../ports/index.js";

export class ProviderConfigurationManager implements ProviderConfigurationService {
  readonly #profiles: ProviderProfileStore;
  readonly #credentials: ProjectCredentialStore;

  constructor(profiles: ProviderProfileStore, credentials: ProjectCredentialStore) {
    this.#profiles = profiles;
    this.#credentials = credentials;
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

  async updateModelSettings(profileId: string, settings: Readonly<{ contextWindowTokens?: number; vision: boolean }>): Promise<ProviderProfile> {
    const profile = await this.#profiles.getProfile(profileId);
    if (!profile) throw new Error(`Unknown Provider profile: ${profileId}`);
    const { revision: _revision, contextWindowTokens: _contextWindowTokens, ...input } = profile;
    return this.#profiles.upsertProfile({ ...input, ...(settings.contextWindowTokens === undefined ? {} : { contextWindowTokens: settings.contextWindowTokens }), capabilities: { ...profile.capabilities, vision: settings.vision } });
  }

  credentialStatus(): Promise<ProjectCredentialStatus> { return this.#credentials.credentialStatus(); }

  importCredential(profileId: string, secret: string): Promise<ProviderProfile> {
    return this.#credentials.importCredential(profileId, secret);
  }

  removeCredential(profileId: string): Promise<ProviderProfile> {
    return this.#credentials.removeCredential(profileId);
  }
}
