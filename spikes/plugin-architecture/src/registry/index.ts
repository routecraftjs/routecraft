import type { Token } from "../contracts/index.ts";

export class UnresolvedTokenError extends Error {
  constructor(
    readonly tokenName: string,
    readonly requestedBy: string,
  ) {
    super(
      `"${requestedBy}" requires "${tokenName}", which no installed plugin provides. ` +
        `Add the plugin that provides it to your config.`,
    );
    this.name = "UnresolvedTokenError";
  }
}

/**
 * Service registry. Core stores values by token and never types them, which
 * is what lets a plugin expose an API core has never heard of.
 */
export class ServiceRegistry {
  readonly #values = new Map<symbol, unknown>();
  readonly #providers = new Map<symbol, string>();

  provide<T>(token: Token<T>, value: T, providerId: string): void {
    this.#values.set(token.key, value);
    this.#providers.set(token.key, providerId);
  }

  optional<T>(token: Token<T>): T | undefined {
    return this.#values.get(token.key) as T | undefined;
  }

  require<T>(token: Token<T>, requestedBy: string): T {
    if (!this.#values.has(token.key)) {
      throw new UnresolvedTokenError(token.name, requestedBy);
    }
    return this.#values.get(token.key) as T;
  }

  providerOf<T>(token: Token<T>): string | undefined {
    return this.#providers.get(token.key);
  }
}
