import type { CraftContext } from "../../context.ts";
import type { Source } from "../../operations/from.ts";
import type { Exchange, ExchangeHeaders } from "../../exchange.ts";
import { rcError } from "../../error.ts";
import type { MailMessage, MailServerOptions } from "./types.ts";
import type { MailClientManager } from "./client-manager.ts";
import {
  getClientManager,
  createImapClient,
  fetchMessages,
  markMessagesSeen,
  isMailAuthError,
  throwMailConnectionError,
  HEADER_MAIL_UID,
  HEADER_MAIL_FOLDER,
  MAIL_PARSE_ERRORS,
  type MailFetchLogger,
} from "./shared.ts";

type ImapClient = InstanceType<typeof import("imapflow").ImapFlow>;

/** Cap reconnect attempts so an unrecoverable server fault does not loop forever. */
const IDLE_RECONNECT_MAX_ATTEMPTS = 30;
/** Initial backoff between IDLE reconnect attempts. */
const IDLE_RECONNECT_BASE_MS = 1_000;
/** Cap for exponential backoff. */
const IDLE_RECONNECT_MAX_MS = 60_000;

/**
 * Source adapter that receives email messages from IMAP using IDLE or polling.
 * Used with `.from(mail(folder, options))` for push-based email processing.
 *
 * When a MailClientManager is available (via context mail config), uses pooled
 * connections. Otherwise falls back to standalone connections.
 *
 * Sets `routecraft.mail.uid` and `routecraft.mail.folder` headers on each
 * exchange so downstream operations can resolve the target message even after
 * body transforms.
 *
 * ## IDLE vs poll
 *
 * - Default mode is IDLE: the server pushes new-arrival notifications and the
 *   \Seen flag is the cross-cycle dedupe state. This is the right model when
 *   each message should be delivered to the handler exactly once.
 * - Set `pollIntervalMs` to run in poll mode. Poll mode is required whenever
 *   you opt out of the \Seen-flag model by setting `markSeen: false` or
 *   `unseen: false` (for example, to re-evaluate the inbox on every cycle and
 *   rely on a folder move as the done-signal). IDLE cannot bound re-delivery
 *   cycles, so combining it with those overrides would flood the handler on
 *   every inbound message.
 * - `limit` combined with IDLE is a latency trap: backlog beyond `limit` only
 *   drains when new mail arrives. A warning is logged at subscribe time.
 *
 * @example
 * ```typescript
 * // Default: IDLE, \Seen-based dedupe, exactly-once-ish delivery.
 * craft()
 *   .from(mail('INBOX', {}))
 *   .to(processMessage())
 *
 * // Re-evaluate the inbox on a cadence, move-to-archive as the done signal.
 * craft()
 *   .from(mail('INBOX', {
 *     markSeen: false,
 *     unseen: false,
 *     pollIntervalMs: 60_000,
 *   }))
 *   .filter(matchesCriteria)
 *   .to(mail({ action: 'move', folder: 'Archive' }))
 * ```
 *
 * @experimental
 */
export class MailSourceAdapter implements Source<MailMessage> {
  readonly adapterId = "routecraft.adapter.mail";
  private readonly adapterOptions: MailServerOptions;
  private readonly folder: string;

