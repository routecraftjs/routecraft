import type { CraftContext } from "../../context.ts";
import type { Exchange } from "../../exchange.ts";
import { rcError } from "../../error.ts";
import type {
  MailMessage,
  MailServerOptions,
  MailClientOptions,
  MailSendPayload,
  MailTargetExtractor,
} from "./types.ts";
import type { MailClientManager } from "./client-manager.ts";
import {
  analyzeHeaders,
  extractAnalysisHeaders,
  type MailSender,
} from "./analysis.ts";

// ---------------------------------------------------------------------------
// Store keys
// ---------------------------------------------------------------------------

/**
 * Store key for the mail client manager.
 * Set by the ContextBuilder when `mail` config is present.
 * @experimental
 */
export const MAIL_CLIENT_MANAGER = Symbol.for(
  "routecraft.adapter.mail.client-manager",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [MAIL_CLIENT_MANAGER]: MailClientManager;
  }
}

// ---------------------------------------------------------------------------
// Header constants
// ---------------------------------------------------------------------------

/** Header key for the IMAP UID of the source message. */
export const HEADER_MAIL_UID = "routecraft.mail.uid";

/** Header key for the IMAP folder of the source message. */
export const HEADER_MAIL_FOLDER = "routecraft.mail.folder";

// ---------------------------------------------------------------------------
// Client manager access
// ---------------------------------------------------------------------------

/**
 * Get the MailClientManager from the exchange context.
 * Returns null if no mail config was provided (standalone mode).
 */
export function getClientManager(
  context: CraftContext | undefined,
): MailClientManager | null {
  if (!context) return null;
  return (
    (context.getStore(MAIL_CLIENT_MANAGER) as MailClientManager | undefined) ??
    null
  );
}

/**
 * Get the MailClientManager from the exchange context, throwing if not found.
 */
export function requireClientManager(
  context: CraftContext | undefined,
): MailClientManager {
  const manager = getClientManager(context);
  if (!manager) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter requires mail configuration. Add mail config via .with({ mail: { accounts: {...} } }).",
    });
  }
  return manager;
}

// ---------------------------------------------------------------------------
// Target resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the UIDs and folder for a mail operation.
 * Three-tier: custom extractor > headers > body fallback (single or array).
 */
export function resolveMailTarget(
  exchange: Exchange<unknown>,
  extractor?: MailTargetExtractor,
): { uids: number[]; folder: string } {
  // 1. Custom extractor
  if (extractor) return extractor(exchange);

  // 2. Headers (survive .transform())
  const headerUid = exchange.headers[HEADER_MAIL_UID];
  const headerFolder = exchange.headers[HEADER_MAIL_FOLDER];
  if (headerUid !== undefined && headerFolder !== undefined) {
    const uid = Number(headerUid);
    if (!Number.isFinite(uid) || uid < 1) {
      throw rcError("RC5003", undefined, {
        message: `Invalid mail UID header value: ${String(headerUid)}`,
      });
    }
    return { uids: [uid], folder: String(headerFolder) };
  }

  // 3a. Body: array (batch from .enrich())
  const body = exchange.body;
  if (
    Array.isArray(body) &&
    body.length > 0 &&
    "uid" in body[0] &&
    "folder" in body[0]
  ) {
    return {
      uids: body.map((m: { uid: number }) => m.uid),
      folder: (body[0] as { folder: string }).folder,
    };
  }

  // 3b. Body: single message
  if (body && typeof body === "object" && "uid" in body && "folder" in body) {
    const msg = body as { uid: number; folder: string };
    return { uids: [msg.uid], folder: msg.folder };
  }

  throw rcError("RC5003", undefined, {
    message:
      "Mail operation requires a mail message context. Ensure the exchange originates from a mail source, has routecraft.mail.uid/routecraft.mail.folder headers, or provide a custom target extractor.",
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalize a string or string array to an array.
 */
export function toArray(value: string | string[]): string[] {
  return Array.isArray(value) ? value : [value];
}

/**
 * Build a raw MIME message from a MailSendPayload using nodemailer's MailComposer.
 */
export async function buildMimeMessage(
  payload: MailSendPayload,
  smtpDefaults: MailClientOptions,
): Promise<Buffer> {
  const MailComposer = (await import("nodemailer/lib/mail-composer")).default;
  const composer = new MailComposer({
    from: payload.from ?? smtpDefaults.from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
    cc: payload.cc ?? smtpDefaults.cc,
    bcc: payload.bcc ?? smtpDefaults.bcc,
    replyTo: payload.replyTo ?? smtpDefaults.replyTo,
    attachments: payload.attachments,
  });
  return composer.compile().build();
}

// ---------------------------------------------------------------------------
// Shared IMAP config builder
// ---------------------------------------------------------------------------

/**
 * Validate IMAP connection options and return a config object for ImapFlow.
 * Shared by both standalone `createImapClient` and `ImapPool.createClient`.
 */
export function buildImapConfig(options: {
  host?: string;
  port?: number;
  secure?: boolean;
  auth?: { user: string; pass: string };
}): {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
  logger: false;
} {
  if (!options.host) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter IMAP host is required. Set host in account config or adapter options.",
    });
  }
  if (!options.auth) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter auth is required. Set auth in account config or adapter options.",
    });
  }
  return {
    host: options.host,
    port: options.port ?? 993,
    secure: options.secure ?? true,
    auth: options.auth,
    logger: false,
  };
}

