import type { SecretResolver } from "../../src/ports/index.js";

export class EnvironmentSecretResolver implements SecretResolver {
  readonly #environment: NodeJS.ProcessEnv;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.#environment = environment;
  }

  resolve(reference: string): Promise<string | undefined> {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(reference)) return Promise.resolve(undefined);
    const value = this.#environment[reference];
    return Promise.resolve(value && value.length > 0 ? value : undefined);
  }
}
