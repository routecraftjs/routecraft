import { port } from "../../kernel/port.ts";

/**
 * A credential as the store holds it: an opaque JSON value with the version
 * a compare-and-swap writes against.
 */
export interface StoredCredential {
  /** What the owner stored. The store never reads inside it. */
  readonly value: unknown;
  /**
   * Bumped by every write. A writer passes the version it read as
   * `ifVersion`, so two writers racing on one owner cannot both win.
   */
  readonly version: number;
  /**
   * When the credential was obtained by a person (a `craft connect`), in
   * epoch milliseconds. Carried unchanged through refreshes, so an imported
   * seed replaces a stored credential only when a later login produced it.
   */
  readonly issuedAt: number;
  /** When the record was last written, in epoch milliseconds. */
  readonly updatedAt: number;
}

/** What a compare-and-swap write reports. */
export type CredentialWrite =
  | { readonly written: true; readonly version: number }
  | {
      readonly written: false;
      /** What the store holds instead, or undefined when the owner is gone. */
      readonly current: StoredCredential | undefined;
    };

/**
 * Where upstream credentials live, by owner.
 *
 * An owner names the thing a credential authenticates, such as `mcp:billing`
 * for the named MCP client `billing`. One owner holds one credential.
 *
 * Every write is a compare-and-swap, so several processes sharing a store
 * cannot both spend a refresh token that rotates: the loser's write is
 * refused, and it reads what the winner stored.
 */
export interface CredentialStore {
  /** The credential an owner holds, or undefined. */
  get(owner: string): Promise<StoredCredential | undefined>;
  /**
   * Write an owner's credential when the store still holds `ifVersion`:
   * `null` writes only when the owner holds nothing yet.
   *
   * @param options.issuedAt - When a person obtained it; defaults to the
   *   stored value's, or now for a first write
   */
  put(
    owner: string,
    value: unknown,
    options: { readonly ifVersion: number | null; readonly issuedAt?: number },
  ): Promise<CredentialWrite>;
  /**
   * Remove an owner's credential, only while it still holds `ifVersion`
   * when one is given.
   *
   * @returns Whether a record was removed
   */
  delete(
    owner: string,
    options?: { readonly ifVersion?: number },
  ): Promise<boolean>;
  /** Every owner and its credential. */
  list(): Promise<Array<StoredCredential & { readonly owner: string }>>;
  /** Release the store's handle. */
  close(): Promise<void>;
}

/**
 * The credential store, provided by the shipped credentials plugin and
 * replaceable by a plugin backed by a vault or a shared database.
 */
export const CREDENTIALS = port<CredentialStore>("routecraft.credentials@1");
