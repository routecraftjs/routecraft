import type {
  CredentialStore,
  CredentialWrite,
  StoredCredential,
} from "./types.ts";

/**
 * A credential store in process memory. Credentials die with the process,
 * so a login has to be repeated after every restart; it exists for tests
 * and for runtimes with no SQLite driver.
 */
export class MemoryCredentialStore implements CredentialStore {
  readonly #records = new Map<string, StoredCredential>();

  async get(owner: string): Promise<StoredCredential | undefined> {
    return this.#records.get(owner);
  }

  async put(
    owner: string,
    value: unknown,
    options: { readonly ifVersion: number | null; readonly issuedAt?: number },
  ): Promise<CredentialWrite> {
    const current = this.#records.get(owner);
    if ((current?.version ?? null) !== options.ifVersion) {
      return { written: false, current };
    }
    const now = Date.now();
    const version = (current?.version ?? 0) + 1;
    // A structured clone, so a caller editing what it wrote cannot change
    // what the store holds, which a persistent store never allows either.
    this.#records.set(owner, {
      value: structuredClone(value),
      version,
      issuedAt: options.issuedAt ?? current?.issuedAt ?? now,
      updatedAt: now,
    });
    return { written: true, version };
  }

  async delete(
    owner: string,
    options: { readonly ifVersion?: number } = {},
  ): Promise<boolean> {
    const current = this.#records.get(owner);
    if (current === undefined) return false;
    if (
      options.ifVersion !== undefined &&
      current.version !== options.ifVersion
    ) {
      return false;
    }
    return this.#records.delete(owner);
  }

  async list(): Promise<Array<StoredCredential & { readonly owner: string }>> {
    return [...this.#records]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([owner, record]) => ({ owner, ...structuredClone(record) }));
  }

  async close(): Promise<void> {
    this.#records.clear();
  }
}
