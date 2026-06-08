/**
 * CardDAV adapter: reads vCard documents as a source, fetches them for
 * `.enrich()`, and creates / updates / deletes them as a destination.
 *
 * The role is selected the same way the mail adapter selects its mode, via an
 * `action` flag on the options:
 *
 * - no action (read): `.from(carddav())` emits one {@link VCard} per
 *   address-book entry; `.enrich(carddav())` returns all cards as a `VCard[]`.
 * - `action: 'save' | 'create' | 'update'`: `.to(carddav(...))` serializes the
 *   exchange body (a `VCard`) and writes it. A write replaces the card; it does
 *   not merge. Reading is lossless, so a read-modify-write keeps properties you
 *   did not touch; removing a property removes it.
 * - `action: 'delete'`: `.to(carddav(...))` deletes the contact resolved from
 *   the body, the read headers, or a custom `target` extractor.
 *
 * Update and delete target the card's `url` and send its read-time `etag` as an
 * `If-Match` precondition, so a concurrent change on the server surfaces as a
 * conflict (RC5028) instead of being silently overwritten. They do not re-fetch
 * the address book; only an upsert without a known `url` (or a delete by `uid`
 * alone) pays a lookup.
 *
 * @experimental
 */

import { randomUUID } from "node:crypto";
import type { CraftContext } from "../../context.ts";
import type { Exchange, ExchangeHeaders } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import { rcError } from "../../error.ts";
import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { OnParseError } from "../shared/parse.ts";
import type { CardDAVClientManager } from "./client-manager.ts";
import { VCard } from "./vcard.ts";
import {
  assertResponseOk,
  requireClientManager,
  selectAddressBook,
  throwCardDAVError,
  HEADER_CARDDAV_ACCOUNT,
  HEADER_CARDDAV_ETAG,
  HEADER_CARDDAV_UID,
  HEADER_CARDDAV_URL,
  type CardDAVDriverClient,
  type DAVAddressBookLike,
  type DAVVCardLike,
} from "./shared.ts";
import type {
  CardDAVAction,
  CardDAVDeleteResult,
  CardDAVOptions,
  CardDAVTargetExtractor,
  CardDAVWriteResult,
} from "./types.ts";

/** Result body produced by `send`, depending on the configured action. */
type CardDAVSendResult = VCard[] | CardDAVWriteResult | CardDAVDeleteResult;

/** Identifies a contact resource for update/delete. */
interface ContactTarget {
  url?: string;
  uid?: string;
  etag?: string;
}

/** Flattened options so field access does not require narrowing the union. */
interface NormalizedOptions {
  account?: string;
  addressBook?: string;
  limit?: number;
  action?: CardDAVAction;
  target?: CardDAVTargetExtractor;
}

function uidFromUrl(url: string): string | undefined {
  const last = url.split("/").pop();
  if (!last) return undefined;
  const uid = last.replace(/\.vcf$/i, "");
  return uid.length > 0 ? uid : undefined;
}

/**
 * Read the authoritative `UID` from a vCard payload. The DAV resource filename
 * is not guaranteed to equal the vCard `UID`, so this is preferred over
 * {@link uidFromUrl} wherever the card body is available.
 */
function uidFromVCardData(data: unknown): string | undefined {
  if (typeof data !== "string" || data.length === 0) return undefined;
  try {
    return VCard.parse(data).uid;
  } catch {
    return undefined;
  }
}

function joinUrl(base: string, filename: string): string {
  return base.endsWith("/") ? `${base}${filename}` : `${base}/${filename}`;
}

/**
 * CardDAV source + destination adapter.
 *
 * @experimental
 */
