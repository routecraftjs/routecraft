import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import type { MailFetchResult, MailServerOptions } from "./types.ts";
import {
  getClientManager,
  createImapClient,
  fetchMessages,
  throwMailConnectionError,
} from "./shared.ts";

/**
 * Destination adapter that fetches email messages from IMAP.
 * Designed for use with `.enrich()` to pull messages into the exchange body.
 *
 * When a MailClientManager is available (via context mail config), uses pooled
 * connections. Otherwise falls back to standalone connections.
 *
 * @example
 * ```typescript
 * craft()
 *   .from(cron('0 0/5 * * * *'))
 *   .enrich(mail('INBOX'))
 *   .to(processMessages())
 * ```
 *
 * @experimental
 */
export class MailFetchDestinationAdapter implements Destination<
  unknown,
  MailFetchResult
> {
  readonly adapterId = "routecraft.adapter.mail";
  private readonly adapterOptions: Partial<MailServerOptions>;

  constructor(options: Partial<MailServerOptions>) {
    this.adapterOptions = options;
  }

  async send(exchange: Exchange<unknown>): Promise<MailFetchResult> {
    const context = getExchangeContext(exchange);
    const manager = getClientManager(context);
    const account = this.adapterOptions.account;

    // Resolve options
    const resolved: MailServerOptions = manager
      ? manager.resolveImapOptions(account, this.adapterOptions)
      : (this.adapterOptions as MailServerOptions);

    const folder = resolved.folder ?? "INBOX";
    const hasConnectionOverride =
      this.adapterOptions.host !== undefined ||
      this.adapterOptions.port !== undefined ||
      this.adapterOptions.secure !== undefined ||
      this.adapterOptions.auth !== undefined;
    const usePool = !!manager && !hasConnectionOverride;

    let client: InstanceType<typeof import("imapflow").ImapFlow>;

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
      const messages = await fetchMessages(client, resolved, folder);
      return messages;
    } finally {
      if (usePool) {
        manager!.releaseImap(account, client);
      } else {
        await client.logout().catch(() => {});
      }
    }
  }

  /**
   * Extract metadata from fetch result for observability.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const messages = result as MailFetchResult;
    return {
      folder: this.adapterOptions.folder ?? "INBOX",
      messageCount: messages.length,
      uids: messages.map((m) => m.uid),
    };
  }
}
