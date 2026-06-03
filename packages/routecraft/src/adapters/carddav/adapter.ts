/**
 * CardDAV adapter: reads contacts as a source, fetches them for `.enrich()`,
 * and creates / updates / deletes them as a destination.
 *
 * The role is selected the same way the mail adapter selects its mode, via an
 * `action` flag on the options:
 *
 * - no action (read): `.from(carddav())` emits one `Contact` per address-book
 *   entry; `.enrich(carddav())` returns all contacts as a `Contact[]`.
 * - `action: 'save' | 'create' | 'update'`: `.to(carddav(...))` writes the
 *   exchange body (a `Contact`), patching the existing card so fields the model
 *   does not cover are kept.
 * - `action: 'delete'`: `.to(carddav(...))` deletes the contact resolved from
 *   the body, the read headers, or a custom `target` extractor.
 *
 * Credentials come from context `carddav` config (named accounts). A single
 * instance implements both the source and destination interfaces; the operation
 * (`.from` / `.enrich` / `.to`) plus the `action` flag select the behavior.
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
import {
  loadVCardConstructor,
  parseVCard,
  patchVCard,
  serializeContact,
} from "./vcard-codec.ts";
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
  Contact,
} from "./types.ts";

/** Result body produced by `send`, depending on the configured action. */
type CardDAVSendResult = Contact[] | CardDAVWriteResult | CardDAVDeleteResult;