// ---------------------------------------------------------------------------
// Standalone IMAP client (for inline overrides without named account)
// ---------------------------------------------------------------------------

/**
 * Create a standalone ImapFlow client from resolved server options.
 * Used when an adapter provides inline host/auth overrides (no named account).
 */
export async function createImapClient(
  options: MailServerOptions,
): Promise<InstanceType<typeof import("imapflow").ImapFlow>> {
  const config = buildImapConfig(options);
  const { ImapFlow } = await import("imapflow");
  return new ImapFlow(config);
}

/**
 * Create a nodemailer SMTP transporter from resolved client options.
 * Used when an adapter provides inline host/auth overrides (no named account).
 */
export async function createSmtpTransport(
  options: MailClientOptions,
): Promise<ReturnType<typeof import("nodemailer").createTransport>> {
  if (!options.host) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter SMTP host is required. Set host in account config or adapter options.",
    });
  }
  if (!options.auth) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter auth is required. Set auth in account config or adapter options.",
    });
  }

  const nodemailer = await import("nodemailer");
  return nodemailer.createTransport({
    host: options.host,
    port: options.port ?? 465,
    secure: options.secure ?? true,
    auth: options.auth,
  });
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Check whether an error is an authentication failure.
 */
export function isMailAuthError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("auth") ||
    msg.includes("credentials") ||
    msg.includes("login") ||
    msg.includes("535")
  );
}

/**
 * Throw a RoutecraftError for a mail connection or authentication failure.
 */
export function throwMailConnectionError(
  error: unknown,
  protocol: "IMAP" | "SMTP",
): never {
  const auth = isMailAuthError(error);
  throw rcError(
    auth ? "RC5012" : "RC5010",
    error instanceof Error ? error : undefined,
    {
      message: `Mail adapter ${protocol} ${auth ? "authentication" : "connection"} failed: ${error instanceof Error ? error.message : String(error)}`,
    },
  );
}

// ---------------------------------------------------------------------------
// IMAP search and message parsing
// ---------------------------------------------------------------------------

/**
 * Normalize a search field value to an array.
 */
