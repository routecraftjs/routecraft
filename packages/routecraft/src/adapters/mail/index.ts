import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { MailSourceAdapter } from "./source.ts";
import { MailFetchDestinationAdapter } from "./fetch-destination.ts";
import { MailSendDestinationAdapter } from "./send-destination.ts";
import { MailOperationDestinationAdapter } from "./operation-destination.ts";
import type {
  MailServerOptions,
  MailClientOptions,
  MailMessage,
  MailFetchResult,
  MailSendPayload,
  MailSendResult,
  MailAction,
} from "./types.ts";

/**
 * Creates a mail adapter for reading email via IMAP, sending via SMTP,
 * or performing IMAP operations (move, copy, delete, flag, unflag, append).
 *
 * **Source (for `.from()`):** Call with two arguments: `mail(folder, options)`.
 * Uses IMAP IDLE or polling to push new messages to the route.
 *
 * **Fetch Destination (for `.enrich()`):** Call with a folder string or server options.
 * Fetches messages from IMAP and returns them as the enrichment result.
 *
 * **Send Destination (for `.to()`):** Call with no arguments or client options.
 * Sends email via SMTP using the exchange body as the payload.
 *
 * **Operation Destination (for `.to()`):** Call with a MailAction object.
 * Performs IMAP operations (move, copy, delete, flag, unflag, append) on messages.
 *
 * @example
 * ```typescript
 * // Fetch mail via .enrich() (primary pattern)
 * craft()
 *   .from(cron('0 0/5 * * * *'))
 *   .enrich(mail('INBOX'))
 *   .to(processMessages())
 *
 * // Source: IMAP IDLE for push-based processing
 * craft()
 *   .from(mail('INBOX', { markSeen: true }))
 *   .to(processMessage())
 *
 * // Send mail via .to()
 * craft()
 *   .id('outbound')
 *   .from(direct())
 *   .to(mail())
 *
 * // IMAP operations
 * craft()
 *   .from(mail('INBOX', { unseen: true }))
 *   .to(mail({ action: 'move', folder: 'Archive' }))
 *
 * // Named account
 * craft()
 *   .from(mail('INBOX', { account: 'support' }))
 *   .to(mail({ action: 'flag', flags: '\\Seen', account: 'support' }))
 * ```
 *
 * @param folder - IMAP mailbox folder name (e.g. 'INBOX')
 * @param options - Server options for IMAP connection and fetch behavior
 * @returns Source, Fetch Destination, Send Destination, or Operation Destination depending on arguments
 *
 * @experimental
 */
export function mail(
  folder: string,
  options: Partial<MailServerOptions>,
): Source<MailMessage>;
export function mail(folder: string): Destination<unknown, MailFetchResult>;
export function mail(
  options: Partial<MailServerOptions>,
): Destination<unknown, MailFetchResult>;
export function mail(action: MailAction): Destination<unknown, void>;
export function mail(
  options?: Partial<MailClientOptions>,
): Destination<MailSendPayload, MailSendResult>;
export function mail(
  folderOrOptions?:
    | string
    | Partial<MailServerOptions>
    | Partial<MailClientOptions>
    | MailAction,
  options?: Partial<MailServerOptions>,
):
  | Source<MailMessage>
  | Destination<unknown, MailFetchResult>
  | Destination<MailSendPayload, MailSendResult>
  | Destination<unknown, void> {
  const args = factoryArgs(folderOrOptions, options);

  // 2 args: string + object -> Source (matches direct(endpoint, options) pattern)
  if (typeof folderOrOptions === "string" && options !== undefined) {
    const adapter = new MailSourceAdapter(folderOrOptions, options);
    return tagAdapter(adapter, mail, args) as Source<MailMessage>;
  }

  // 1 arg string -> Fetch Destination (folder shorthand for .enrich())
  if (typeof folderOrOptions === "string") {
    const adapter = new MailFetchDestinationAdapter({
      folder: folderOrOptions,
    });
    return tagAdapter(adapter, mail, args) as Destination<
      unknown,
      MailFetchResult
    >;
  }

  // Action discriminator -> Operation Destination (checked before hasServerKeys)
  if (folderOrOptions && "action" in folderOrOptions) {
    const adapter = new MailOperationDestinationAdapter(
      folderOrOptions as MailAction,
    );
    return tagAdapter(adapter, mail, args) as Destination<unknown, void>;
  }

  // Object with server-specific keys -> Fetch Destination
  if (folderOrOptions && hasServerKeys(folderOrOptions)) {
    const adapter = new MailFetchDestinationAdapter(
      folderOrOptions as Partial<MailServerOptions>,
    );
    return tagAdapter(adapter, mail, args) as Destination<
      unknown,
      MailFetchResult
    >;
  }

  // No args or client-only keys -> Send Destination
  const adapter = new MailSendDestinationAdapter(
    folderOrOptions as Partial<MailClientOptions> | undefined,
  );
  return tagAdapter(adapter, mail, args) as Destination<
    MailSendPayload,
    MailSendResult
  >;
}

/**
 * Check whether options contain server-specific keys that indicate
 * an IMAP fetch/source intent rather than an SMTP send intent.
 */
function hasServerKeys(opts: object): boolean {
  return (
    "folder" in opts ||
    "markSeen" in opts ||
    "since" in opts ||
    "unseen" in opts ||
    "limit" in opts ||
    "pollIntervalMs" in opts ||
    "subject" in opts ||
    "to" in opts ||
    "body" in opts ||
    "header" in opts ||
    "includeHeaders" in opts
  );
}

// Re-export types for public API
export type {
  MailAuth,
  MailServerOptions,
  MailClientOptions,
  MailOptions,
  MailMessage,
  MailAttachment,
  MailSendPayload,
  MailSendResult,
  MailFetchResult,
  MailContextConfig,
  MailAccountConfig,
  MailAccountImapConfig,
  MailAccountSmtpConfig,
  MailAction,
  MailMoveAction,
  MailCopyAction,
  MailDeleteAction,
  MailFlagAction,
  MailUnflagAction,
  MailAppendAction,
  MailTargetExtractor,
} from "./types.ts";

// Re-export store key and client manager
export { MAIL_CLIENT_MANAGER } from "./shared.ts";
export { MailClientManager } from "./client-manager.ts";

// Sender analysis
export type {
  MailSender,
  EmailAddress,
  ForwardHop,
  ForwardType,
  TrustLevel,
} from "./analysis.ts";
export {
  analyzeHeaders,
  parseAuthResults,
  ANALYSIS_HEADER_NAMES,
} from "./analysis.ts";
