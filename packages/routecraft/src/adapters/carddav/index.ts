import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { CarddavAdapter } from "./adapter.ts";
import type { VCardBody } from "./vcard.ts";
import type {
  CarddavClientOptions,
  CarddavDeleteResult,
  CarddavOptions,
  CarddavServerOptions,
  CarddavWriteResult,
} from "./types.ts";

/**
 * Create a CardDAV adapter for reading and writing contacts. Defaults to Apple
 * iCloud Contacts; works with any CardDAV server. Credentials come from context
 * `carddav` config (named accounts). The `action` flag selects the role, the
 * same way the mail adapter does.
 *
 * The body is a plain {@link VCardBody} (a `version` plus a property list), not
 * a typed contact. Wrap it in a {@link VCard} (`VCard.wrap(body)`,
 * `VCard.create()`, `VCard.parse(string)`) for ergonomic reads and edits, then
 * read `.data` to put the plain body back. Identity (`url`/`uid`/`etag`) lives
 * on the exchange headers. Reading is lossless and a write replaces the card
 * with the document you hand back.
 *
 * **Read (`.from()` / `.enrich()`):** call with no `action`. `.from(carddav())`
 * emits one {@link VCardBody} per address-book entry; `.enrich(carddav())`
 * fetches all cards (merged onto the exchange under numeric keys by default;
 * pass `replace()` as the aggregator to get a `VCardBody[]` body).
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
  options?: CarddavServerOptions,
): Source<VCardBody> & Destination<unknown, VCardBody[]>;
export function carddav(
  options: CarddavClientOptions & { action: "save" | "create" | "update" },
): Destination<VCardBody, CarddavWriteResult>;
export function carddav(
  options: CarddavClientOptions & { action: "delete" },
): Destination<unknown, CarddavDeleteResult>;
export function carddav(
  options?: CarddavOptions,
):
  | (Source<VCardBody> & Destination<unknown, VCardBody[]>)
  | Destination<VCardBody, CarddavWriteResult>
  | Destination<unknown, CarddavDeleteResult> {
  const adapter = tagAdapter(
    new CarddavAdapter(options),
    carddav,
    factoryArgs(options),
  );
  const action = options?.action;
  if (action === "delete") {
    return adapter as unknown as Destination<unknown, CarddavDeleteResult>;
  }
  if (action) {
    return adapter as unknown as Destination<VCardBody, CarddavWriteResult>;
  }
  return adapter as unknown as Source<VCardBody> &
    Destination<unknown, VCardBody[]>;
}

export { CarddavAdapter } from "./adapter.ts";
export { CarddavClientManager } from "./client-manager.ts";
export type { ResolvedCarddavConnection } from "./client-manager.ts";
export {
  CARDDAV_CLIENT_MANAGER,
  DEFAULT_CARDDAV_SERVER_URL,
  CarddavHeaders,
} from "./shared.ts";
export type {
  CarddavDriverClient,
  DAVAddressBookLike,
  DAVVCardLike,
} from "./shared.ts";
export { VCard, VCardProperty, parseVCard } from "./vcard.ts";
export type {
  VCardBody,
  VCardPropertyData,
  VCardPropertyOptions,
} from "./vcard.ts";
export type { VCardParam } from "./vcard-raw.ts";
export { VCARD, VPARAM } from "./constants.ts";
export type { KnownProperty, KnownParam } from "./constants.ts";
export type {
  CarddavOptions,
  CarddavServerOptions,
  CarddavClientOptions,
  CarddavContextConfig,
  CarddavAccountConfig,
  CarddavAction,
  CarddavTargetExtractor,
  CarddavWriteResult,
  CarddavDeleteResult,
} from "./types.ts";