function toSearchArray(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Build one or more IMAP search criteria sets from server options.
 *
 * Scalar filters (unseen, since) are shared across all sets.
 * Array filters (from, to, subject, body) produce the cartesian product
 * so each combination is a separate IMAP search (OR within a field,
 * AND between fields). Results are deduped by UID after fetching.
 */
export function buildSearchCriteriaSets(
  options: MailServerOptions,
): Record<string, unknown>[] {
  // Shared base criteria (AND between fields)
  const base: Record<string, unknown> = {};
  if (options.unseen !== false) base["seen"] = false;
  if (options.since) base["since"] = options.since;

  // Collect per-field arrays
  const fromValues = toSearchArray(options.from);
  const toValues = toSearchArray(options.to);
  const subjectValues = toSearchArray(options.subject);
  const bodyValues = toSearchArray(options.body);

  // Build field entries: [imapKey, values[]]
  const fields: Array<[string, string[]]> = [];
  if (fromValues.length > 0) fields.push(["from", fromValues]);
  if (toValues.length > 0) fields.push(["to", toValues]);
  if (subjectValues.length > 0) fields.push(["subject", subjectValues]);
  if (bodyValues.length > 0) fields.push(["body", bodyValues]);

  // Raw header filters: each header key expands as OR, AND between keys
  const headerEntries: Array<[string, string[]]> = [];
  if (options.header) {
    for (const [headerName, headerValue] of Object.entries(options.header)) {
      const values = toSearchArray(headerValue);
      if (values.length > 0) headerEntries.push([headerName, values]);
    }
  }

  if (fields.length === 0 && headerEntries.length === 0) return [base];

  // Cartesian product of all field values
  let combinations: Record<string, unknown>[] = [{ ...base }];
  for (const [key, values] of fields) {
    const expanded: Record<string, unknown>[] = [];
    for (const combo of combinations) {
      for (const val of values) {
        expanded.push({ ...combo, [key]: val });
      }
    }
    combinations = expanded;
  }

  // Expand header filters into the cartesian product.
  // ImapFlow expects: { header: { "Header-Name": "value" } }
  // Each header key with multiple values produces OR branches.
  for (const [headerName, values] of headerEntries) {
    const expanded: Record<string, unknown>[] = [];
    for (const combo of combinations) {
      for (const val of values) {
        const existingHeader =
          (combo["header"] as Record<string, string> | undefined) ?? {};
        expanded.push({
          ...combo,
          header: { ...existingHeader, [headerName]: val },
        });
      }
    }
    combinations = expanded;
  }

  return combinations;
}

/**
 * Convert an imapflow message object to a MailMessage.
 *
 * @param msg - Raw message data with uid, flags, and envelope
 * @param folder - The IMAP folder this message was fetched from
 * @param content - Parsed text/html/attachments content
 */
export function toMailMessage(
  msg: {
    uid: number;
    flags: Set<string>;
    envelope: {
      messageId?: string;
      from?: Array<{ address?: string; name?: string }>;
      to?: Array<{ address?: string; name?: string }>;
      cc?: Array<{ address?: string; name?: string }>;
      bcc?: Array<{ address?: string; name?: string }>;
      replyTo?: Array<{ address?: string; name?: string }>;
      subject?: string;
      date?: Date;
    };
  },
  folder: string,
  content?: {
    text?: string;
    html?: string;
    attachments?: Array<{
      filename?: string;
      contentType: string;
      size: number;
      content: Buffer;
    }>;
    rawHeaders?: Record<string, string | string[]>;
  },
): MailMessage {
  const envelope = msg.envelope;
  const fromAddrs = envelope.from ?? [];
  const toAddrs = envelope.to ?? [];
  const ccAddrs = envelope.cc ?? [];
  const bccAddrs = envelope.bcc ?? [];
  const replyToAddrs = envelope.replyTo ?? [];

  const toList = toAddrs
    .map((a) => a.address)
    .filter((a): a is string => a !== undefined);

  const body: { text?: string; html?: string } = {};
  if (content?.text !== undefined) body.text = content.text;
  if (content?.html !== undefined) body.html = content.html;

  const result: MailMessage = {
    uid: msg.uid,
    messageId: envelope.messageId ?? "",
    from: fromAddrs[0]?.address ?? "",
    to: toList.length === 1 ? toList[0] : toList,
    subject: envelope.subject ?? "",
    date: envelope.date ?? new Date(),
    body,
    cc: ccAddrs
      .map((a) => a.address)
      .filter((a): a is string => a !== undefined),
    bcc: bccAddrs
      .map((a) => a.address)
      .filter((a): a is string => a !== undefined),
    flags: msg.flags,
    folder,
  };

  if (replyToAddrs[0]?.address !== undefined)
    result.replyTo = replyToAddrs[0].address;
  if (content?.attachments !== undefined)
    result.attachments = content.attachments;
  if (content?.rawHeaders !== undefined) result.rawHeaders = content.rawHeaders;

  return result;
}

/**
 * Parse a single IMAP message into content fields using mailparser.
 *
 * When `includeAnalysisHeaders` is true, auth-relevant headers are also
 * extracted (independently of `requestedHeaders`) and returned via
 * `analysisHeaders` for sender analysis.
 */
async function parseMessageContent(
  source: Buffer | undefined,
  simpleParser: typeof import("mailparser").simpleParser,
  requestedHeaders?: true | string[],
  includeAnalysisHeaders?: boolean,
  logger?: { debug: (obj: Record<string, unknown>, msg: string) => void },
  uid?: number,
): Promise<{
  text?: string;
  html?: string;
  attachments?: Array<{
    filename?: string;
    contentType: string;
    size: number;
    content: Buffer;
  }>;
  rawHeaders?: Record<string, string | string[]>;
  analysisHeaders?: Record<string, string | string[]>;
}> {
  if (!source) return {};
  try {
    const parsed = await simpleParser(source);
    const content: {
      text?: string;
      html?: string;
      attachments?: Array<{
        filename?: string;
        contentType: string;
        size: number;
        content: Buffer;
      }>;
      rawHeaders?: Record<string, string | string[]>;
      analysisHeaders?: Record<string, string | string[]>;
    } = {};
    if (parsed.text) content.text = parsed.text;
    if (typeof parsed.html === "string") content.html = parsed.html;
    if (parsed.attachments && parsed.attachments.length > 0) {
      content.attachments = parsed.attachments.map((att) => {
        const a: {
          filename?: string;
          contentType: string;
          size: number;
          content: Buffer;
        } = {
          contentType: att.contentType,
          size: att.size,
          content: att.content,
        };
        if (att.filename) a.filename = att.filename;
        return a;
      });
    }
    if (requestedHeaders && parsed.headerLines) {
      const hdrs: Record<string, string | string[]> = {};
      const wanted =
        requestedHeaders === true
          ? null
          : new Set(requestedHeaders.map((h) => h.toLowerCase()));
      for (const entry of parsed.headerLines as Array<{
        key: string;
        line: string;
      }>) {
        if (wanted && !wanted.has(entry.key)) continue;
        // Extract value portion after "Header-Name: "
        const colonIdx = entry.line.indexOf(":");
        const value =
          colonIdx >= 0 ? entry.line.slice(colonIdx + 1).trim() : entry.line;
        // Accumulate multi-value headers (e.g. Received) as arrays
        const existing = hdrs[entry.key];
        if (existing === undefined) {
          hdrs[entry.key] = value;
        } else if (Array.isArray(existing)) {
          existing.push(value);
        } else {
          hdrs[entry.key] = [existing, value];
        }
      }
      if (Object.keys(hdrs).length > 0) content.rawHeaders = hdrs;
    }
    if (includeAnalysisHeaders && parsed.headerLines) {
      const analysis = extractAnalysisHeaders(
        parsed.headerLines as ReadonlyArray<{ key: string; line: string }>,
      );
      if (Object.keys(analysis).length > 0) content.analysisHeaders = analysis;
    }
    return content;
  } catch (err) {
    // Swallow per-message parse failures so one malformed MIME does not abort
    // the whole fetch. Log at debug so operators can correlate an empty body /
    // missing sender back to a parse error.
    logger?.debug(
      { err: err instanceof Error ? err : new Error(String(err)), uid },
      "mail adapter failed to parse message source",
    );
    return {};
  }
}

/**
 * Minimal logger shape accepted by `fetchMessages`. Matches the methods used
 * on a pino child logger without pinning to pino's types.
 */
export interface MailFetchLogger {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

/**
 * Fetch messages from an open IMAP mailbox using the given client.
 * The client must already be connected and have a mailbox open.
 *
 * When search options contain array values (OR semantics within a field),
 * multiple IMAP searches are executed and results are deduped by UID.
 *
 * @param client - Connected ImapFlow client with open mailbox
 * @param options - Resolved IMAP options (for search criteria, limit, markSeen)
 * @param folder - The folder name (for setting on MailMessage)
 * @param logger - Optional logger for parse/verify diagnostics
 */
export async function fetchMessages(
  client: InstanceType<typeof import("imapflow").ImapFlow>,
  options: MailServerOptions,
  folder: string,
  logger?: MailFetchLogger,
): Promise<MailMessage[]> {
  const criteriaSets = buildSearchCriteriaSets(options);
  const messages: MailMessage[] = [];
  const seenUids = new Set<number>();

  try {
    const fetchOptions = {
      envelope: true,
      uid: true,
      flags: true,
      source: true,
    };

    const { simpleParser } = await import("mailparser");
    const verify = options.verify ?? "headers";

    for (const criteria of criteriaSets) {
      let searchQuery: Record<string, unknown> | string = criteria;
      if (Object.keys(criteria).length === 0) {
        searchQuery = "1:*";
      }

      for await (const msg of client.fetch(searchQuery, fetchOptions)) {
        // Dedupe across criteria sets
        if (seenUids.has(msg.uid)) continue;
        seenUids.add(msg.uid);

        const content = await parseMessageContent(
          msg.source,
          simpleParser,
          options.includeHeaders,
          verify !== "off",
          logger,
          msg.uid,
        );

        const mailMessage = toMailMessage(
          {
            uid: msg.uid,
            flags: msg.flags ?? new Set(),
            envelope: msg.envelope ?? {},
          },
          folder,
          content,
        );

        if (verify !== "off") {
          const analysisHeaders = content.analysisHeaders;
          // Only populate `sender` when we have headers to analyse. An empty
          // map means the source buffer was missing or unparseable; stamping
          // a degenerate `sender` with empty address would be worse than
          // omitting it, since consumers cannot distinguish "analysis ran"
          // from "analysis found nothing".
          if (analysisHeaders && Object.keys(analysisHeaders).length > 0) {
            let sender: MailSender = analyzeHeaders(analysisHeaders);
            if (verify === "strict") {
              try {
                const { verifyStrict } = await import("./strict-verify.ts");
                sender = await verifyStrict(msg.source, sender);
              } catch (error) {
                // Do not let a single verification failure (transient DNS,
                // malformed signature, missing mailauth install surfacing
                // mid-fetch) tear down the whole poll cycle. Degrade trust
                // and continue.
                sender = {
                  ...sender,
                  trust: "failed",
                  reason: "strict-verify-error",
                };
                logger?.warn(
                  {
                    err:
                      error instanceof Error ? error : new Error(String(error)),
                    uid: msg.uid,
                    folder,
                  },
                  "mail adapter strict verify failed; continuing with header-only verdict",
                );
              }
            }
            mailMessage.sender = sender;
            // Observability: one structured log line per message describing the
            // verdict. Debug for verified/unverified (can be noisy), warn for
            // failed so security graphs can scrape "DMARC failures per hour"
            // without needing a bespoke event type.
            const verdictLog = {
              uid: msg.uid,
              folder,
              mode: verify,
              forwardType: sender.forwardType,
              trust: sender.trust,
              reason: sender.reason,
              authentication: sender.authentication,
            };
            if (sender.trust === "failed") {
              logger?.warn(verdictLog, "mail adapter verify: trust failed");
            } else {
              logger?.debug(verdictLog, "mail adapter verify: completed");
            }
          }
        }

        messages.push(mailMessage);

        if (options.limit && messages.length >= options.limit) {
          break;
        }
      }

      // Stop searching further criteria sets if limit reached
      if (options.limit && messages.length >= options.limit) {
        break;
      }
    }
  } catch (error) {
    throw rcError("RC5001", error instanceof Error ? error : undefined, {
      message: `Failed to fetch messages from IMAP: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return messages;
}

/**
 * Mark one or more messages as \Seen on an open IMAP mailbox.
 *
 * Never throws: flagging failure degrades correctness (a message may be
 * redelivered) but must not tear down the fetch cycle or source subscription.
 * Callers that care about the failure should pass a logger.
 *
 * @param client - Connected ImapFlow client with the target mailbox open
 * @param uids - UIDs to flag. May be a single uid or an array. Empty arrays are a no-op.
 * @param logger - Optional logger for flagging diagnostics
 */
export async function markMessagesSeen(
  client: InstanceType<typeof import("imapflow").ImapFlow>,
  uids: number | number[],
  logger?: MailFetchLogger,
): Promise<void> {
  const list = Array.isArray(uids) ? uids : [uids];
  if (list.length === 0) return;
  try {
    await client.messageFlagsAdd(list.join(","), ["\\Seen"], {
      uid: true,
    });
  } catch (error) {
    logger?.warn(
      {
        err: error instanceof Error ? error : new Error(String(error)),
        uids: list,
      },
      "mail adapter failed to mark messages as seen",
    );
  }
}
