import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { CardDAVAdapter } from "./adapter.ts";
import { VCard } from "./vcard.ts";
import type {
  CardDAVDeleteOptions,
  CardDAVDeleteResult,
  CardDAVOptions,
  CardDAVReadOptions,
  CardDAVWriteOptions,
  CardDAVWriteResult,
} from "./types.ts";

/**
 * Create a CardDAV adapter for reading and writing contacts. Defaults to Apple
 * iCloud Contacts; works with any CardDAV server. Credentials come from context
 * `carddav` config (named accounts). The `action` flag selects the role, the
 * same way the mail adapter does.
 *
 * The body is a {@link VCard} document (an ordered list of properties), not a
 * typed contact: you read and write properties directly and bring your own
 * typed shape in a `.transform()` if you want one, exactly like working with
 * parsed JSON from an HTTP endpoint. Reading is lossless and a write replaces
 * the card with the document you hand back.
 *
 * **Read (`.from()` / `.enrich()`):** call with no `action`. `.from(carddav())`
 * emits one {@link VCard} per address-book entry; `.enrich(carddav())` fetches
 * all cards (merged onto the exchange under numeric keys by default; pass
 * `replace()` as the aggregator to get a `VCard[]` body).
 *
 * **Write (`.to()`):** `action: 'save'` upserts (writes to the card's `url`,
 * else creates), `'create'` always inserts, `'update'` writes to the card's
 * `url` (else `RC5014`).
 *
 * **Delete (`.to()`):** `action: 'delete'` removes the contact resolved from the
 * body (`url`/`uid`), the read headers, or a custom `target` extractor.
 *
 * @example
 * ```typescript
 * // Read all contacts (source).
 * craft().from(carddav()).to(processCard());
 *
 * // Read, edit one property, write back (everything else is preserved).
 * craft()
 *   .from(carddav())
 *   .transform((card) => card.set("NOTE", "synced from CRM"))
 *   .to(carddav({ action: "update" }));
 *
 * // Delete stale contacts.
 * craft().from(carddav()).filter(isStale).to(carddav({ action: "delete" }));
 * ```
 *
 * @experimental
 */
export function carddav(
  options?: CardDAVReadOptions,
): Source<VCard> & Destination<unknown, VCard[]>;
export function carddav(
  options: CardDAVWriteOptions,
): Destination<VCard, CardDAVWriteResult>;
export function carddav(
  options: CardDAVDeleteOptions,
): Destination<unknown, CardDAVDeleteResult>;
export function carddav(
  options?: CardDAVOptions,
):
  | (Source<VCard> & Destination<unknown, VCard[]>)
  | Destination<VCard, CardDAVWriteResult>
  | Destination<unknown, CardDAVDeleteResult> {
  const adapter = tagAdapter(
    new CardDAVAdapter(options),
    carddav,
    factoryArgs(options),
  );
  const action = options?.action;
  if (action === "delete") {
    return adapter as unknown as Destination<unknown, CardDAVDeleteResult>;
  }
  if (action) {
    return adapter as unknown as Destination<VCard, CardDAVWriteResult>;
  }
  return adapter as unknown as Source<VCard> & Destination<unknown, VCard[]>;
}

export { CardDAVAdapter } from "./adapter.ts";
export { CardDAVClientManager } from "./client-manager.ts";
export type { ResolvedCardDAVConnection } from "./client-manager.ts";
export {
  CARDDAV_CLIENT_MANAGER,
  DEFAULT_CARDDAV_SERVER_URL,
  HEADER_CARDDAV_UID,
  HEADER_CARDDAV_URL,
  HEADER_CARDDAV_ETAG,
  HEADER_CARDDAV_ACCOUNT,
} from "./shared.ts";
export type {
  CardDAVDriverClient,
  DAVAddressBookLike,
  DAVVCardLike,
} from "./shared.ts";
export { VCard, VCardProperty, parseVCard } from "./vcard.ts";
export type { VCardPropertyOptions } from "./vcard.ts";
export type { VCardParam } from "./vcard-raw.ts";
export { VCARD, VPARAM } from "./constants.ts";
export type { KnownProperty, KnownParam } from "./constants.ts";
export type {
  CardDAVOptions,
  CardDAVReadOptions,
  CardDAVWriteOptions,
  CardDAVDeleteOptions,
  CardDAVContextConfig,
  CardDAVAccountConfig,
  CardDAVAction,
  CardDAVTargetExtractor,
  CardDAVWriteResult,
  CardDAVDeleteResult,
} from "./types.ts";
