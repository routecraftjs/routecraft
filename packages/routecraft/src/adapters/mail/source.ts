import type { CraftContext } from "../../context.ts";
import type { Source } from "../../operations/from.ts";
import type { Exchange, ExchangeHeaders } from "../../exchange.ts";
import type { MergedOptions } from "../../context.ts";
import { rcError } from "../../error.ts";
import type {
  MailMessage,
  MailOptionsMerged,
  MailServerOptions,
} from "./types.ts";
import {
  getMergedImapOptions,
  createImapClient,
  fetchMessages,
} from "./shared.ts";

/**
 * Source adapter that receives email messages from IMAP using IDLE or polling.
 * Used with `.from(mail(folder, options))` for push-based email processing.
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
export class MailSourceAdapter
  implements Source<MailMessage>, MergedOptions<MailOptionsMerged>
{
  readonly adapterId = "routecraft.adapter.mail";
  public options: Partial<MailOptionsMerged>;

  constructor(folder: string, options: Partial<MailServerOptions>) {
    this.options = { ...options, folder } as Partial<MailOptionsMerged>;
  }

  mergedOptions(context: CraftContext): MailOptionsMerged {
    return getMergedImapOptions(
      context,
      this.options as Partial<MailServerOptions>,
    ) as unknown as MailOptionsMerged;
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
    const resolved = getMergedImapOptions(
      context,
      this.options as Partial<MailServerOptions>,
    );

    const client = await createImapClient(resolved);

    try {
      await client.connect();
    } catch (error) {
      const isAuthError =
        error instanceof Error &&
        (error.message.includes("auth") ||
          error.message.includes("credentials") ||
          error.message.includes("login") ||
          error.message.includes("AUTHENTICATIONFAILED"));

      throw rcError(
        isAuthError ? "RC5011" : "RC5010",
        error instanceof Error ? error : undefined,
        {
          message: `Mail adapter IMAP ${isAuthError ? "authentication" : "connection"} failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      );
    }

    // Clean up on abort
    const onAbort = () => {
      client.logout().catch(() => {});
    };
    abortController.signal.addEventListener("abort", onAbort, { once: true });

    try {
      const folder = resolved.folder ?? "INBOX";
      await client.mailboxOpen(folder);

      if (onReady) {
        onReady();
      }

      if (resolved.pollIntervalMs) {
        // Poll mode
        await this.pollLoop(client, resolved, handler, abortController);
      } else {
        // IDLE mode
        await this.idleLoop(client, resolved, handler, abortController);
      }
    } finally {
      abortController.signal.removeEventListener("abort", onAbort);
      await client.logout().catch(() => {});
    }
  }

  private async pollLoop(
    client: Awaited<ReturnType<typeof createImapClient>>,
    options: MailServerOptions,
    handler: (
      message: MailMessage,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
  ): Promise<void> {
    while (!abortController.signal.aborted) {
      const messages = await fetchMessages(client, options);

      for (const message of messages) {
        if (abortController.signal.aborted) break;
        await handler(message);
      }

      if (abortController.signal.aborted) break;

      // Wait for the poll interval
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, options.pollIntervalMs);
        const cleanup = () => {
          clearTimeout(timeout);
          resolve();
        };
        abortController.signal.addEventListener("abort", cleanup, {
          once: true,
        });
      });
    }
  }

  private async idleLoop(
    client: Awaited<ReturnType<typeof createImapClient>>,
    options: MailServerOptions,
    handler: (
      message: MailMessage,
      headers?: ExchangeHeaders,
    ) => Promise<Exchange>,
    abortController: AbortController,
  ): Promise<void> {
    // Fetch existing messages first
    const existing = await fetchMessages(client, options);
    for (const message of existing) {
      if (abortController.signal.aborted) return;
      await handler(message);
    }

    // Listen for new messages via IDLE
    while (!abortController.signal.aborted) {
      try {
        // idle() resolves when new mail arrives or IDLE is interrupted
        await client.idle();
      } catch {
        if (abortController.signal.aborted) return;
        // Reconnect on IDLE failure
        break;
      }

      if (abortController.signal.aborted) return;

      const newMessages = await fetchMessages(client, options);
      for (const message of newMessages) {
        if (abortController.signal.aborted) return;
        await handler(message);
      }
    }
  }
}