  constructor(folder: string, options: MailServerOptions) {
    this.folder = folder;
    this.adapterOptions = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (
      message: MailMessage,
      headers?: ExchangeHeaders,
      parse?: (raw: unknown) => unknown | Promise<unknown>,
      parseFailureMode?: "fail" | "abort" | "drop",
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const manager = getClientManager(context);
    const account = this.adapterOptions.account;

    const resolved: MailServerOptions = manager
      ? manager.resolveImapOptions(account, {
          ...this.adapterOptions,
          folder: this.folder,
        })
      : ({ ...this.adapterOptions, folder: this.folder } as MailServerOptions);

    const folder = resolved.folder ?? this.folder;
    const hasConnectionOverride =
      this.adapterOptions.host !== undefined ||
      this.adapterOptions.port !== undefined ||
      this.adapterOptions.secure !== undefined ||
      this.adapterOptions.auth !== undefined;
    const usePool = !!manager && !hasConnectionOverride;

    const logger: MailFetchLogger | undefined = context.logger
      ? {
          debug: (obj, msg) => context.logger.debug(obj, msg),
          warn: (obj, msg) => context.logger.warn(obj, msg),
        }
      : undefined;

    validateSourceOptions(resolved, logger);

    const markSeenEnabled = resolved.markSeen !== false;

    // Mutable ref so the idle loop can swap the client on reconnect while
    // the abort handler still releases whatever connection is current.
    const clientRef: { current: ImapClient | null } = { current: null };
    clientRef.current = await this.acquireAndOpen(
      manager,
      account,
      resolved,
      folder,
      usePool,
    );

    let released = false;
    const releaseClient = () => {
      if (released) return;
      released = true;
      const c = clientRef.current;
      if (!c) return;
      clientRef.current = null;
      if (usePool) {
        manager!.releaseImap(account, c);
      } else {
        c.logout().catch(() => {});
      }
    };

    const onAbort = () => releaseClient();
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    // The MIME parse failure mode is decided per-poll-cycle from
    // resolved options. `'fail'` (default) surfaces malformed messages
    // through the route's `.error()` handler; `'drop'` emits
    // `exchange:dropped` with `reason: "parse-failed"`; `'abort'` would
    // additionally re-throw out of the source loop.
    const parseFailureMode = resolved.onParseError ?? "fail";

    const handlerWithHeaders = (message: MailMessage) => {
      const headers: ExchangeHeaders = {
        [HEADER_MAIL_UID]: message.uid,
        [HEADER_MAIL_FOLDER]: message.folder,
      };
      // When the message had a MIME parse failure during fetch, surface
      // the captured error from the synthetic parse step so the route
      // observes it via the configured failure mode. See #187.
      const parseError = MAIL_PARSE_ERRORS.get(message);
      if (parseError) {
        MAIL_PARSE_ERRORS.delete(message);
        return handler(
          message,
          headers,
          () => {
            throw parseError;
          },
          parseFailureMode,
        );
      }
      return handler(message, headers);
    };

    try {
      if (onReady) onReady();

      if (resolved.pollIntervalMs) {
        await this.pollLoop(
          clientRef,
          resolved,
          folder,
          markSeenEnabled,
          handlerWithHeaders,
          abortController,
          logger,
        );
      } else {
        await this.idleLoop(
          clientRef,
          manager,
          account,
          resolved,
          folder,
          usePool,
          markSeenEnabled,
          handlerWithHeaders,
          abortController,
          logger,
        );
      }
    } finally {
      abortController.signal.removeEventListener("abort", onAbort);
      releaseClient();
    }
  }

  /** Acquire an IMAP client (pool or standalone) and open the mailbox. */
  private async acquireAndOpen(
    manager: MailClientManager | null,
    account: string | undefined,
    resolved: MailServerOptions,
    folder: string,
    usePool: boolean,
  ): Promise<ImapClient> {
    let client: ImapClient;
    if (usePool) {
      client = await manager!.acquireImap(account, folder);
    } else {
      client = await createImapClient(resolved);
      try {
        await client.connect();
      } catch (error) {
        try {
          client.close();
        } catch {
          // Ignore cleanup errors
        }
        throwMailConnectionError(error, "IMAP");
      }
    }
    try {
      await client.mailboxOpen(folder);
      if (usePool) manager!.trackMailbox(account, client, folder);
      return client;
    } catch (error) {
      if (usePool) {
        manager!.releaseImap(account, client);
      } else {
        await client.logout().catch(() => {});
      }
      throw error;
    }
  }

  private async pollLoop(
    clientRef: { current: ImapClient | null },
    options: MailServerOptions,
    folder: string,
    markSeenEnabled: boolean,
    handler: (message: MailMessage) => Promise<Exchange>,
    abortController: AbortController,
    logger?: MailFetchLogger,
  ): Promise<void> {
    const onParseError = options.onParseError ?? "fail";
    while (!abortController.signal.aborted) {
      const client = clientRef.current;
      if (!client) return;

      const messages = await fetchMessages(client, options, folder, logger);

      for (const message of messages) {
        if (abortController.signal.aborted) break;
        try {
          await handler(message);
          if (markSeenEnabled) {
            await markMessagesSeen(client, message.uid, logger);
          }
        } catch (err) {
          // A parse failure (RC5016) is permanent: retrying will hit the
          // same malformed MIME forever. Mark Seen so the message exits
          // the unread set, then re-evaluate based on the configured mode.
          if (isMailParseError(err)) {
            if (markSeenEnabled) {
              await markMessagesSeen(client, message.uid, logger);
            }
            // 'abort': rethrow so the source dies (`context:error` fires).
            // The per-message `exchange:failed` already fired from the
            // synthetic parse step.
            if (onParseError === "abort") throw err;
          }
          // 'fail' / 'drop' / non-parse failures: leave un-Seen for retry
          // (transient handler errors are expected to recover) unless we
          // already marked Seen above.
        }
      }

      if (abortController.signal.aborted) break;

      await waitWithAbort(options.pollIntervalMs ?? 0, abortController);
    }
  }

  private async idleLoop(
    clientRef: { current: ImapClient | null },
    manager: MailClientManager | null,
    account: string | undefined,
    options: MailServerOptions,
    folder: string,
    usePool: boolean,
    markSeenEnabled: boolean,
    handler: (message: MailMessage) => Promise<Exchange>,
    abortController: AbortController,
    logger?: MailFetchLogger,
  ): Promise<void> {
    // Drain whatever matches on startup, then transition into IDLE.
    await this.drainOnce(
      clientRef,
      options,
      folder,
      markSeenEnabled,
      handler,
      abortController,
      logger,
    );

    while (!abortController.signal.aborted) {
      const client = clientRef.current;
      if (!client) return;

      try {
        await client.idle();
      } catch (error) {
        if (abortController.signal.aborted) return;
        if (isMailAuthError(error)) {
          // Auth failures will not recover on reconnect; surface clearly and stop.
          throwMailConnectionError(error, "IMAP");
        }
        logger?.warn(
          {
            err: error instanceof Error ? error : new Error(String(error)),
            folder,
          },
          "mail adapter IDLE connection dropped; attempting reconnect",
        );
        await this.reconnectWithBackoff(
          clientRef,
          manager,
          account,
          options,
          folder,
          usePool,
          abortController,
          logger,
        );
        if (abortController.signal.aborted) return;
        continue;
      }

      if (abortController.signal.aborted) return;

      await this.drainOnce(
        clientRef,
        options,
        folder,
        markSeenEnabled,
        handler,
        abortController,
        logger,
      );
    }
  }

  /**
   * Fetch matching messages once and deliver each to the handler.
   * Marks each message Seen only after the handler resolves successfully,
   * so a handler failure leaves the message in the pool for retry.
   */
  private async drainOnce(
    clientRef: { current: ImapClient | null },
    options: MailServerOptions,
    folder: string,
    markSeenEnabled: boolean,
    handler: (message: MailMessage) => Promise<Exchange>,
    abortController: AbortController,
    logger?: MailFetchLogger,
  ): Promise<void> {
    const client = clientRef.current;
    if (!client) return;
    const onParseError = options.onParseError ?? "fail";

    const messages = await fetchMessages(client, options, folder, logger);
    for (const message of messages) {
      if (abortController.signal.aborted) return;
      try {
        await handler(message);
        if (markSeenEnabled) {
          await markMessagesSeen(client, message.uid, logger);
        }
      } catch (err) {
        // RC5016 is a permanent MIME parse failure; mark Seen so we don't
        // re-fetch the same malformed message forever, and rethrow when
        // the configured mode is `'abort'` so the source dies.
        if (isMailParseError(err)) {
          if (markSeenEnabled) {
            await markMessagesSeen(client, message.uid, logger);
          }
          if (onParseError === "abort") throw err;
        }
        // Non-parse handler errors are treated as transient and left
        // un-Seen for retry on the next cycle.
      }
    }
  }

  /**
   * Replace a dead IMAP client after an IDLE failure. Exponential backoff
   * with jitter, capped total attempts. Releases the current client on the
   * first attempt so the pool slot is freed for the new connection.
   */
  private async reconnectWithBackoff(
    clientRef: { current: ImapClient | null },
    manager: MailClientManager | null,
    account: string | undefined,
    options: MailServerOptions,
    folder: string,
    usePool: boolean,
    abortController: AbortController,
    logger?: MailFetchLogger,
  ): Promise<void> {
    const dead = clientRef.current;
    clientRef.current = null;
    if (dead) {
      if (usePool) {
        try {
          manager!.releaseImap(account, dead);
        } catch {
          // Ignore release errors on a client we know is broken
        }
      } else {
        await dead.logout().catch(() => {});
      }
    }

    for (let attempt = 1; attempt <= IDLE_RECONNECT_MAX_ATTEMPTS; attempt++) {
      if (abortController.signal.aborted) return;

      const base = Math.min(
        IDLE_RECONNECT_BASE_MS * 2 ** (attempt - 1),
        IDLE_RECONNECT_MAX_MS,
      );
      // Full jitter: pick uniformly in [0, base] so retries don't thunder.
      const delay = Math.floor(Math.random() * base);
      await waitWithAbort(delay, abortController);
      if (abortController.signal.aborted) return;

      try {
        const fresh = await this.acquireAndOpen(
          manager,
          account,
          options,
          folder,
          usePool,
        );
        clientRef.current = fresh;
        logger?.debug(
          { folder, attempt },
          "mail adapter IDLE reconnect succeeded",
        );
        return;
      } catch (error) {
        if (isMailAuthError(error)) {
          throwMailConnectionError(error, "IMAP");
        }
        logger?.warn(
          {
            err: error instanceof Error ? error : new Error(String(error)),
            folder,
            attempt,
          },
          "mail adapter IDLE reconnect attempt failed",
        );
      }
    }

    throw rcError("RC5010", undefined, {
      message: `Mail adapter IDLE reconnect gave up after ${IDLE_RECONNECT_MAX_ATTEMPTS} attempts on folder "${folder}".`,
    });
  }
}

/**
 * Subscribe-time validation.
 *
 * Re-evaluation mode (`markSeen: false` or `unseen: false`) requires an
 * explicit poll cadence: IDLE has no cycle boundary so it would re-fetch the
 * entire folder on every inbound message, flooding the handler.
 * `limit` without a poll interval is a latency trap but not dangerous, so it
 * only warns.
 */
function validateSourceOptions(
  options: MailServerOptions,
  logger?: MailFetchLogger,
): void {
  const disabledSeen = options.markSeen === false;
  const disabledUnseen = options.unseen === false;
  const hasPoll =
    typeof options.pollIntervalMs === "number" && options.pollIntervalMs > 0;

  if ((disabledSeen || disabledUnseen) && !hasPoll) {
    const which = disabledSeen ? "markSeen: false" : "unseen: false";
    throw rcError("RC5003", undefined, {
      message:
        `Mail source configured with ${which} requires pollIntervalMs. ` +
        "IDLE mode cannot bound re-delivery cycles and would refetch the " +
        "entire folder on every incoming message. Set pollIntervalMs to " +
        "poll on a cadence, or remove the markSeen/unseen override.",
    });
  }

  if (typeof options.limit === "number" && !hasPoll) {
    logger?.warn(
      { limit: options.limit, folder: options.folder },
      "mail source `limit` with IDLE: backlog beyond the limit will only " +
        "drain when new mail arrives. Use pollIntervalMs for predictable drain.",
    );
  }
}

/**
 * True if `err` is the framework's parse-error code (`RC5016`). Used by the
 * mail loops to distinguish permanent MIME parse failures (mark Seen, do not
 * retry) from transient pipeline failures (leave un-Seen, retry next cycle).
 * See #187.
 */
function isMailParseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { rc?: unknown }).rc === "RC5016"
  );
}

/**
 * Sleep for `ms` milliseconds, resolving early if the abort signal fires.
 * `ms <= 0` resolves immediately (still observing abort synchronously).
 */
function waitWithAbort(
  ms: number,
  abortController: AbortController,
): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      abortController.signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });
  });
}