export class CardDAVAdapter
  implements Source<VCard>, Destination<unknown, CardDAVSendResult>
{
  readonly adapterId = "routecraft.adapter.carddav";
  private readonly options: NormalizedOptions;

  constructor(options?: CardDAVOptions) {
    this.options = { ...(options ?? {}) } as NormalizedOptions;
  }

  // -------------------------------------------------------------------------
  // Source: read all contacts, one exchange each
  // -------------------------------------------------------------------------

  async subscribe(
    context: CraftContext,
    handler: (
      message: VCard,
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
      parseFailureMode?: OnParseError,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const { client, book, account } = await this.openRead(context);

    let cards: DAVVCardLike[];
    try {
      cards = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCardDAVError(error, "fetch contacts");
    }

    if (onReady) onReady();

    const limit = this.options.limit;
    let emitted = 0;
    for (const dav of cards) {
      if (abortController.signal.aborted) break;
      if (typeof limit === "number" && emitted >= limit) break;
      const raw = typeof dav.data === "string" ? dav.data : "";
      if (!raw) continue;

      let card: VCard;
      try {
        card = VCard.parse(raw);
      } catch (error) {
        // Surface a malformed vCard as a per-exchange parse failure (RC5016)
        // via the synthetic parse step, so the route's `.error()` handler can
        // recover it instead of tearing down the read.
        await handler(
          raw as unknown as VCard,
          this.buildHeaders(dav, account, uidFromUrl(dav.url)),
          () => {
            throw error;
          },
          "fail",
        );
        emitted++;
        continue;
      }

      card.url = dav.url;
      if (dav.etag) card.etag = dav.etag;
      await handler(
        card,
        this.buildHeaders(dav, account, card.uid ?? uidFromUrl(dav.url)),
      );
      emitted++;
    }
  }

  // -------------------------------------------------------------------------
  // Destination: read (enrich) / write / delete, selected by `action`
  // -------------------------------------------------------------------------

  async send(exchange: Exchange<unknown>): Promise<CardDAVSendResult> {
    const action = this.options.action;
    if (action === undefined) {
      return this.fetchAll(getExchangeContext(exchange));
    }
    if (action === "delete") {
      return this.remove(exchange);
    }
    return this.write(exchange, action);
  }

  /** Observability metadata for the `.to()` / `.enrich()` step. */
  getMetadata(result: unknown): Record<string, unknown> {
    if (Array.isArray(result)) return { count: result.length };
    const r = result as Partial<CardDAVWriteResult & CardDAVDeleteResult>;
    const meta: Record<string, unknown> = {};
    if (r.uid !== undefined) meta["uid"] = r.uid;
    if (r.url !== undefined) meta["url"] = r.url;
    if (r.created !== undefined) meta["created"] = r.created;
    if (r.deleted !== undefined) meta["deleted"] = r.deleted;
    return meta;
  }

  // -------------------------------------------------------------------------
  // Read implementations
  // -------------------------------------------------------------------------

  /** Fetch all contacts as an array (best-effort: malformed cards are skipped). */
  private async fetchAll(context: CraftContext | undefined): Promise<VCard[]> {
    const { client, book } = await this.openRead(context);
    let cards: DAVVCardLike[];
    try {
      cards = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCardDAVError(error, "fetch contacts");
    }
    const limit = this.options.limit;
    const out: VCard[] = [];
    for (const dav of cards) {
      if (typeof limit === "number" && out.length >= limit) break;
      const raw = typeof dav.data === "string" ? dav.data : "";
      if (!raw) continue;
      try {
        const card = VCard.parse(raw);
        card.url = dav.url;
        if (dav.etag) card.etag = dav.etag;
        out.push(card);
      } catch {
        // Skip malformed cards during a bulk fetch; one bad card must not fail
        // the whole enrichment.
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Write implementation
  // -------------------------------------------------------------------------

  private async write(
    exchange: Exchange<unknown>,
    action: "save" | "create" | "update",
  ): Promise<CardDAVWriteResult> {
    const body = exchange.body;
    if (!(body instanceof VCard)) {
      throw rcError("RC5001", undefined, {
        message: `CardDAV ${action} requires the exchange body to be a VCard; received ${body === null ? "null" : typeof body}. Build one with VCard.parse() or new VCard().`,
      });
    }
    const card = body;
    const target = this.resolveTarget(exchange);
    const { client, manager, account } = await this.connect(
      getExchangeContext(exchange),
    );

    if (action === "update") {
      const url = target.url;
      if (!url) {
        throw rcError("RC5014", undefined, {
          message:
            "CardDAV update needs a contact url. Read the contact first (so it carries url/etag), or use action: 'save'.",
        });
      }
      return this.put(client, url, card, target);
    }

    if (action === "create") {
      const book = await this.resolveBook(client, manager, account);
      return this.create(client, book, card);
    }

    // save (upsert): update in place when we know the url, else create and only
    // fall back to a lookup if the resource already exists.
    if (target.url) {
      return this.put(client, target.url, card, target);
    }
    const book = await this.resolveBook(client, manager, account);
    const uid = card.uid ?? target.uid ?? randomUUID();
    const filename = `${uid}.vcf`;
    let response: Response;
    try {
      response = await client.createVCard({
        addressBook: book,
        vCardString: this.serializeWithUid(card, uid),
        filename,
      });
    } catch (error) {
      throwCardDAVError(error, "save contact");
    }
    if (response.status === 412) {
      // A card already exists at this UID; locate it and overwrite.
      const existing = await this.findByUid(client, book, uid);
      if (existing) {
        const conflictTarget: ContactTarget = { uid };
        if (existing.etag) conflictTarget.etag = existing.etag;
        return this.put(client, existing.url, card, conflictTarget);
      }
    }
    assertResponseOk(response, "save contact");
    return this.createResult(uid, joinUrl(book.url, filename), response);
  }

  /** PUT a full serialization of `card` to `url`, with `If-Match` when known. */
  private async put(
    client: CardDAVDriverClient,
    url: string,
    card: VCard,
    target: ContactTarget,
  ): Promise<CardDAVWriteResult> {
    const uid = card.uid ?? target.uid ?? uidFromUrl(url) ?? randomUUID();
    const vCard: DAVVCardLike = { url, data: card.toString() };
    const etag = card.etag ?? target.etag;
    if (etag) vCard.etag = etag;
    let response: Response;
    try {
      response = await client.updateVCard({ vCard });
    } catch (error) {
      throwCardDAVError(error, "update contact");
    }
    assertResponseOk(response, "update contact");
    const result: CardDAVWriteResult = { uid, url, created: false };
    const newEtag = response.headers.get("etag") ?? etag;
    if (newEtag) result.etag = newEtag;
    return result;
  }

  /** Create a new card. Relies on the driver's `If-None-Match: *` precondition. */
  private async create(
    client: CardDAVDriverClient,
    book: DAVAddressBookLike,
    card: VCard,
  ): Promise<CardDAVWriteResult> {
    const uid = card.uid ?? randomUUID();
    const filename = `${uid}.vcf`;
    let response: Response;
    try {
      response = await client.createVCard({
        addressBook: book,
        vCardString: this.serializeWithUid(card, uid),
        filename,
      });
    } catch (error) {
      throwCardDAVError(error, "create contact");
    }
    assertResponseOk(response, "create contact");
    return this.createResult(uid, joinUrl(book.url, filename), response);
  }

  /** Serialize `card`, ensuring it carries `uid` (without mutating the body). */
  private serializeWithUid(card: VCard, uid: string): string {
    if (card.uid) return card.toString();
    const copy = card.clone();
    copy.uid = uid;
    return copy.toString();
  }

  private createResult(
    uid: string,
    url: string,
    response: Response,
  ): CardDAVWriteResult {
    const result: CardDAVWriteResult = { uid, url, created: true };
    const etag = response.headers.get("etag");
    if (etag) result.etag = etag;
    return result;
  }

  // -------------------------------------------------------------------------
  // Delete implementation
  // -------------------------------------------------------------------------

  private async remove(
    exchange: Exchange<unknown>,
  ): Promise<CardDAVDeleteResult> {
    const { client, manager, account } = await this.connect(
      getExchangeContext(exchange),
    );
    const target = this.resolveTarget(exchange);
    let url = target.url;
    let etag = target.etag;
    let uid = target.uid;

    if (!url) {
      if (!uid) {
        throw rcError("RC5014", undefined, {
          message:
            "CardDAV delete found no target. Provide a VCard with url/uid, read headers, or a target extractor.",
        });
      }
      const book = await this.resolveBook(client, manager, account);
      const existing = await this.findByUid(client, book, uid);
      if (!existing) {
        throw rcError("RC5014", undefined, {
          message: `CardDAV delete found no contact with uid '${uid}'.`,
        });
      }
      url = existing.url;
      etag = etag ?? existing.etag;
      uid = uid ?? uidFromVCardData(existing.data) ?? uidFromUrl(existing.url);
    }

    const vCard: DAVVCardLike = { url };
    if (etag) vCard.etag = etag;
    let response: Response;
    try {
      response = await client.deleteVCard({ vCard });
    } catch (error) {
      throwCardDAVError(error, "delete contact");
    }
    assertResponseOk(response, "delete contact");
    const result: CardDAVDeleteResult = { url, deleted: true };
    const resolvedUid = uid ?? uidFromUrl(url);
    if (resolvedUid) result.uid = resolvedUid;
    return result;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /** Acquire a logged-in client (no address-book lookup). */
  private async connect(context: CraftContext | undefined): Promise<{
    client: CardDAVDriverClient;
    manager: CardDAVClientManager;
    account: string | undefined;
  }> {
    const manager = requireClientManager(context);
    const account = this.options.account;
    const client = await manager.getClient(account);
    return { client, manager, account };
  }

  /** Acquire a client and resolve the target address book (read/create paths). */
  private async openRead(context: CraftContext | undefined): Promise<{
    client: CardDAVDriverClient;
    book: DAVAddressBookLike;
    account: string | undefined;
  }> {
    const { client, manager, account } = await this.connect(context);
    const book = await this.resolveBook(client, manager, account);
    return { client, book, account };
  }

  private buildHeaders(
    dav: DAVVCardLike,
    account: string | undefined,
    uid: string | undefined,
  ): ExchangeHeaders {
    const headers: Record<string, unknown> = {
      [HEADER_CARDDAV_URL]: dav.url,
    };
    if (uid) headers[HEADER_CARDDAV_UID] = uid;
    if (dav.etag) headers[HEADER_CARDDAV_ETAG] = dav.etag;
    if (account) headers[HEADER_CARDDAV_ACCOUNT] = account;
    return headers as ExchangeHeaders;
  }

  private resolveBook(
    client: CardDAVDriverClient,
    manager: CardDAVClientManager,
    account: string | undefined,
  ): Promise<DAVAddressBookLike> {
    return client
      .fetchAddressBooks()
      .then((books) =>
        selectAddressBook(
          books,
          this.options.addressBook ?? manager.resolveAddressBookName(account),
        ),
      )
      .catch((error: unknown) =>
        throwCardDAVError(error, "list address books"),
      );
  }

  /** Resolve the target contact from a custom extractor, the body, or headers. */
  private resolveTarget(exchange: Exchange<unknown>): ContactTarget {
    const card = exchange.body instanceof VCard ? exchange.body : undefined;
    const headerEtag = exchange.headers[HEADER_CARDDAV_ETAG];
    // The ETag (for If-Match) always comes from the read-time card/headers, even
    // when a custom `target` extractor supplies the url/uid, so optimistic
    // concurrency is not silently disabled on the extractor path.
    const etag =
      card?.etag ?? (typeof headerEtag === "string" ? headerEtag : undefined);

    let url: string | undefined;
    let uid: string | undefined;
    if (this.options.target) {
      const extracted = this.options.target(exchange);
      url = extracted.url;
      uid = extracted.uid;
    } else {
      const headerUrl = exchange.headers[HEADER_CARDDAV_URL];
      const headerUid = exchange.headers[HEADER_CARDDAV_UID];
      url =
        card?.url ?? (typeof headerUrl === "string" ? headerUrl : undefined);
      uid =
        card?.uid ?? (typeof headerUid === "string" ? headerUid : undefined);
    }

    const target: ContactTarget = {};
    if (url) target.url = url;
    if (uid) target.uid = uid;
    if (etag) target.etag = etag;
    return target;
  }

  /** Locate a card by vCard UID (falls back to the resource filename). */
  private async findByUid(
    client: CardDAVDriverClient,
    book: DAVAddressBookLike,
    uid: string,
  ): Promise<DAVVCardLike | undefined> {
    let all: DAVVCardLike[];
    try {
      all = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCardDAVError(error, "look up contact");
    }
    for (const dav of all) {
      if (uidFromUrl(dav.url) === uid) return dav;
      if (typeof dav.data === "string") {
        try {
          if (VCard.parse(dav.data).uid === uid) return dav;
        } catch {
          // Skip cards that fail to parse while searching for a match.
        }
      }
    }
    return undefined;
  }
}
