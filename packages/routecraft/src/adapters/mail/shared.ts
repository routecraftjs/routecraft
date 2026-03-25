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

// ---------------------------------------------------------------------------
// Store keys
// ---------------------------------------------------------------------------

/**
 * Store key for the mail client manager.
 * Set internally by the ContextBuilder when `mail` config is present.
 * @internal
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
    return { uids: [Number(headerUid)], folder: String(headerFolder) };
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
// Standalone IMAP client (for inline overrides without named account)
// ---------------------------------------------------------------------------

/**
 * Create a standalone ImapFlow client from resolved server options.
 * Used when an adapter provides inline host/auth overrides (no named account).
 */
export async function createImapClient(
  options: MailServerOptions,
): Promise<InstanceType<typeof import("imapflow").ImapFlow>> {
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

  const { ImapFlow } = await import("imapflow");
  return new ImapFlow({
    host: options.host,
    port: options.port ?? 993,
    secure: options.secure ?? true,
    auth: options.auth,
    logger: false,
  });
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
 * Build IMAP search criteria from server options.
 */
export function buildSearchCriteria(
  options: MailServerOptions,
): Record<string, unknown> {
  const criteria: Record<string, unknown> = {};

  if (options.unseen !== false) {
    criteria["seen"] = false;
  }

  if (options.since) {
    criteria["since"] = options.since;
  }

  return criteria;
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

  const result: MailMessage = {
    uid: msg.uid,
    messageId: envelope.messageId ?? "",
    from: fromAddrs[0]?.address ?? "",
    to: toList.length === 1 ? toList[0] : toList,
    subject: envelope.subject ?? "",
    date: envelope.date ?? new Date(),
    cc: ccAddrs
      .map((a) => a.address)
      .filter((a): a is string => a !== undefined),
    bcc: bccAddrs
      .map((a) => a.address)
      .filter((a): a is string => a !== undefined),
    flags: msg.flags,
    folder,
  };

  if (content?.text !== undefined) result.text = content.text;
  if (content?.html !== undefined) result.html = content.html;
  if (replyToAddrs[0]?.address !== undefined)
    result.replyTo = replyToAddrs[0].address;
  if (content?.attachments !== undefined)
    result.attachments = content.attachments;

  return result;
}

/**
 * Fetch messages from an open IMAP mailbox using the given client.
 * The client must already be connected and have a mailbox open.
 *
 * @param client - Connected ImapFlow client with open mailbox
 * @param options - Resolved IMAP options (for search criteria, limit, markSeen)
 * @param folder - The folder name (for setting on MailMessage)
 */
export async function fetchMessages(
  client: InstanceType<typeof import("imapflow").ImapFlow>,
  options: MailServerOptions,
  folder: string,
): Promise<MailMessage[]> {
  const criteria = buildSearchCriteria(options);
  const messages: MailMessage[] = [];

  let searchQuery: Record<string, unknown> | string = criteria;
  if (Object.keys(criteria).length === 0) {
    searchQuery = "1:*";
  }

  try {
    const fetchOptions = {
      envelope: true,
      uid: true,
      flags: true,
      source: true,
    };

    const { simpleParser } = await import("mailparser");

    for await (const msg of client.fetch(searchQuery, fetchOptions)) {
      // Parse the source to get text/html content
      const content: {
        text?: string;
        html?: string;
        attachments?: Array<{
          filename?: string;
          contentType: string;
          size: number;
          content: Buffer;
        }>;
      } = {};

      if (msg.source) {
        try {
          const parsed = await simpleParser(msg.source);
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
        } catch {
          // If parsing fails, continue without content.
        }
      }

      const mailMessage = toMailMessage(
        {
          uid: msg.uid,
          flags: msg.flags ?? new Set(),
          envelope: msg.envelope ?? {},
        },
        folder,
        content,
      );
      messages.push(mailMessage);

      if (options.limit && messages.length >= options.limit) {
        break;
      }
    }

    // Mark messages as seen after successful fetch
    if (options.markSeen !== false && messages.length > 0) {
      const uids = messages.map((m) => m.uid);
      try {
        await client.messageFlagsAdd(uids.join(","), ["\\Seen"], {
          uid: true,
        });
      } catch {
        // Non-fatal: log but do not throw if flagging fails
      }
    }
  } catch (error) {
    throw rcError("RC5001", error instanceof Error ? error : undefined, {
      message: `Failed to fetch messages from IMAP: ${error instanceof Error ? error.message : String(error)}`,
    });
  }

  return messages;
}
