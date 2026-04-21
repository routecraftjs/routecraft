import type { CraftContext } from "../../context.ts";
import type { Source } from "../../operations/from.ts";
import type { Exchange, ExchangeHeaders } from "../../exchange.ts";
import type { MailMessage, MailServerOptions } from "./types.ts";
import {
  getClientManager,
  createImapClient,
  fetchMessages,
  throwMailConnectionError,
  HEADER_MAIL_UID,
  HEADER_MAIL_FOLDER,
  type MailFetchLogger,
} from "./shared.ts";

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
 * @example
 * ```typescript
 * craft()
 *   .from(mail('INBOX', { markSeen: true }))
 *   .to(processMessage())
 * ```
 *
 * @experimental
 */
export class MailSourceAdapter implements Source<MailMessage> {
  readonly adapterId = "routecraft.adapter.mail";
  private readonly adapterOptions: Partial<MailServerOptions>;
  private readonly folder: string;

  constructor(folder: string, options: Partial<MailServerOptions>) {
    this.folder = folder;
    this.adapterOptions = options;
  }

  async subscribe(
    context: CraftContext,
    handler: (
      message: MailMessage,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
    onReady?: () => void,
  ): Promise<void> {
    const manager = getClientManager(context);
    const account = this.adapterOptions.account;

    // Resolve options
    const resolved: MailServerOptions = manager
      ? manager.resolveImapOptions(account, {
          ...this.adapterOptions,
          folder: this.folder,
        })
      : ({ ...this.adapterOptions, folder: this.folder } as MailServerOptions);

    const folder = resolved.folder ?? this.folder;

    // Acquire client: pooled or standalone
    let client: InstanceType<typeof import("imapflow").ImapFlow>;
    const hasConnectionOverride =
      this.adapterOptions.host !== undefined ||
      this.adapterOptions.port !== undefined ||
      this.adapterOptions.secure !== undefined ||
      this.adapterOptions.auth !== undefined;
    const usePool = !!manager && !hasConnectionOverride;

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

    // Guard against double-release of the IMAP client
    let released = false;
    const releaseClient = () => {
      if (released) return;
      released = true;
      if (usePool) {
        manager!.releaseImap(account, client);
      } else {
        client.logout().catch(() => {});
      }
    };

    const onAbort = () => releaseClient();
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    try {
      await client.mailboxOpen(folder);
      if (usePool) manager!.trackMailbox(account, client, folder);

      if (onReady) {
        onReady();
      }

      const handlerWithHeaders = (message: MailMessage) => {
        const headers: ExchangeHeaders = {
          [HEADER_MAIL_UID]: message.uid,
          [HEADER_MAIL_FOLDER]: message.folder,
        };
        return handler(message, headers);
      };

      const logger: MailFetchLogger | undefined = context.logger
        ? {
            debug: (obj, msg) => context.logger.debug(obj, msg),
            warn: (obj, msg) => context.logger.warn(obj, msg),
          }
        : undefined;

      if (resolved.pollIntervalMs) {
        await this.pollLoop(
          client,
          resolved,
          folder,
          handlerWithHeaders,
          abortController,
          logger,
        );
      } else {
        await this.idleLoop(
          client,
          resolved,
          folder,
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

  private async pollLoop(
    client: Awaited<ReturnType<typeof createImapClient>>,
    options: MailServerOptions,
    folder: string,
    handler: (message: MailMessage) => Promise<Exchange>,
    abortController: AbortController,
    logger?: MailFetchLogger,
  ): Promise<void> {
    const processedUids = new Set<number>();

    while (!abortController.signal.aborted) {
      const messages = await fetchMessages(client, options, folder, logger);

      for (const message of messages) {
        if (abortController.signal.aborted) break;
        if (processedUids.has(message.uid)) continue;
        try {
          await handler(message);
          processedUids.add(message.uid);
        } catch {
          // Exchange error already logged by the route pipeline.
          // UID is NOT marked processed so it will be retried on the next poll.
        }
      }

      if (abortController.signal.aborted) break;

      // Wait for the poll interval, cleaning up the abort listener on timeout
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          abortController.signal.removeEventListener("abort", onAbort);
          resolve();
        }, options.pollIntervalMs);
        const onAbort = () => {
          clearTimeout(timeout);
          resolve();
        };
        abortController.signal.addEventListener("abort", onAbort, {
          once: true,
        });
      });
    }
  }

  private async idleLoop(
    client: Awaited<ReturnType<typeof createImapClient>>,
    options: MailServerOptions,
    folder: string,
    handler: (message: MailMessage) => Promise<Exchange>,
    abortController: AbortController,
    logger?: MailFetchLogger,
  ): Promise<void> {
    const processedUids = new Set<number>();

    // Fetch existing messages first
    const existing = await fetchMessages(client, options, folder, logger);
    for (const message of existing) {
      if (abortController.signal.aborted) return;
      if (processedUids.has(message.uid)) continue;
      try {
        await handler(message);
        processedUids.add(message.uid);
      } catch {
        // Exchange error already logged by the route pipeline.
        // UID is NOT marked processed so it will be retried on the next idle cycle.
      }
    }

    // Listen for new messages via IDLE
    while (!abortController.signal.aborted) {
      try {
        await client.idle();
      } catch (error) {
        if (abortController.signal.aborted) return;
        throwMailConnectionError(error, "IMAP");
      }

      if (abortController.signal.aborted) return;

      const newMessages = await fetchMessages(client, options, folder, logger);
      for (const message of newMessages) {
        if (abortController.signal.aborted) return;
        if (processedUids.has(message.uid)) continue;
        try {
          await handler(message);
          processedUids.add(message.uid);
        } catch {
          // Exchange error already logged by the route pipeline.
          // UID is NOT marked processed so it will be retried on the next idle cycle.
        }
      }
    }
  }
}
