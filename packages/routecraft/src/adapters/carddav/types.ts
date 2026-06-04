/**
 * CardDAV adapter type definitions.
 *
 * The adapter reads and writes contacts over CardDAV. Credentials live in
 * context-level named accounts (see {@link CardDAVContextConfig}); per-adapter
 * options select which account and address book to use.
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
 * For iCloud, `username` is the Apple ID and `appPassword` is an
 * app-specific password generated at appleid.apple.com (not the account
 * password). `serverUrl` defaults to iCloud when omitted.
 */
export interface CardDAVAccountConfig {
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
export interface CardDAVContextConfig {
  /** Named CardDAV accounts. The key `default` (or the first key) is the default. */
  accounts?: Record<string, CardDAVAccountConfig>;
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
 * - `"save"`: update the contact matching `uid`/`url`, else create it (upsert).
 * - `"create"`: always create a new contact (generates a `uid` if absent).
 * - `"update"`: update an existing contact, throwing `RC5014` if none matches.
 * - `"delete"`: delete the contact resolved from the body, headers, or `target`.
 */
export type CardDAVAction = "save" | "create" | "update" | "delete";

/**
 * Resolve which contact a write/delete targets from the exchange, for cases
 * where the body is not a {@link Contact} carrying `uid`/`url`. Mirrors the
 * mail adapter's `target` extractor.
 */
export type CardDAVTargetExtractor = (exchange: Exchange<unknown>) => {
  url?: string;
  uid?: string;
};

/** Fields shared by every adapter role. */
interface CardDAVCommonOptions {
  /** Named account from context config (uses the default account if omitted). */
  account?: string;
  /** Address book display name (uses the account/context default, else the first book). */
  addressBook?: string;
  /** Human-readable description for route discovery. */
  description?: string;
  /** Keywords for route discovery and categorization. */
  keywords?: string[];
}

/** Read role: `.from(carddav())` (source) and `.enrich(carddav())` (fetch-all). */
export interface CardDAVReadOptions extends CardDAVCommonOptions {
  action?: undefined;
  /** Maximum number of contacts to read. */
  limit?: number;
}

/** Write role: `.to(carddav({ action: 'save' | 'create' | 'update' }))`. */
export interface CardDAVWriteOptions extends CardDAVCommonOptions {
  action: "save" | "create" | "update";
  /** Resolve the target contact when the body lacks `uid`/`url`. */
  target?: CardDAVTargetExtractor;
}

/** Delete role: `.to(carddav({ action: 'delete' }))`. */
export interface CardDAVDeleteOptions extends CardDAVCommonOptions {
  action: "delete";
  /** Resolve the target contact when the body lacks `uid`/`url`. */
  target?: CardDAVTargetExtractor;
}

/**
 * Options for the CardDAV adapter. The `action` flag selects the role: absent
 * means read (`.from`/`.enrich`); present means write or delete (`.to`).
 */
export type CardDAVOptions =
  | CardDAVReadOptions
  | CardDAVWriteOptions
  | CardDAVDeleteOptions;

// ---------------------------------------------------------------------------
// Normalized contact model
// ---------------------------------------------------------------------------

/** A phone number with an optional type label (e.g. `"cell"`, `"home"`, `"work"`). */
export interface ContactPhone {
  value: string;
  type?: string;
}

/** An email address with an optional type label. */
export interface ContactEmail {
  value: string;
  type?: string;
}

/** A structured postal address. */
export interface ContactAddress {
  type?: string;
  poBox?: string;
  street?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  country?: string;
}

/** A contact photo. `data` is base64-encoded image bytes for vCard 3.0. */
export interface ContactPhoto {
  data: string;
  /** Image subtype (e.g. `"JPEG"`, `"PNG"`). */
  mediaType?: string;
}

/**
 * A labeled date beyond the birthday (iCloud `X-ABDATE` grouped with an
 * `X-ABLabel`), e.g. an anniversary or a custom date.
 */
export interface ContactDate {
  /** Human label, e.g. `"anniversary"` or a custom string. */
  label: string;
  /** Date value as written in the vCard (e.g. `"2010-06-01"` or `"--06-01"`). */
  date: string;
}

/** An instant-messaging handle (vCard `IMPP`, iCloud `X-SERVICE-TYPE`). */
export interface ContactInstantMessage {
  /** Service name (e.g. `"iMessage"`, `"WhatsApp"`, `"Skype"`). */
  service?: string;
  /**
   * URI scheme prefixing the handle on the wire (e.g. `"xmpp"`, `"skype"`,
   * `"imessage"`). When omitted, the adapter preserves the scheme of an existing
   * record on update and falls back to `service.toLowerCase()` (or `"x-apple"`)
   * on create.
   */
  scheme?: string;
  /** The address/handle (e.g. `"user@example.com"`). */
  handle: string;
}

/** A social-media profile (iCloud `X-SOCIALPROFILE`). */
export interface ContactSocialProfile {
  /** Service name (e.g. `"twitter"`, `"facebook"`, `"linkedin"`). */
  service?: string;
  /** Profile URL. */
  url: string;
}

/** A related person (iCloud `X-ABRELATEDNAMES` grouped with an `X-ABLabel`). */
export interface ContactRelatedName {
  /** Relationship label, e.g. `"spouse"`, `"child"`, `"mother"`. */
  label: string;
  /** The related person's name. */
  name: string;
}

/**
 * A vCard property outside the structured {@link Contact} model (e.g. `IMPP`,
 * `NICKNAME`, `CATEGORIES`, `X-SOCIALPROFILE`). Read from and written back so
 * data the adapter does not model is never lost.
 */
export interface ContactField {
  /** Property name as it should appear in the vCard (e.g. `"X-SOCIALPROFILE"`). */
  key: string;
  /** Property value. */
  value: string;
  /** `TYPE` parameter, if any. */
  type?: string;
  /** Grouping prefix (e.g. `"item1"`), preserved on round-trip. */
  group?: string;
}

/**
 * A normalized contact. Read from and written to a CardDAV address book.
 *
 * `uid`, `url`, and `etag` round-trip the underlying vCard object so updates
 * can target the right resource with optimistic concurrency. `raw` carries the
 * original vCard text for escape-hatch access.
 *
 * @experimental
 */
export interface Contact {
  /** Stable vCard `UID`. Used to match existing contacts on update. */
  uid?: string;
  /** DAV object URL (set on read; used to target updates). */
  url?: string;
  /** DAV ETag (set on read; used for `If-Match` on update). */
  etag?: string;
  /** Formatted display name (vCard `FN`). */
  fullName?: string;
  firstName?: string;
  lastName?: string;
  middleName?: string;
  prefix?: string;
  suffix?: string;
  /** Nickname (vCard `NICKNAME`). */
  nickname?: string;
  /** Organization name (first component of vCard `ORG`). */
  organization?: string;
  /** Department (second component of vCard `ORG`). */
  department?: string;
  /** Job title (vCard `TITLE`). */
  title?: string;
  /** Tags/groups (vCard `CATEGORIES`). */
  categories?: string[];
  phones?: ContactPhone[];
  emails?: ContactEmail[];
  addresses?: ContactAddress[];
  urls?: string[];
  /** Instant-messaging handles (vCard `IMPP`). */
  instantMessages?: ContactInstantMessage[];
  /** Social-media profiles (iCloud `X-SOCIALPROFILE`). */
  socialProfiles?: ContactSocialProfile[];
  /** Related people (iCloud `X-ABRELATEDNAMES`). */
  relatedNames?: ContactRelatedName[];
  /** Birthday as written in the vCard (e.g. `"1990-05-21"` or `"--05-21"`). */
  birthday?: string;
  /** Labeled dates other than the birthday (anniversaries, custom dates). */
  dates?: ContactDate[];
  note?: string;
  photo?: ContactPhoto;
  /**
   * Properties outside the structured model (e.g. `IMPP`, `NICKNAME`,
   * `CATEGORIES`, `X-` fields). Populated on read; written back on create and
   * upserted on update so unmodeled data round-trips.
   */
  custom?: ContactField[];
  /** Original vCard text (present on read; preserved fields are kept on update). */
  raw?: string;
}

/** Result returned by the destination after creating or updating a contact. */
export interface CardDAVWriteResult {
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
export interface CardDAVDeleteResult {
  /** UID of the deleted contact, when known. */
  uid?: string;
  /** DAV object URL of the deleted contact. */
  url: string;
  /** Always true on success. */
  deleted: boolean;
}