/** Identifies a contact resource for update/delete. */
interface ContactTarget {
  url?: string;
  uid?: string;
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
function uidFromVCardData(
  Ctor: Awaited<ReturnType<typeof loadVCardConstructor>>,
  data: unknown,
): string | undefined {
  if (typeof data !== "string" || data.length === 0) return undefined;
  try {
    return parseVCard(Ctor, data).uid;
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
  implements Source<Contact>, Destination<unknown, CardDAVSendResult>
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
      message: Contact,
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
      parseFailureMode?: OnParseError,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const { client, Ctor, book, account } = await this.openRead(context);

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

      let contact: Contact;
      try {
        contact = parseVCard(Ctor, raw);
      } catch (error) {
        // Surface a malformed vCard as a per-exchange parse failure (RC5016)
        // via the synthetic parse step, so the route's `.error()` handler can
        // recover it instead of tearing down the read.
        await handler(
          raw as unknown as Contact,
          this.buildHeaders(dav, account, uidFromUrl(dav.url)),
          () => {
            throw error;
          },
          "fail",
        );
        emitted++;
        continue;
      }

      contact.url = dav.url;
      if (dav.etag) contact.etag = dav.etag;
      await handler(
        contact,
        this.buildHeaders(dav, account, contact.uid ?? uidFromUrl(dav.url)),
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
  private async fetchAll(
    context: CraftContext | undefined,
  ): Promise<Contact[]> {
    const { client, Ctor, book } = await this.openRead(context);
    let cards: DAVVCardLike[];
    try {
      cards = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCardDAVError(error, "fetch contacts");
    }
    const limit = this.options.limit;
    const out: Contact[] = [];
    for (const dav of cards) {
      if (typeof limit === "number" && out.length >= limit) break;
      const raw = typeof dav.data === "string" ? dav.data : "";
      if (!raw) continue;
      try {
        const contact = parseVCard(Ctor, raw);
        contact.url = dav.url;
        if (dav.etag) contact.etag = dav.etag;
        out.push(contact);
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
    const { client, Ctor, book } = await this.openRead(
      getExchangeContext(exchange),
    );
    const body = exchange.body;
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw rcError("RC5001", undefined, {
        message: `CardDAV ${action} requires the exchange body to be a Contact object; received ${body === null ? "null" : Array.isArray(body) ? "array" : typeof body}.`,
      });
    }
    const contact = body as Contact;

    const existing =
      action === "create"
        ? undefined
        : await this.findExisting(
            client,
            book,
            this.resolveTarget(exchange),
            Ctor,
          );

    if (existing) {
      // Resolve the UID before serializing so it lands inside the patched
      // vCard (when the existing card has none) and the returned `result.uid`
      // matches what is actually persisted on the server.
      const uid =
        contact.uid ??
        uidFromVCardData(Ctor, existing.data) ??
        uidFromUrl(existing.url) ??
        randomUUID();
      const contactWithUid: Contact = { ...contact, uid };
      const existingRaw =
        typeof existing.data === "string" && existing.data.length > 0
          ? existing.data
          : null;
      // When the driver returns a record without a body, patching against ""
      // would produce a vCard missing BEGIN:VCARD/VERSION. Fall through to a
      // fresh serialize so the PUT body is always structurally valid.
      const newData =
        existingRaw === null
          ? serializeContact(contactWithUid)
          : patchVCard(existingRaw, contactWithUid);
      const vCard: DAVVCardLike = { url: existing.url, data: newData };
      if (existing.etag) vCard.etag = existing.etag;
      let response: Response;
      try {
        response = await client.updateVCard({ vCard });
      } catch (error) {
        throwCardDAVError(error, "update contact");
      }
      assertResponseOk(response, "update contact");
      const result: CardDAVWriteResult = {
        uid,
        url: existing.url,
        created: false,
      };
      const etag = response.headers.get("etag") ?? existing.etag;
      if (etag) result.etag = etag;
      return result;
    }

    if (action === "update") {
      throw rcError("RC5014", undefined, {
        message:
          "CardDAV update found no matching contact. Provide a uid/url that exists, or use action: 'save' / 'create'.",
      });
    }

    const uid = contact.uid ?? randomUUID();
    const data = serializeContact({ ...contact, uid });
    const filename = `${uid}.vcf`;
    let response: Response;
    try {
      response = await client.createVCard({
        addressBook: book,
        vCardString: data,
        filename,
      });
    } catch (error) {
      throwCardDAVError(error, "create contact");
    }
    assertResponseOk(response, "create contact");
    const result: CardDAVWriteResult = {
      uid,
      url: joinUrl(book.url, filename),
      created: true,
    };
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
    const { client, Ctor, book } = await this.openRead(
      getExchangeContext(exchange),
    );
    const target = this.resolveTarget(exchange);
    const existing = await this.findExisting(client, book, target, Ctor);
    if (!existing) {
      throw rcError("RC5014", undefined, {
        message:
          "CardDAV delete found no matching contact. Provide a Contact with uid/url, read headers, or a target extractor.",
      });
    }
    const vCard: DAVVCardLike = { url: existing.url };
    if (existing.etag) vCard.etag = existing.etag;
    let response: Response;
    try {
      response = await client.deleteVCard({ vCard });
    } catch (error) {
      throwCardDAVError(error, "delete contact");
    }
    assertResponseOk(response, "delete contact");
    const result: CardDAVDeleteResult = { url: existing.url, deleted: true };
    const uid =
      target.uid ??
      uidFromVCardData(Ctor, existing.data) ??
      uidFromUrl(existing.url);
    if (uid) result.uid = uid;
    return result;
  }

  // -------------------------------------------------------------------------
  // Shared helpers
  // -------------------------------------------------------------------------

  private async openRead(context: CraftContext | undefined): Promise<{
    client: CardDAVDriverClient;
    Ctor: Awaited<ReturnType<typeof loadVCardConstructor>>;
    book: DAVAddressBookLike;
    account: string | undefined;
  }> {
    const manager = requireClientManager(context);
    const account = this.options.account;
    const client = await manager.getClient(account);
    const Ctor = await loadVCardConstructor();
    const book = await this.resolveBook(client, manager, account);
    return { client, Ctor, book, account };
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
    if (this.options.target) return this.options.target(exchange);
    const body = exchange.body;
    const fromBody =
      body && typeof body === "object" ? (body as Contact) : undefined;
    const headerUrl = exchange.headers[HEADER_CARDDAV_URL];
    const headerUid = exchange.headers[HEADER_CARDDAV_UID];
    const url =
      fromBody?.url ?? (typeof headerUrl === "string" ? headerUrl : undefined);
    const uid =
      fromBody?.uid ?? (typeof headerUid === "string" ? headerUid : undefined);
    const target: ContactTarget = {};
    if (url) target.url = url;
    if (uid) target.uid = uid;
    return target;
  }

  private async findExisting(
    client: CardDAVDriverClient,
    book: DAVAddressBookLike,
    target: ContactTarget,
    Ctor: Awaited<ReturnType<typeof loadVCardConstructor>>,
  ): Promise<DAVVCardLike | undefined> {
    if (!target.url && !target.uid) return undefined;

    let all: DAVVCardLike[];
    try {
      all = await client.fetchVCards({ addressBook: book });
    } catch (error) {
      throwCardDAVError(error, "look up contact");
    }

    for (const dav of all) {
      if (target.url && dav.url === target.url) return dav;
      if (target.uid && typeof dav.data === "string") {
        try {
          if (parseVCard(Ctor, dav.data).uid === target.uid) return dav;
        } catch {
          // Skip cards that fail to parse while searching for a match.
        }
      }
    }
    return undefined;
  }
}
