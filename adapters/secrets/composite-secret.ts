import type { SecretResolver } from "../../src/ports/index.js";

export class CompositeSecretResolver implements SecretResolver {
  readonly #resolvers: readonly SecretResolver[];

  constructor(resolvers: readonly SecretResolver[]) {
    this.#resolvers = [...resolvers];
  }

  async resolve(reference: string): Promise<string | undefined> {
    for (const resolver of this.#resolvers) {
      const value = await resolver.resolve(reference);
      if (value !== undefined) return value;
    }
    return undefined;
  }
}
