/**
 * CardDAV adapter: reads vCard documents as a source, fetches them for
 * `.enrich()`, and creates / updates / deletes them as a destination.
 *
 * The body is a plain {@link VCardBody} (a `version` plus a property list). Wrap
 * it in a {@link VCard} for ergonomic reads/edits. DAV identity (`url`, `uid`,
 * `etag`) lives on the exchange headers (`routecraft.carddav.*`), not the body,
 * the same way the mail adapter carries its envelope metadata.
 *
 * The role is selected the same way the mail adapter selects its mode, via an
 * `action` flag on the options:
 *
 * - no action (read): `.from(carddav())` emits one `VCardBody` per address-book
 *   entry; `.enrich(carddav())` fetches all cards (merged onto the exchange under
 *   numeric keys by default; pass `replace()` for a `VCardBody[]` body).
 * - `action: 'save' | 'create' | 'update'`: `.to(carddav(...))` serializes the
 *   exchange body and writes it. A write replaces the card; it does not merge.
 *   Reading is lossless, so a read-modify-write keeps properties you did not
 *   touch; removing a property removes it.
 * - `action: 'delete'`: deletes the contact resolved from the headers, the body,
 *   or a custom `target` extractor.
 *
 * Update and delete target the `routecraft.carddav.url` header and send the
 * read-time `routecraft.carddav.etag` as an `If-Match` precondition, so a
 * concurrent change surfaces as a conflict (RC5030) instead of being silently
 * overwritten. They do not re-fetch the address book; only an upsert without a
 * known url (or a delete by uid alone) pays a lookup.
 *
 * @experimental
 */

import { randomUUID } from "node:crypto";
import type { CraftContext } from "../../context.ts";
import type { Exchange, ExchangeHeaders } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import { rcError } from "../../error.ts";
import type { Source, Subscription } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { CarddavClientManager } from "./client-manager.ts";
import { VCard, type VCardBody } from "./vcard.ts";
import {
  assertResponseOk,
  requireClientManager,
  selectAddressBook,
  throwCarddavError,
  CarddavHeaders,
  type CarddavDriverClient,
  type DAVAddressBookLike,
  type DAVVCardLike,
} from "./shared.ts";
import type {
  CarddavAction,
  CarddavDeleteResult,
  CarddavOptions,
  CarddavTargetExtractor,
  CarddavWriteResult,
} from "./types.ts";

/** Result body produced by `send`, depending on the configured action. */
type CarddavSendResult = VCardBody[] | CarddavWriteResult | CarddavDeleteResult;

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
  action?: CarddavAction;
  target?: CarddavTargetExtractor;
}

