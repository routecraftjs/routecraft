/**
 * CardDAV adapter type definitions.
 *
 * The adapter reads and writes vCard documents ({@link VCard}) over CardDAV.
 * Credentials live in context-level named accounts (see
 * {@link CarddavContextConfig}); per-adapter options select which account and
 * address book to use.
 *
 * @experimental
 */

import type { Exchange } from "../../exchange.ts";

// ---------------------------------------------------------------------------
// Context-level configuration (named accounts)
// ---------------------------------------------------------------------------

/**
 * Connection settings for a named CardDAV account.
 *
 * For iCloud, `username` is the Apple ID and `appPassword` is an app-specific
 * password generated at appleid.apple.com (not the account password).
 * `serverUrl` defaults to iCloud when omitted.
 */
export interface CarddavAccountConfig {
  /** DAV server base URL (default: iCloud `https://contacts.icloud.com`). */
  serverUrl?: string;
  /** Account username (Apple ID for iCloud). */
  username: string;
  /** App-specific password (Basic auth secret). Never logged. */
  appPassword: string;
  /** Default address book display name for this account. */
  addressBook?: string;
}

/**
 * Context-level CardDAV configuration. Added to {@link CraftConfig} via
 * `defineConfig({ carddav: {...} })` or `new CraftContext({ carddav: {...} })`.
 *
 * @example
 * ```typescript
 * defineConfig({
 *   carddav: {
 *     accounts: {
 *       default: {
 *         username: process.env.ICLOUD_ID!,
 *         appPassword: process.env.ICLOUD_APP_PW!,
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @experimental
 */
export interface CarddavContextConfig {
  /** Named CardDAV accounts. The key `default` (or the first key) is the default. */
  accounts?: Record<string, CarddavAccountConfig>;
  /** Default server URL across all accounts (default: iCloud). */
  serverUrl?: string;
  /** Default address book display name across all accounts. */
  addressBook?: string;
}

// ---------------------------------------------------------------------------
// Per-operation options
// ---------------------------------------------------------------------------

/**
 * The destination action, mirroring the `mail` adapter's `action` flag.
 *
 * Absent (read role): `.from(carddav())` reads all contacts as a source and
 * `.enrich(carddav())` fetches all contacts as an array. Present (write role):
 *
 * - `"save"`: write to the contact at `url`, else create it (upsert).
 * - `"create"`: always create a new contact (generates a `UID` if absent).
 * - `"update"`: write to the contact at `url`, throwing `RC5014` if no `url` is
 *   resolvable. Read the contact first so it carries its `url`/`etag`.
 * - `"delete"`: delete the contact resolved from the body, headers, or `target`.
 *
 * A write serializes the whole {@link VCard} and replaces the card; it does not
 * merge. Because reading is lossless (every property round-trips), a
 * read-modify-write keeps data you did not touch. Removing a property from the
 * document removes it from the card, exactly like an `UPDATE` of a row.
 */
export type CarddavAction = "save" | "create" | "update" | "delete";

/**
 * Resolve which contact a write/delete targets from the exchange, for cases
 * where the body is not a {@link VCard} carrying `url`/`uid`. Mirrors the mail
 * adapter's `target` extractor.
 */
export type CarddavTargetExtractor = (exchange: Exchange<unknown>) => {
  url?: string;
  uid?: string;
};

/** Fields shared by every adapter role. */
interface CarddavCommonOptions {
  /** Named account from context config (uses the default account if omitted). */
  account?: string;
  /** Address book display name (uses the account/context default, else the first book). */
  addressBook?: string;
  /** Human-readable description for route discovery. */
  description?: string;
  /** Keywords for route discovery and categorization. */
  keywords?: string[];
}

/**
 * Server-role options: `.from(carddav())` (source) and `.enrich(carddav())`
 * (fetch-all). Named per the two-sided adapter policy (Server = we receive),
 * matching `MailServerOptions`.
 */
export interface CarddavServerOptions extends CarddavCommonOptions {
  action?: undefined;
  /** Maximum number of contacts to read. */
  limit?: number;
}

/**
 * Client-role options: `.to(carddav({ action }))` for writes (`'save'`,
 * `'create'`, `'update'`) and deletes (`'delete'`). Named per the two-sided
 * adapter policy (Client = we send), matching `MailClientOptions`.
 */
export interface CarddavClientOptions extends CarddavCommonOptions {
  action: CarddavAction;
  /** Resolve the target contact when the body lacks `url`/`uid`. */
  target?: CarddavTargetExtractor;
}

/**
 * Options for the CardDAV adapter. The `action` flag selects the role: absent
 * means read (`.from`/`.enrich`); present means write or delete (`.to`).
 */
export type CarddavOptions = CarddavServerOptions | CarddavClientOptions;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** Result returned by the destination after creating or updating a contact. */
export interface CarddavWriteResult {
  /** UID of the written contact. */
  uid: string;
  /** DAV object URL of the written contact. */
  url: string;
  /** ETag returned by the server, when provided. */
  etag?: string;
  /** True when a new contact was created, false when an existing one was updated. */
  created: boolean;
}

/** Result returned by the destination after deleting a contact. */
export interface CarddavDeleteResult {
  /** UID of the deleted contact, when known. */
  uid?: string;
  /** DAV object URL of the deleted contact. */
  url: string;
  /** Always true on success. */
  deleted: boolean;
}
