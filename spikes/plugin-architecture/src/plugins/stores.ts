import type { Plugin } from "../contracts/index.ts";
import { token } from "../contracts/index.ts";

export interface RecordStore {
  get(key: string): Promise<{ value: unknown; version: number } | undefined>;
  put(
    key: string,
    value: unknown,
    options?: { ifVersion?: number },
  ): Promise<{ won: boolean }>;
  list(prefix: string): Promise<readonly string[]>;
}

export interface StoreApi {
  open(namespace: string): RecordStore;
  namespaces(): readonly string[];
}

/** Published by the store plugin, imported by whoever needs it. */
export const STORE_API = token<StoreApi>("routecraft.stores.api");

class MemoryRecordStore implements RecordStore {
  readonly #rows = new Map<string, { value: unknown; version: number }>();

  get(key: string) {
    return Promise.resolve(this.#rows.get(key));
  }

  put(key: string, value: unknown, options?: { ifVersion?: number }) {
    const current = this.#rows.get(key);
    if (options?.ifVersion !== undefined) {
      const expected = options.ifVersion;
      const actual = current?.version ?? 0;
      if (expected !== actual) return Promise.resolve({ won: false });
    }
    this.#rows.set(key, { value, version: (current?.version ?? 0) + 1 });
    return Promise.resolve({ won: true });
  }

  list(prefix: string) {
    return Promise.resolve(
      [...this.#rows.keys()].filter((k) => k.startsWith(prefix)).sort(),
    );
  }
}

export function stores(): Plugin {
  const opened = new Map<string, RecordStore>();
  return {
    id: "routecraft.stores",
    apply(ctx) {
      ctx.provide(STORE_API, {
        open(namespace) {
          let store = opened.get(namespace);
          if (store === undefined) {
            store = new MemoryRecordStore();
            opened.set(namespace, store);
          }
          return store;
        },
        namespaces: () => [...opened.keys()],
      });
    },
    health: () => ({ up: true, detail: `${opened.size} namespace(s)` }),
  };
}