function uidFromUrl(url: string): string | undefined {
  const last = url.split("/").pop();
  if (!last) return undefined;
  const encoded = last.replace(/\.vcf$/i, "");
  if (encoded.length === 0) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/** Build the resource filename for a UID, URL-escaping it into one path segment. */
function vcfFilename(uid: string): string {
  return `${encodeURIComponent(uid)}.vcf`;
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

/** Coerce an exchange body to a plain {@link VCardBody} (or undefined). */
function coerceBody(body: unknown): VCardBody | undefined {
  if (body instanceof VCard) return body.data;
  if (
    body !== null &&
    typeof body === "object" &&
    Array.isArray((body as VCardBody).properties)
  ) {
    return body as VCardBody;
  }
  return undefined;
}

/** Serialize a body, ensuring it carries `uid` (without mutating the input). */
function serializeWithUid(body: VCardBody, uid: string): string {
  const card = VCard.wrap(body);
  if (card.uid) return card.toString();
  const copy = card.clone();
  copy.uid = uid;
  return copy.toString();
}

function joinUrl(base: string, filename: string): string {
  return base.endsWith("/") ? `${base}${filename}` : `${base}/${filename}`;
}

/**
 * CardDAV source + destination adapter.
 *
 * @experimental
 */
export class CarddavAdapter
  implements Source<VCardBody>, Destination<unknown, CarddavSendResult>
{
  readonly adapterId = "routecraft.adapter.carddav";
  private readonly options: NormalizedOptions;

  constructor(options?: CarddavOptions) {
    this.options = { ...(options ?? {}) } as NormalizedOptions;
  }

  // -------------------------------------------------------------------------
  // Source: read all contacts, one exchange each
  // -------------------------------------------------------------------------

  async subscribe(sub: Subscription<VCardBody>): Promise<void> {
    const { client, book, account } = await this.openRead(sub.context);

    let cards: DAVVCardLike[];
    try {
      cards = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCarddavError(error, "fetch contacts");
    }

    sub.ready();

    const limit = this.options.limit;
    let emitted = 0;
    for (const dav of cards) {
      if (sub.signal.aborted) break;
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
        await sub.emit({
          message: raw as unknown as VCardBody,
          headers: this.buildHeaders(dav, account, uidFromUrl(dav.url)),
          parse: () => {
            throw error;
          },
          parseFailureMode: "fail",
        });
        emitted++;
        continue;
      }

      await sub.emit({
        message: card.data,
        headers: this.buildHeaders(
          dav,
          account,
          card.uid ?? uidFromUrl(dav.url),
        ),
      });
      emitted++;
    }

    // Finite source: all contacts emitted, signal completion so the route
    // wraps up like other finite sources instead of waiting on the
    // context's auto-stop sweep.
    sub.complete();
  }

  // -------------------------------------------------------------------------
  // Destination: read (enrich) / write / delete, selected by `action`
  // -------------------------------------------------------------------------

  async send(exchange: Exchange<unknown>): Promise<CarddavSendResult> {
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
    const r = result as Partial<CarddavWriteResult & CarddavDeleteResult>;
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
  private async fetchAll(
    context: CraftContext | undefined,
  ): Promise<VCardBody[]> {
    const { client, book } = await this.openRead(context);
    let cards: DAVVCardLike[];
    try {
      cards = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCarddavError(error, "fetch contacts");
    }
    const limit = this.options.limit;
    const out: VCardBody[] = [];
    for (const dav of cards) {
      if (typeof limit === "number" && out.length >= limit) break;
      const raw = typeof dav.data === "string" ? dav.data : "";
      if (!raw) continue;
      try {
        out.push(VCard.parse(raw).data);
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
  ): Promise<CarddavWriteResult> {
    const body = coerceBody(exchange.body);
    if (!body) {
      throw rcError("RC5001", undefined, {
        message: `CardDAV ${action} requires the exchange body to be a VCard document (a VCardBody or a VCard). Build one with VCard.parse(), VCard.create(), or VCard.wrap().`,
      });
    }
    const target = this.resolveTarget(exchange);
    const { client, manager, account } = await this.connect(
      getExchangeContext(exchange),
    );

    if (action === "update") {
      const url = target.url;
      if (!url) {
        throw rcError("RC5014", undefined, {
          message:
            "CardDAV update needs a contact url (the routecraft.carddav.url header). Read the contact first, or use action: 'save'.",
        });
      }
      return this.put(client, url, body, target);
    }

    if (action === "create") {
      const book = await this.resolveBook(client, manager, account);
      return this.create(client, book, body);
    }

    // save (upsert): update in place when we know the url, else create and only
    // fall back to a lookup if the resource already exists.
    if (target.url) {
      return this.put(client, target.url, body, target);
    }
    const book = await this.resolveBook(client, manager, account);
    const uid = VCard.wrap(body).uid ?? target.uid ?? randomUUID();
    const filename = vcfFilename(uid);
    let response: Response;
    try {
      response = await client.createVCard({
        addressBook: book,
        vCardString: serializeWithUid(body, uid),
        filename,
      });
    } catch (error) {
      throwCarddavError(error, "save contact");
    }
    if (response.status === 412) {
      const existing = await this.findByUid(client, book, uid);
      if (existing) {
        const conflictTarget: ContactTarget = { uid };
        if (existing.etag) conflictTarget.etag = existing.etag;
        return this.put(client, existing.url, body, conflictTarget);
      }
    }
    assertResponseOk(response, "save contact");
    return this.createResult(uid, joinUrl(book.url, filename), response);
  }

  /** PUT a full serialization of `body` to `url`, with `If-Match` when known. */
  private async put(
    client: CarddavDriverClient,
    url: string,
    body: VCardBody,
    target: ContactTarget,
  ): Promise<CarddavWriteResult> {
    const uid =
      VCard.wrap(body).uid ?? target.uid ?? uidFromUrl(url) ?? randomUUID();
    const vCard: DAVVCardLike = { url, data: serializeWithUid(body, uid) };
    const etag = target.etag;
    if (etag) vCard.etag = etag;
    let response: Response;
    try {
      response = await client.updateVCard({ vCard });
    } catch (error) {
      throwCarddavError(error, "update contact");
    }
    assertResponseOk(response, "update contact");
    const result: CarddavWriteResult = { uid, url, created: false };
    const newEtag = response.headers.get("etag") ?? etag;
    if (newEtag) result.etag = newEtag;
    return result;
  }

  /** Create a new card. Relies on the driver's `If-None-Match: *` precondition. */
  private async create(
    client: CarddavDriverClient,
    book: DAVAddressBookLike,
    body: VCardBody,
  ): Promise<CarddavWriteResult> {
    const uid = VCard.wrap(body).uid ?? randomUUID();
    const filename = vcfFilename(uid);
    let response: Response;
    try {
      response = await client.createVCard({
        addressBook: book,
        vCardString: serializeWithUid(body, uid),
        filename,
      });
    } catch (error) {
      throwCarddavError(error, "create contact");
    }
    assertResponseOk(response, "create contact");
    return this.createResult(uid, joinUrl(book.url, filename), response);
  }

  private createResult(
    uid: string,
    url: string,
    response: Response,
  ): CarddavWriteResult {
    const result: CarddavWriteResult = { uid, url, created: true };
    const etag = response.headers.get("etag");
    if (etag) result.etag = etag;
    return result;
  }

  // -------------------------------------------------------------------------
  // Delete implementation
  // -------------------------------------------------------------------------

  private async remove(
    exchange: Exchange<unknown>,
  ): Promise<CarddavDeleteResult> {
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
            "CardDAV delete found no target. Provide the routecraft.carddav.url/uid headers, a VCard body with a UID, or a target extractor.",
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
      throwCarddavError(error, "delete contact");
    }
    assertResponseOk(response, "delete contact");
    const result: CarddavDeleteResult = { url, deleted: true };
    const resolvedUid = uid ?? uidFromUrl(url);
    if (resolvedUid) result.uid = resolvedUid;
    return result;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  /** Acquire a logged-in client (no address-book lookup). */
  private async connect(context: CraftContext | undefined): Promise<{
    client: CarddavDriverClient;
    manager: CarddavClientManager;
    account: string | undefined;
  }> {
    const manager = requireClientManager(context);
    const account = this.options.account;
    const client = await manager.getClient(account);
    return { client, manager, account };
  }

  /** Acquire a client and resolve the target address book (read/create paths). */
  private async openRead(context: CraftContext | undefined): Promise<{
    client: CarddavDriverClient;
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
      [CarddavHeaders.URL]: dav.url,
    };
    if (uid) headers[CarddavHeaders.UID] = uid;
    if (dav.etag) headers[CarddavHeaders.ETAG] = dav.etag;
    if (account) headers[CarddavHeaders.ACCOUNT] = account;
    return headers as ExchangeHeaders;
  }

  private resolveBook(
    client: CarddavDriverClient,
    manager: CarddavClientManager,
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
        throwCarddavError(error, "list address books"),
      );
  }

  /** Resolve the target contact from a custom extractor, the headers, or the body. */
  private resolveTarget(exchange: Exchange<unknown>): ContactTarget {
    const body = coerceBody(exchange.body);
    const cardUid = body ? VCard.wrap(body).uid : undefined;
    const headerEtag = exchange.headers[CarddavHeaders.ETAG];
    const etag = typeof headerEtag === "string" ? headerEtag : undefined;

    let url: string | undefined;
    let uid: string | undefined;
    if (this.options.target) {
      const extracted = this.options.target(exchange);
      url = extracted.url;
      uid = extracted.uid ?? cardUid;
    } else {
      const headerUrl = exchange.headers[CarddavHeaders.URL];
      const headerUid = exchange.headers[CarddavHeaders.UID];
      url = typeof headerUrl === "string" ? headerUrl : undefined;
      uid = cardUid ?? (typeof headerUid === "string" ? headerUid : undefined);
    }

    const target: ContactTarget = {};
    if (url) target.url = url;
    if (uid) target.uid = uid;
    if (etag) target.etag = etag;
    return target;
  }

  /** Locate a card by vCard UID (falls back to the resource filename). */
  private async findByUid(
    client: CarddavDriverClient,
    book: DAVAddressBookLike,
    uid: string,
  ): Promise<DAVVCardLike | undefined> {
    let all: DAVVCardLike[];
    try {
      all = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCarddavError(error, "look up contact");
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
