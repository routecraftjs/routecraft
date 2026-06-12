import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import { rcError } from "../../error.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { MailSourceAdapter } from "./source.ts";
import { MailFetchDestinationAdapter } from "./fetch-destination.ts";
import { MailSendDestinationAdapter } from "./send-destination.ts";
import { MailOperationDestinationAdapter } from "./operation-destination.ts";
import type {
  MailServerOptions,
  MailClientOptions,
  MailBody,
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
 * **Fetch Destination (for `.enrich()`):** Call with a folder string or server
 * options containing `folder`. The required `folder` key is what distinguishes
 * a fetch from a send (the object-form counterpart of the `mail('INBOX')`
 * shorthand, mirroring `http`'s `path` vs `url` split). Fetches messages from
 * IMAP and returns them as the enrichment result.
 *
 * **Send Destination (for `.to()`):** Call with no arguments or client options
 * (no `folder`). Sends email via SMTP using the exchange body as the payload.
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
 * // Fetch with options: `folder` is required and marks the fetch intent
 * craft()
 *   .from(cron('0 0/5 * * * *'))
 *   .enrich(mail({ folder: 'INBOX', unseen: true, limit: 10 }))
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
 */
export function mail(
  folder: string,
  options: MailServerOptions,
): Source<MailBody>;
export function mail(folder: string): Destination<unknown, MailFetchResult>;
export function mail(action: MailAction): Destination<unknown, void>;
export function mail(
  options: MailServerOptions & { folder: string },
): Destination<unknown, MailFetchResult>;
export function mail(
  options?: MailClientOptions,
): Destination<MailSendPayload, MailSendResult>;
export function mail(
  folderOrOptions?: string | MailServerOptions | MailClientOptions | MailAction,
  options?: MailServerOptions,
):
  | Source<MailBody>
  | Destination<unknown, MailFetchResult>
  | Destination<MailSendPayload, MailSendResult>
  | Destination<unknown, void> {
  const args = factoryArgs(folderOrOptions, options);

  // 2 args: string + object -> Source (matches direct(endpoint, options) pattern)
  if (typeof folderOrOptions === "string" && options !== undefined) {
    const adapter = new MailSourceAdapter(folderOrOptions, options);
    return tagAdapter(adapter, mail, args) as Source<MailBody>;
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

  // Action discriminator -> Operation Destination (checked before `folder`:
  // move/copy/append actions carry a folder of their own)
  if (folderOrOptions && "action" in folderOrOptions) {
    const adapter = new MailOperationDestinationAdapter(
      folderOrOptions as MailAction,
    );
    return tagAdapter(adapter, mail, args) as Destination<unknown, void>;
  }

  // `folder` is the required fetch discriminator (object-form counterpart of
  // the mail('INBOX') shorthand). Key presence declares the intent; an
  // undefined value still resolves through the context-level folder default.
  if (folderOrOptions && "folder" in folderOrOptions) {
    const adapter = new MailFetchDestinationAdapter(
      folderOrOptions as MailServerOptions,
    );
    return tagAdapter(adapter, mail, args) as Destination<
      unknown,
      MailFetchResult
    >;
  }

  // Fetch-only keys without `folder` mean the intent is ambiguous (fetch
  // options, send dispatch). Refuse rather than guess; only reachable from
  // untyped JS because the overloads reject this shape at compile time.
  if (folderOrOptions) {
    const fetchOnly = serverOnlyKeysIn(folderOrOptions);
    if (fetchOnly.length > 0) {
      throw rcError("RC5003", undefined, {
        message: `mail() options include IMAP fetch keys (${fetchOnly.join(", ")}) but no folder; cannot tell fetch intent from send intent`,
        suggestion:
          "Add folder (e.g. mail({ folder: 'INBOX', ... })) or use the mail('INBOX') shorthand to fetch; remove fetch-only keys to send via SMTP",
      });
    }
  }

  // No args or client-only keys -> Send Destination
  const adapter = new MailSendDestinationAdapter(
    folderOrOptions as MailClientOptions | undefined,
  );
  return tagAdapter(adapter, mail, args) as Destination<
    MailSendPayload,
    MailSendResult
  >;
}

/**
 * Option keys that exist on {@link MailServerOptions} but not on
 * {@link MailClientOptions}. Keys shared by both sides (`host`, `port`,
 * `secure`, `auth`, `account`, `from`) carry no intent and are excluded
 * by the `Exclude<>` automatically.
 */
type ServerOnlyKey = Exclude<keyof MailServerOptions, keyof MailClientOptions>;

/**
 * Exhaustive map of server-only keys, used by {@link serverOnlyKeysIn} to
 * detect fetch intent on options that lack the `folder` discriminator.
 * `Record<ServerOnlyKey, true>` makes the list exhaustive by construction:
 * adding a field to MailServerOptions that is absent from MailClientOptions
 * without listing it here is a compile error, so the runtime guard cannot
 * drift from the option types. (`folder` itself never reaches the guard;
 * it dispatches to the fetch destination earlier.)
 */
const SERVER_ONLY_KEYS: Record<ServerOnlyKey, true> = {
  folder: true,
  markSeen: true,
  since: true,
  unseen: true,
  to: true,
  subject: true,
  body: true,
  header: true,
  limit: true,
  description: true,
  keywords: true,
  pollIntervalMs: true,
  includeHeaders: true,
  verify: true,
  onParseError: true,
  reconnect: true,
};

/**
 * List the server-only (IMAP fetch) keys present on an options object,
 * for the ambiguity guard's error message.
 */
function serverOnlyKeysIn(opts: object): string[] {
  return Object.keys(SERVER_ONLY_KEYS).filter((key) => key in opts);
}

// Re-export types for public API
export type {
  MailAuth,
  MailReconnectOptions,
  MailServerOptions,
  MailClientOptions,
  MailOptions,
  MailBody,
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

// Re-export the `routecraft.mail.*` header key object so consumers reading
// envelope metadata off the source exchange get named constants and type-safe
// autocomplete (the keys are also declaration-merged into `RoutecraftHeaders`).
export { MailHeaders } from "./shared.ts";

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
