/**
 * Mail adapter type definitions.
 *
 * Server options configure IMAP (read/receive).
 * Client options configure SMTP (send).
 *
 * @experimental
 */

import type { Exchange } from "../../exchange.ts";
import type { MailSender } from "./analysis.ts";
import type { OnParseError } from "../shared/parse.ts";

/**
 * Authentication credentials for mail servers.
 * Supports app passwords and standard user/pass authentication.
 */
export interface MailAuth {
  user: string;
  pass: string;
}

// ---------------------------------------------------------------------------
// Context-level configuration (named accounts)
// ---------------------------------------------------------------------------

/**
 * IMAP connection settings for a named account.
 */
export interface MailAccountImapConfig {
  /** IMAP host (e.g. 'imap.gmail.com') */
  host?: string;
  /** IMAP port (default 993) */
  port?: number;
  /** Use TLS (default true) */
  secure?: boolean;
  /** Authentication credentials */
  auth?: MailAuth;
  /** Max concurrent IMAP connections for this account (default 3) */
  poolSize?: number;
}

/**
 * SMTP connection settings for a named account.
 */
export interface MailAccountSmtpConfig {
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
  /** Default CC recipients */
  cc?: string | string[];
  /** Default BCC recipients */
  bcc?: string | string[];
}

/**
 * Configuration for a named mail account.
 * Each account defines its own IMAP and/or SMTP connection.
 *
 * @example
 * ```typescript
 * {
 *   imap: { host: 'imap.gmail.com', auth: { user: 'me@co.com', pass: 'xxx' } },
 *   smtp: { host: 'smtp.gmail.com', auth: { user: 'me@co.com', pass: 'xxx' }, from: 'me@co.com' },
 * }
 * ```
 *
 * @experimental
 */
export interface MailAccountConfig {
  /** IMAP connection settings */
  imap?: MailAccountImapConfig;
  /** SMTP connection settings */
  smtp?: MailAccountSmtpConfig;
}

/**
 * Context-level mail configuration. Added to CraftConfig via `.with({ mail: {...} })`.
 *
 * @example
 * ```typescript
 * new ContextBuilder().with({
 *   mail: {
 *     accounts: {
 *       default: { imap: {...}, smtp: {...} },
 *       support: { imap: {...}, smtp: {...} },
 *     },
 *     folder: 'INBOX',
 *     markSeen: true,
 *   },
 * })
 * ```
 *
 * @experimental
 */
export interface MailContextConfig {
  /** Named mail accounts */
  accounts?: Record<string, MailAccountConfig>;
  /** Default IMAP folder across all accounts (default 'INBOX') */
  folder?: string;
  /** Default markSeen behavior across all accounts (default true) */
  markSeen?: boolean;
}

// ---------------------------------------------------------------------------
// Per-operation options (adapter-level overrides)
// ---------------------------------------------------------------------------

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
  /** Filter by sender address (IMAP FROM search, case-insensitive). Array = OR. */
  from?: string | string[];
  /** Filter by recipient address (IMAP TO search, case-insensitive). Array = OR. */
  to?: string | string[];
  /** Filter by subject text (IMAP SUBJECT search, case-insensitive). Array = OR. */
  subject?: string | string[];
  /** Filter by body text (IMAP TEXT search, case-insensitive). Array = OR. */
  body?: string | string[];
  /**
   * Filter by arbitrary IMAP headers (IMAP HEADER search).
   * Keys are header names, values are substring matches. Array values = OR.
   *
   * @example
   * ```typescript
   * // Match emails with Reply-To containing "no-reply"
   * mail({ header: { "Reply-To": "no-reply" } })
   *
   * // Match emails with a specific List-Id
   * mail({ header: { "List-Id": "announcements.example.com" } })
   *
   * // OR within a header: match "noreply" or "no-reply" in Reply-To
   * mail({ header: { "Reply-To": ["noreply", "no-reply"] } })
   * ```
   */
  header?: Record<string, string | string[]>;
  /** Maximum number of messages to fetch per call */
  limit?: number;
  /** Human-readable description for route discovery */
  description?: string;
  /** Keywords for route discovery and categorization */
  keywords?: string[];
  /** Poll interval in ms for Source mode (default: use IMAP IDLE) */
  pollIntervalMs?: number;
  /** Named account from context config (uses default if omitted) */
  account?: string;
  /**
   * Raw email headers to include on fetched messages.
   * Pass `true` to include all headers, or an array of header names to
   * include only specific ones (case-insensitive). Defaults to none.
   *
   * @example
   * ```typescript
   * // Include all headers (useful for discovery)
   * mail('INBOX', { includeHeaders: true })
   *
   * // Include specific headers only (keeps exchange size small)
   * mail('INBOX', { includeHeaders: ['Return-Path', 'DKIM-Signature', 'X-Spam-Status'] })
   * ```
   */
  includeHeaders?: true | string[];
  /**
   * How hard to verify the sender. Populates `MailMessage.sender` so apps can
   * gate on the real origin of mailing-list and auto-forwarded mail without
   * re-parsing headers themselves.
   *
   * - `"off"`: skip analysis, `sender` is omitted.
   * - `"headers"` (default): parse `Authentication-Results`, `ARC-*`, `List-Id`,
   *   `X-Original-From` that the receiving server already wrote. No network.
   * - `"strict"`: additionally run cryptographic verification via `mailauth`.
   *   Does DNS lookups and is slower; only use when the receiving server is
   *   not trusted to have verified the chain for you.
   */
  verify?: "off" | "headers" | "strict";

  /**
   * How to handle a per-message MIME parse failure (`mailparser`'s
   * `simpleParser` throwing on malformed input). All modes mark the
   * malformed message as Seen so it does not refetch indefinitely.
   *
   * - `'fail'` (default): `exchange:failed` fires for the bad message; the
   *   route's `.error()` handler can catch it; the poll loop continues.
   * - `'abort'`: `exchange:failed` fires for the bad message, then the
   *   source rejects and `context:error` fires.
   * - `'drop'`: `exchange:dropped` fires with `reason: "parse-failed"` and
   *   the poll loop continues. Use this when malformed mail is expected
   *   and you want it counted in `exchange:dropped` metrics rather than
   *   surfaced as route errors.
   *
   * Pre-#187 behaviour was equivalent to `'drop'` but logged at debug
   * with no event; the new `'fail'` default routes the failure through
   * `.error()` and is observable. Set `onParseError: 'drop'` to keep the
   * lossy-ingest semantics with proper observability.
   *
   * @default "fail"
   * @experimental
   */
  onParseError?: OnParseError;
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
  /** Default CC recipients */
  cc?: string | string[];
  /** Default BCC recipients */
  bcc?: string | string[];
  /** Named account from context config (uses default if omitted) */
  account?: string;
}

