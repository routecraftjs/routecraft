import type { CraftContext } from "../../context.ts";
import { rcError } from "../../error.ts";
import type {
  MailMessage,
  MailOptionsMerged,
  MailServerOptions,
  MailClientOptions,
} from "./types.ts";

/**
 * Store key for merged mail adapter options.
 * Set in the context store to configure auth, hosts, and defaults for all mail routes.
 *
 * @example
 * ```typescript
 * new ContextBuilder()
 *   .store(ADAPTER_MAIL_OPTIONS, {
 *     auth: { user: 'me@gmail.com', pass: 'app-password' },
 *     imapHost: 'imap.gmail.com',
 *     smtpHost: 'smtp.gmail.com',
 *     from: 'me@gmail.com',
 *   })
 * ```
 *
 * @experimental
 */
export const ADAPTER_MAIL_OPTIONS = Symbol.for(
  "routecraft.adapter.mail.options",
);

declare module "@routecraft/routecraft" {
  interface StoreRegistry {
    [ADAPTER_MAIL_OPTIONS]: Partial<MailOptionsMerged>;
  }
}

/**
 * Resolve IMAP connection options by merging context store with adapter-level options.
 * Context store fields `imapHost`/`imapPort`/`imapSecure` map to `host`/`port`/`secure`.
 * Adapter-level options take precedence over context store values.
 *
 * @param context - The CraftContext
 * @param adapterOptions - Options passed to the adapter constructor
 * @returns Resolved MailServerOptions with host/port/auth populated
 */
export function getMergedImapOptions(
  context: CraftContext,
  adapterOptions: Partial<MailServerOptions>,
): MailServerOptions {
  const store = (context.getStore(ADAPTER_MAIL_OPTIONS) ??
    {}) as Partial<MailOptionsMerged>;

  const result: MailServerOptions = {
    port: adapterOptions.port ?? store.imapPort ?? 993,
    secure: adapterOptions.secure ?? store.imapSecure ?? true,
    folder: adapterOptions.folder ?? store.folder ?? "INBOX",
    markSeen: adapterOptions.markSeen ?? store.markSeen ?? true,
    unseen: adapterOptions.unseen ?? true,
  };

  const host = adapterOptions.host ?? store.imapHost;
  if (host !== undefined) result.host = host;

  const auth = adapterOptions.auth ?? store.auth;
  if (auth !== undefined) result.auth = auth;

  if (adapterOptions.since !== undefined) result.since = adapterOptions.since;
  if (adapterOptions.limit !== undefined) result.limit = adapterOptions.limit;
  if (adapterOptions.description !== undefined)
    result.description = adapterOptions.description;
  if (adapterOptions.keywords !== undefined)
    result.keywords = adapterOptions.keywords;
  if (adapterOptions.pollIntervalMs !== undefined)
    result.pollIntervalMs = adapterOptions.pollIntervalMs;

  return result;
}

/**
 * Resolve SMTP connection options by merging context store with adapter-level options.
 * Context store fields `smtpHost`/`smtpPort`/`smtpSecure` map to `host`/`port`/`secure`.
 * Adapter-level options take precedence over context store values.
 *
 * @param context - The CraftContext
 * @param adapterOptions - Options passed to the adapter constructor
 * @returns Resolved MailClientOptions with host/port/auth populated
 */
export function getMergedSmtpOptions(
  context: CraftContext,
  adapterOptions: Partial<MailClientOptions>,
): MailClientOptions {
  const store = (context.getStore(ADAPTER_MAIL_OPTIONS) ??
    {}) as Partial<MailOptionsMerged>;

  const result: MailClientOptions = {
    port: adapterOptions.port ?? store.smtpPort ?? 465,
    secure: adapterOptions.secure ?? store.smtpSecure ?? true,
  };

  const host = adapterOptions.host ?? store.smtpHost;
  if (host !== undefined) result.host = host;

  const auth = adapterOptions.auth ?? store.auth;
  if (auth !== undefined) result.auth = auth;

  const from = adapterOptions.from ?? store.from;
  if (from !== undefined) result.from = from;

  const replyTo = adapterOptions.replyTo ?? store.replyTo;
  if (replyTo !== undefined) result.replyTo = replyTo;

  return result;
}

/**
 * Cast protocol-specific resolved options to the merged options type
 * expected by the {@link MergedOptions} interface. At runtime the shapes
 * are compatible; the type mismatch exists because `MailServerOptions` and
 * `MailClientOptions` use `host`/`port`/`secure` while `MailOptionsMerged`
 * uses prefixed `imapHost`/`smtpHost` fields.
 */
export function asMergedOptions(
  opts: MailServerOptions | MailClientOptions,
): MailOptionsMerged {
  return opts as unknown as MailOptionsMerged;
}

/**
 * Create an ImapFlow client instance from resolved server options.
 * Validates that required fields (host, auth) are present.
 *
 * @param options - Resolved IMAP options
 * @returns ImapFlow client (not yet connected)
 */
export async function createImapClient(
  options: MailServerOptions,
): Promise<InstanceType<typeof import("imapflow").ImapFlow>> {
  if (!options.host) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter IMAP host is required. Set host in adapter options or imapHost in context store.",
    });
  }
  if (!options.auth) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter auth is required. Set auth in adapter options or context store.",
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
 * Validates that required fields (host, auth) are present.
 *
 * @param options - Resolved SMTP options
 * @returns nodemailer Transporter
 */
export async function createSmtpTransport(
  options: MailClientOptions,
): Promise<ReturnType<typeof import("nodemailer").createTransport>> {
  if (!options.host) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter SMTP host is required. Set host in adapter options or smtpHost in context store.",
    });
  }
  if (!options.auth) {
    throw rcError("RC5003", undefined, {
      message:
        "Mail adapter auth is required. Set auth in adapter options or context store.",
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

/**
 * Check whether an error is an authentication failure based on common error message patterns.
 *
 * @param error - The caught error
 * @returns true if the error indicates an auth failure
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
 *
 * @param error - The caught error
 * @param protocol - Which protocol failed (IMAP or SMTP)
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

/**
 * Build IMAP search criteria from server options.
 *
 * @param options - Resolved IMAP options
 * @returns Search criteria object for ImapFlow
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
 * @param content - Parsed text/html/attachments content
 * @returns Parsed MailMessage
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
 * @returns Array of parsed MailMessages
 */
export async function fetchMessages(
  client: InstanceType<typeof import("imapflow").ImapFlow>,
  options: MailServerOptions,
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
          // TODO: log when fetchMessages accepts a logger parameter
        }
      }

      const mailMessage = toMailMessage(
        {
          uid: msg.uid,
          flags: msg.flags ?? new Set(),
          envelope: msg.envelope ?? {},
        },
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
        await client.messageFlagsAdd(uids.join(","), ["\\Seen"], { uid: true });
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
