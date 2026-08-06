import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { CarddavAdapter } from "./adapter.ts";
import type { VCardBody } from "./vcard.ts";
import type {
  CarddavClientOptions,
  CarddavOptions,
  CarddavServerOptions,
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
 * fetches all cards and the `VCardBody[]` replaces the body (pass an
 * aggregator such as `only()` to merge instead).
 *
 * **Write (`.to()`):** `action: 'save'` upserts (writes to the card's `url`,
 * else creates), `'create'` always inserts, `'update'` writes to the card's
 * `url` (else `RC5014`). The send is void: the card body flows through
 * unchanged and the write receipt (`routecraft.carddav.url` / `.uid` /
 * `.etag`, plus `.created` for insert-vs-update) lands on the same headers
 * the read side sets.
 *
 * **Delete (`.to()`):** `action: 'delete'` removes the contact resolved from the
 * body (`url`/`uid`), the read headers, or a custom `target` extractor. The
 * deleted resource's identity lands on the receipt headers.
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
): Source<VCardBody> & Enricher<unknown, VCardBody[]>;
export function carddav(
  options: CarddavClientOptions & { action: "save" | "create" | "update" },
): Destination<VCardBody>;
export function carddav(
  options: CarddavClientOptions & { action: "delete" },
): Destination<unknown>;
export function carddav(
  options?: CarddavOptions,
):
  | (Source<VCardBody> & Enricher<unknown, VCardBody[]>)
  | Destination<VCardBody>
  | Destination<unknown> {
  const adapter = new CarddavAdapter(options);
  const args = factoryArgs(options);
  // Expose only the slots that match the configured action, so the runtime
  // object agrees with the declared type: a read-shaped carddav() has no
  // `send` (`.to(carddav())` resolves to fetch and replaces the body), and
  // an action-shaped one has no `subscribe`/`fetch`.
  if (options?.action) {
    const destination: Destination<unknown> & {
      getSendMetadata(receipts: unknown): Record<string, unknown>;
    } = {
      adapterId: adapter.adapterId,
      send: (exchange, ctx) => adapter.send(exchange, ctx),
      getSendMetadata: (receipts) => adapter.getSendMetadata(receipts),
    };
    return tagAdapter(destination, carddav, args) as Destination<VCardBody>;
  }
  const reader: Source<VCardBody> &
    Enricher<unknown, VCardBody[]> & {
      getMetadata(result: unknown): Record<string, unknown>;
    } = {
    adapterId: adapter.adapterId,
    subscribe: (sub) => adapter.subscribe(sub),
    fetch: adapter.fetch,
    getMetadata: (result) => adapter.getMetadata(result),
  };
  return tagAdapter(reader, carddav, args);
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
} from "./types.ts";