/** Options when using mail as a server or client (union). */
export type MailOptions = MailServerOptions | MailClientOptions;

// ---------------------------------------------------------------------------
// Action types (IMAP operations)
// ---------------------------------------------------------------------------

/**
 * Custom extractor for resolving message identity from an exchange.
 * Returns the UIDs and source folder needed to operate on messages.
 *
 * @experimental
 */
export type MailTargetExtractor = (exchange: Exchange<unknown>) => {
  uids: number[];
  folder: string;
};

/**
 * Shared base for all mail action types.
 * Every action can select a named account and provide a custom target extractor.
 */
interface MailActionBase {
  /** Named account from context config (uses default if omitted) */
  account?: string;
  /** Custom extractor for uid/folder when not using standard header/body locations */
  target?: MailTargetExtractor;
}

/** Move message(s) to another IMAP folder. */
export type MailMoveAction = MailActionBase & {
  action: "move";
  folder: string;
};

/** Copy message(s) to another IMAP folder. */
export type MailCopyAction = MailActionBase & {
  action: "copy";
  folder: string;
};

/** Delete message(s) permanently. */
export type MailDeleteAction = MailActionBase & { action: "delete" };

/** Add IMAP flags to message(s). */
export type MailFlagAction = MailActionBase & {
  action: "flag";
  flags: string | string[];
};

/** Remove IMAP flags from message(s). */
export type MailUnflagAction = MailActionBase & {
  action: "unflag";
  flags: string | string[];
};

/** Append a composed message to an IMAP folder (drafts, imports). */
export type MailAppendAction = MailActionBase & {
  action: "append";
  folder: string;
  flags?: string | string[];
  date?: Date;
};

/**
 * Discriminated union for IMAP operations on mail messages.
 * The `action` field narrows available options via TypeScript.
 *
 * @experimental
 */
export type MailAction =
  | MailMoveAction
  | MailCopyAction
  | MailDeleteAction
  | MailFlagAction
  | MailUnflagAction
  | MailAppendAction;

// ---------------------------------------------------------------------------
// Message types
// ---------------------------------------------------------------------------

/**
 * A parsed email message returned by the mail adapter source/fetch.
 * @experimental
 */
export interface MailMessage {
  /** IMAP UID */
  uid: number;
  /** Message-ID header */
  messageId: string;
  /**
   * Literal `From:` header.
   *
   * For mailing-list forwards (e.g. Google Groups) this is the rewritten list
   * address. Use {@link MailSender.address} on {@link MailMessage.sender} for
   * the real sender when `verify !== "off"`.
   */
  from: string;
  /** Recipient address(es) */
  to: string | string[];
  /** Subject line */
  subject: string;
  /** Date the message was sent */
  date: Date;
  /**
   * Message body. `text` and `html` are two representations of the same
   * content and either, both, or neither may be populated depending on what
   * the sender composed (`multipart/alternative` vs a single-part message).
   */
  body: {
    /** Plain text body, when the message included a `text/plain` part. */
    text?: string;
    /** HTML body, when the message included a `text/html` part. */
    html?: string;
  };
  /** CC recipients */
  cc?: string[];
  /** BCC recipients */
  bcc?: string[];
  /** Reply-to address */
  replyTo?: string;
  /** File attachments */
  attachments?: MailAttachment[];
  /**
   * Raw email headers (only those requested via the `includeHeaders` option).
   * Keys are lowercased header names, values are strings or arrays for
   * multi-value headers (e.g. multiple Received lines).
   */
  rawHeaders?: Record<string, string | string[]>;
  /** IMAP flags (e.g. \Seen, \Flagged) */
  flags: Set<string>;
  /** The IMAP folder this message was fetched from */
  folder: string;
  /**
   * Computed effective sender with forward-chain and authentication evidence.
   * Omitted when the adapter is configured with `verify: "off"`.
   *
   * For mailing-list forwards (e.g. Google Groups) this resolves to the
   * original sender, not the rewritten `From:` header. For auto-forwards it
   * mirrors `from`. See {@link MailSender} for the full shape.
   */
  sender?: MailSender;
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
