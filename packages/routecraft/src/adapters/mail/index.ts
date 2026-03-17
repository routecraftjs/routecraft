import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { MailSourceAdapter } from "./source.ts";
import { MailFetchDestinationAdapter } from "./fetch-destination.ts";
import { MailSendDestinationAdapter } from "./send-destination.ts";
import type {
  MailServerOptions,
  MailClientOptions,
  MailMessage,
  MailFetchResult,
  MailSendPayload,
  MailSendResult,
} from "./types.ts";

/**
 * Creates a mail adapter for reading email via IMAP or sending via SMTP.
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
 * @example
 * ```typescript
 * // Fetch mail via .enrich() (primary pattern)
 * craft()
 *   .from(cron('* /5 * * * *'))
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
 *   .from(direct('outbound', {}))
 *   .to(mail())
 * ```
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
export function mail(
  options?: Partial<MailClientOptions>,
): Destination<MailSendPayload, MailSendResult>;
export function mail(
  folderOrOptions?:
    | string
    | Partial<MailServerOptions>
    | Partial<MailClientOptions>,
  options?: Partial<MailServerOptions>,
):
  | Source<MailMessage>
  | Destination<unknown, MailFetchResult>
  | Destination<MailSendPayload, MailSendResult> {
  // 2 args: string + object -> Source (matches direct(endpoint, options) pattern)
  if (typeof folderOrOptions === "string" && options !== undefined) {
    return new MailSourceAdapter(
      folderOrOptions,
      options,
    ) as Source<MailMessage>;
  }

  // 1 arg string -> Fetch Destination (folder shorthand for .enrich())
  if (typeof folderOrOptions === "string") {
    return new MailFetchDestinationAdapter({
      folder: folderOrOptions,
    }) as Destination<unknown, MailFetchResult>;
  }

  // Object with server-specific keys -> Fetch Destination
  if (folderOrOptions && hasServerKeys(folderOrOptions)) {
    return new MailFetchDestinationAdapter(
      folderOrOptions as Partial<MailServerOptions>,
    ) as Destination<unknown, MailFetchResult>;
  }

  // No args or client-only keys -> Send Destination
  return new MailSendDestinationAdapter(
    folderOrOptions as Partial<MailClientOptions> | undefined,
  ) as Destination<MailSendPayload, MailSendResult>;
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
    "pollIntervalMs" in opts
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
} from "./types.ts";

// Re-export constants for registry access
export { ADAPTER_MAIL_OPTIONS } from "./shared.ts";
