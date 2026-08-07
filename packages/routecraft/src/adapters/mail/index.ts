import type { Source } from "../../operations/from.ts";
import type { Destination } from "../../operations/to.ts";
import type { Enricher } from "../../operations/enrich.ts";
import { rcError } from "../../error.ts";
import { tagAdapter, factoryArgs } from "../shared/factory-tag.ts";
import { withAdapterIdentity } from "../shared/role-facade.ts";
import { MailSourceAdapter } from "./source.ts";
import { MailEnricherAdapter } from "./enricher.ts";
import { MailSendDestinationAdapter } from "./send-destination.ts";
import { MailOperationDestinationAdapter } from "./operation-destination.ts";
import type {
  MailServerOptions,
  MailClientOptions,
  MailBody,
  MailFetchResult,
  MailSendPayload,
  MailAction,
} from "./types.ts";

/**
 * The read side of the mail adapter: one object carrying both read roles, so
 * the operation keyword picks between them instead of the call shape.
 * `.from()` subscribes (IDLE / polling), `.enrich()` fetches the folder as a
 * batch.
 */
export type MailFolderAdapter = Source<MailBody> &
  Enricher<unknown, MailFetchResult>;

/**
 * Build the read-side facade from the two role implementations, which keep
 * genuinely different machinery (IDLE / polling versus a batch fetch).
 *
 * Three things the facade must carry beyond the two slots:
 *
 * - `getMetadata`, forwarded from the enricher. A facade that lists only its
 *   role slots silently drops the hook, and a fetch-resolved step then
 *   attaches no metadata to its completion event with nothing to catch it.
 * - Both implementation constructors as override identities, so class-based
 *   `mockAdapter(MailEnricherAdapter, ...)` AND
 *   `mockAdapter(MailSourceAdapter, ...)` keep intercepting. Before the
 *   arity collapse those were two separate returned objects.
 * - A lazily built source, because subscribing is the rarer role and
 *   constructing it eagerly would allocate IDLE state for every
 *   `.enrich(mail(...))`. The identity set names the CLASS rather than an
 *   instance precisely so the delegate can stay unbuilt.
 */
function folderAdapter(
  options: MailServerOptions & { folder: string },
): MailFolderAdapter {
  const enricher = new MailEnricherAdapter(options);
  let source: MailSourceAdapter | undefined;
  return withAdapterIdentity(
    {
      adapterId: enricher.adapterId,
      subscribe: (sub) => {
        source ??= new MailSourceAdapter(options.folder, options);
        return source.subscribe(sub);
      },
      fetch: enricher.fetch,
      getMetadata: (result: unknown) => enricher.getMetadata(result),
    } satisfies MailFolderAdapter & {
      getMetadata(result: unknown): Record<string, unknown>;
    },
    enricher,
    MailSourceAdapter,
  );
}

/**
 * Creates a mail adapter for reading email via IMAP, sending via SMTP,
 * or performing IMAP operations (move, copy, delete, flag, unflag, append).
 *
 * **Reading a folder (`.from()` / `.enrich()`):** name a folder, either as
 * `mail(folder, options?)` or as `mail({ folder, ...options })`. Both carry
 * BOTH read roles and the operation keyword picks between them: `.from()`
 * subscribes (IMAP IDLE or polling, pushing new messages into the route) and
 * `.enrich()` fetches the folder as a batch. The `folder` key is what
 * distinguishes a read from a send (mirroring `http`'s `path` vs `url`
 * split); passing options does not change the role, so `mail('INBOX')` and
 * `mail('INBOX', { markSeen: true })` differ only in configuration.
 *
 * **Send Destination (for `.to()`):** Call with no arguments or client options
 * (no `folder`). Sends email via SMTP using the exchange body as the payload.
 * The send is void: the body flows through unchanged and the receipt
 * (`routecraft.mail.sentMessageId`, `.accepted`, `.rejected`, `.response`)
 * lands on headers. The sent id is deliberately its own key: an inbound
 * `routecraft.mail.messageId` set by the source is left untouched so a
 * mail-to-mail route keeps its correlation id.
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
 * @returns Source, Enricher, Send Destination, or Operation Destination depending on arguments
 */
export function mail(
  folder: string,
  options?: MailServerOptions,
): MailFolderAdapter;
export function mail(action: MailAction): Destination<unknown>;
export function mail(
  options: MailServerOptions & { folder: string },
): MailFolderAdapter;
export function mail(options?: MailClientOptions): Destination<MailSendPayload>;
export function mail(
  folderOrOptions?: string | MailServerOptions | MailClientOptions | MailAction,
  options?: MailServerOptions,
): MailFolderAdapter | Destination<MailSendPayload> | Destination<unknown> {
  const args = factoryArgs(folderOrOptions, options);

  // A folder string names a folder to READ; whether that read streams
  // (`.from()`) or batches (`.enrich()`) is the keyword's call, not the
  // argument count's. Options configure the read, they do not select it.
  if (typeof folderOrOptions === "string") {
    return tagAdapter(
      folderAdapter({ ...options, folder: folderOrOptions }),
      mail,
      args,
    );
  }

  // Action discriminator -> Operation Destination (checked before `folder`:
  // move/copy/append actions carry a folder of their own)
  if (folderOrOptions && "action" in folderOrOptions) {
    const adapter = new MailOperationDestinationAdapter(
      folderOrOptions as MailAction,
    );
    return tagAdapter(adapter, mail, args) as Destination<unknown>;
  }

  // `folder` is the required fetch discriminator (object-form counterpart of
  // the mail('INBOX') shorthand). Key presence declares the intent; an
  // undefined value still resolves through the context-level folder default.
  if (folderOrOptions && "folder" in folderOrOptions) {
    return tagAdapter(
      folderAdapter(folderOrOptions as MailServerOptions & { folder: string }),
      mail,
      args,
    );
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
  return tagAdapter(adapter, mail, args) as Destination<MailSendPayload>;
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
