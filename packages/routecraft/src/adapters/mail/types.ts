/**
 * Mail adapter type definitions.
 *
 * Server options configure IMAP (read/receive).
 * Client options configure SMTP (send).
 *
 * @experimental
 */

/**
 * Authentication credentials for mail servers.
 * Supports app passwords and standard user/pass authentication.
 */
export interface MailAuth {
  user: string;
  pass: string;
}

/**
 * Options when using the mail adapter as a Server (IMAP read).
 * Used with `.enrich(mail({...}))` or `.from(mail(folder, {...}))`.
 */
export interface MailServerOptions {
  /** IMAP host (e.g. 'imap.gmail.com') */
  host?: string;
  /** IMAP port (default 993) */
  port?: number;
  /** Use TLS (default true) */
  secure?: boolean;
  /** Authentication credentials */
  auth?: MailAuth;
  /** IMAP mailbox folder (default 'INBOX') */
  folder?: string;
  /** Mark fetched messages as seen (default true) */
  markSeen?: boolean;
  /** Only fetch messages since this date */
  since?: Date;
  /** Only fetch unseen messages (default true) */
  unseen?: boolean;
  /** Maximum number of messages to fetch per call */
  limit?: number;
  /** Human-readable description for route discovery */
  description?: string;
  /** Keywords for route discovery and categorization */
  keywords?: string[];
  /** Poll interval in ms for Source mode (default: use IMAP IDLE) */
  pollIntervalMs?: number;
}

/**
 * Options when using the mail adapter as a Client (SMTP send).
 * Used with `.to(mail())` or `.to(mail({...}))`.
 */
export interface MailClientOptions {
  /** SMTP host (e.g. 'smtp.gmail.com') */
  host?: string;
  /** SMTP port (default 465) */
  port?: number;
  /** Use TLS (default true) */
  secure?: boolean;
  /** Authentication credentials */
  auth?: MailAuth;
  /** Default sender address */
  from?: string;
  /** Default reply-to address */
  replyTo?: string;
}

/** Options when using mail as a server or client (union). */
export type MailOptions = MailServerOptions | MailClientOptions;

/**
 * Internal merged options for context store.
 * Uses prefixed host/port/secure fields so IMAP and SMTP config can coexist.
 * Shared fields (auth, from, replyTo) apply to both protocols.
 * @internal
 */
export interface MailOptionsMerged {
  /** Shared auth (same app password typically works for both IMAP and SMTP) */
  auth?: MailAuth;

  /** IMAP host (e.g. 'imap.gmail.com') */
  imapHost?: string;
  /** IMAP port (default 993) */
  imapPort?: number;
  /** IMAP TLS (default true) */
  imapSecure?: boolean;

  /** SMTP host (e.g. 'smtp.gmail.com') */
  smtpHost?: string;
  /** SMTP port (default 465) */
  smtpPort?: number;
  /** SMTP TLS (default true) */
  smtpSecure?: boolean;

  /** Default sender address for all routes */
  from?: string;
  /** Default reply-to address for all routes */
  replyTo?: string;
  /** Default IMAP folder */
  folder?: string;
  /** Default markSeen behavior */
  markSeen?: boolean;
}

/**
 * A parsed email message returned by the mail adapter source/fetch.
 * @experimental
 */
export interface MailMessage {
  /** IMAP UID */
  uid: number;
  /** Message-ID header */
  messageId: string;
  /** Sender address */
  from: string;
  /** Recipient address(es) */
  to: string | string[];
  /** Subject line */
  subject: string;
  /** Date the message was sent */
  date: Date;
  /** Plain text body */
  text?: string;
  /** HTML body */
  html?: string;
  /** CC recipients */
  cc?: string[];
  /** BCC recipients */
  bcc?: string[];
  /** Reply-to address */
  replyTo?: string;
  /** File attachments */
  attachments?: MailAttachment[];
  /** IMAP flags (e.g. \Seen, \Flagged) */
  flags: Set<string>;
}

/**
 * A file attachment on a mail message.
 * @experimental
 */
export interface MailAttachment {
  /** Filename if available */
  filename?: string;
  /** MIME content type */
  contentType: string;
  /** Size in bytes */
  size: number;
  /** Raw attachment content */
  content: Buffer;
}

/**
 * Payload expected in exchange.body when sending email via `.to(mail())`.
 * @experimental
 */
export interface MailSendPayload {
  /** Recipient address(es) */
  to: string | string[];
  /** Subject line */
  subject: string;
  /** Plain text body */
  text?: string;
  /** HTML body */
  html?: string;
  /** CC recipients */
  cc?: string | string[];
  /** BCC recipients */
  bcc?: string | string[];
  /** Sender address (overrides option-level from) */
  from?: string;
  /** Reply-to address (overrides option-level replyTo) */
  replyTo?: string;
  /** File attachments */
  attachments?: Array<{
    filename: string;
    content: Buffer | string;
    contentType?: string;
  }>;
}

/**
 * Result returned after sending an email.
 * @experimental
 */
export interface MailSendResult {
  /** Message-ID of the sent email */
  messageId: string;
  /** Accepted recipient addresses */
  accepted: string[];
  /** Rejected recipient addresses */
  rejected: string[];
  /** SMTP server response string */
  response: string;
}

/**
 * Result returned by the fetch destination (array of messages).
 * @experimental
 */
export type MailFetchResult = MailMessage[];
