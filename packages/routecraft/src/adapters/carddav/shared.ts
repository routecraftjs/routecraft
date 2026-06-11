/**
 * Shared CardDAV adapter helpers: store key, client-manager access, the minimal
 * DAV driver surface the adapter depends on, and HTTP/error mapping.
 *
 * @experimental
 */

import type { CraftContext } from "../../context.ts";
import { rcError, RoutecraftError } from "../../error.ts";
import type { CardDAVClientManager } from "./client-manager.ts";

/** Default CardDAV server for iCloud Contacts. */
export const DEFAULT_CARDDAV_SERVER_URL = "https://contacts.icloud.com";

// ---------------------------------------------------------------------------
// Store key
// ---------------------------------------------------------------------------

/**
 * Store key for the CardDAV client manager.
 * Set by the ContextBuilder when `carddav` config is present.
 * @experimental
 */
export const CARDDAV_CLIENT_MANAGER = Symbol.for(
  "routecraft.adapter.carddav.client-manager",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [CARDDAV_CLIENT_MANAGER]: CardDAVClientManager;
  }
}

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

/**
 * Header keys the CardDAV adapter sets for contact metadata. Keys live
 * under the reserved `routecraft.carddav.*` namespace; the value types are
 * merged into `RoutecraftHeaders` below.
 * @experimental
 */
export const CarddavHeaders = {
  /** vCard UID of a contact. */
  UID: "routecraft.carddav.uid",
  /** DAV object URL of a contact. */
  URL: "routecraft.carddav.url",
  /** DAV ETag of a contact. */
  ETAG: "routecraft.carddav.etag",
  /** Named account a contact was read from. */
  ACCOUNT: "routecraft.carddav.account",
} as const satisfies Record<string, `routecraft.carddav.${string}`>;

declare module "@routecraft/routecraft" {
  interface RoutecraftHeaders {
    /** vCard UID of a contact. */
    "routecraft.carddav.uid"?: string;
    /** DAV object URL of a contact. */
    "routecraft.carddav.url"?: string;
    /** DAV ETag of a contact. */
    "routecraft.carddav.etag"?: string;
    /** Named account a contact was read from. */
    "routecraft.carddav.account"?: string;
  }
}

// ---------------------------------------------------------------------------
// Minimal DAV driver surface (subset of tsdav used by the adapter)
// ---------------------------------------------------------------------------

/** Address book collection as returned by the driver. */
export interface DAVAddressBookLike {
  url: string;
  displayName?: string | Record<string, unknown>;
}

/** A single vCard object as returned by the driver. */
export interface DAVVCardLike {
  url: string;
  etag?: string;
  data?: string;
}

/**
 * The subset of a tsdav client the CardDAV adapter calls. Declaring our own
 * surface keeps the adapter `any`-free (tsdav types `data` as `any`) and lets
 * tests substitute a lightweight fake.
 */
export interface CardDAVDriverClient {
  fetchAddressBooks(params?: {
    account?: unknown;
  }): Promise<DAVAddressBookLike[]>;
  fetchVCards(params: {
    addressBook: DAVAddressBookLike;
  }): Promise<DAVVCardLike[]>;
  createVCard(params: {
    addressBook: DAVAddressBookLike;
    vCardString: string;
    filename: string;
  }): Promise<Response>;
  updateVCard(params: { vCard: DAVVCardLike }): Promise<Response>;
  deleteVCard(params: { vCard: DAVVCardLike }): Promise<Response>;
}

// ---------------------------------------------------------------------------
// Client manager access
// ---------------------------------------------------------------------------

/**
 * Get the CardDAVClientManager from the context, or null when no `carddav`
 * config was provided.
 */
export function getClientManager(
  context: CraftContext | undefined,
): CardDAVClientManager | null {
  if (!context) return null;
  return (
    (context.getStore(CARDDAV_CLIENT_MANAGER) as
      | CardDAVClientManager
      | undefined) ?? null
  );
}

/** Get the CardDAVClientManager, throwing RC5003 when it is absent. */
export function requireClientManager(
  context: CraftContext | undefined,
): CardDAVClientManager {
  const manager = getClientManager(context);
  if (!manager) {
    throw rcError("RC5003", undefined, {
      message:
        "CardDAV adapter requires carddav configuration. Add it via " +
        "defineConfig({ carddav: { accounts: { default: { username, appPassword } } } }).",
    });
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Address book resolution
// ---------------------------------------------------------------------------

function displayNameOf(book: DAVAddressBookLike): string | undefined {
  const name = book.displayName;
  if (typeof name === "string") return name;
  return undefined;
}

/**
 * Pick the target address book: the one whose display name matches `wanted`
 * (case-insensitive), else the first book. Throws RC5014 when none exist or the
 * requested name is not found.
 */
export function selectAddressBook(
  books: DAVAddressBookLike[],
  wanted: string | undefined,
): DAVAddressBookLike {
  if (books.length === 0) {
    throw rcError("RC5014", undefined, {
      message: "CardDAV account has no address books.",
    });
  }
  if (!wanted) return books[0] as DAVAddressBookLike;
  const target = wanted.toLowerCase();
  const match = books.find(
    (book) => displayNameOf(book)?.toLowerCase() === target,
  );
  if (!match) {
    const available = books
      .map((book) => displayNameOf(book) ?? book.url)
      .join(", ");
    throw rcError("RC5014", undefined, {
      message: `CardDAV address book "${wanted}" not found. Available: ${available}.`,
    });
  }
  return match;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Map a thrown driver error (login, network) to a RoutecraftError. */
export function throwCardDAVError(error: unknown, operation: string): never {
  if (error instanceof RoutecraftError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  const cause = error instanceof Error ? error : undefined;
  if (
    lower.includes("401") ||
    lower.includes("unauthor") ||
    lower.includes("authentication") ||
    lower.includes("credential")
  ) {
    throw rcError("RC5012", cause, {
      message: `CardDAV ${operation} failed: ${message}`,
    });
  }
  throw rcError("RC5010", cause, {
    message: `CardDAV ${operation} failed: ${message}`,
  });
}

/** Map a non-OK DAV HTTP response to a RoutecraftError. No-op when ok. */
export function assertResponseOk(response: Response, operation: string): void {
  if (response.ok) return;
  const status = response.status;
  if (status === 401) {
    throw rcError("RC5012", undefined, {
      message: `CardDAV ${operation} failed: authentication rejected (401). Check the Apple ID and app-specific password.`,
    });
  }
  if (status === 403) {
    throw rcError("RC5015", undefined, {
      message: `CardDAV ${operation} failed: permission denied (403).`,
    });
  }
  if (status === 404) {
    throw rcError("RC5014", undefined, {
      message: `CardDAV ${operation} failed: resource not found (404).`,
    });
  }
  if (status === 412) {
    throw rcError("RC5030", undefined, {
      message: `CardDAV ${operation} failed: ETag precondition failed (412). The contact changed on the server; re-read before updating.`,
    });
  }
  if (status === 429) {
    throw rcError("RC5013", undefined, {
      message: `CardDAV ${operation} failed: rate limited (429).`,
    });
  }
  throw rcError("RC5001", undefined, {
    message: `CardDAV ${operation} failed with HTTP ${status}.`,
  });
}
