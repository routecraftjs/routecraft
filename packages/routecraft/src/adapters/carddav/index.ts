import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { CardDAVAdapter } from "./adapter.ts";
import type {
  CardDAVDeleteOptions,
  CardDAVDeleteResult,
  CardDAVOptions,
  CardDAVReadOptions,
  CardDAVWriteOptions,
  CardDAVWriteResult,
  Contact,
} from "./types.ts";

/**
 * Create a CardDAV adapter for reading and writing contacts. Defaults to Apple
 * iCloud Contacts; works with any CardDAV server. Credentials come from context
 * `carddav` config (named accounts). The `action` flag selects the role, the
 * same way the mail adapter does.
 *
 * **Read (`.from()` / `.enrich()`):** call with no `action`. `.from(carddav())`
 * emits one {@link Contact} per address-book entry; `.enrich(carddav())` returns
 * all contacts as a `Contact[]`.
 *
 * **Write (`.to()`):** `action: 'save'` upserts by UID (patching the existing
 * card so unmanaged fields are kept), `'create'` always inserts, `'update'`
 * requires a match (else `RC5014`).
 *
 * **Delete (`.to()`):** `action: 'delete'` removes the contact resolved from the
 * body (`uid`/`url`), the read headers, or a custom `target` extractor.
 *
 * @example
 * ```typescript
 * // Read all contacts (source).
 * craft().from(carddav()).to(processContact());
 *
 * // Fetch all contacts on a schedule (enrich).
 * craft().from(cron("0 2 * * *")).enrich(carddav()).to(writeCsv("out.csv"));
 *
 * // Upsert a contact (e.g. set a birthday and photo).
 * craft().from(direct()).to(carddav({ action: "save" }));
 *
 * // Delete stale contacts.
 * craft().from(carddav()).filter(isStale).to(carddav({ action: "delete" }));
 * ```
 *
 * @experimental
 */
export function carddav(
  options?: CardDAVReadOptions,
): Source<Contact> & Destination<unknown, Contact[]>;
export function carddav(
  options: CardDAVWriteOptions,
): Destination<Contact, CardDAVWriteResult>;
export function carddav(
  options: CardDAVDeleteOptions,
): Destination<unknown, CardDAVDeleteResult>;
export function carddav(
  options?: CardDAVOptions,
):
  | (Source<Contact> & Destination<unknown, Contact[]>)
  | Destination<Contact, CardDAVWriteResult>
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
    return adapter as unknown as Destination<Contact, CardDAVWriteResult>;
  }
  return adapter as unknown as Source<Contact> &
    Destination<unknown, Contact[]>;
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
export {
  loadVCardConstructor,
  parseVCard,
  serializeContact,
  patchVCard,
  DEFAULT_VCARD_VERSION,
} from "./vcard-codec.ts";
export { withChanges } from "./vcard-raw.ts";
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
  Contact,
  ContactPhone,
  ContactEmail,
  ContactAddress,
  ContactPhoto,
  ContactDate,
  ContactField,
  ContactInstantMessage,
  ContactSocialProfile,
  ContactRelatedName,
} from "./types.ts";
