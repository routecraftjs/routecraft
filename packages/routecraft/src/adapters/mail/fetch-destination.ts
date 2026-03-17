import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import type { MergedOptions } from "../../context.ts";
import { rcError } from "../../error.ts";
import type {
  MailFetchResult,
  MailOptionsMerged,
  MailServerOptions,
} from "./types.ts";
import {
  getMergedImapOptions,
  createImapClient,
  fetchMessages,
} from "./shared.ts";

/**
 * Destination adapter that fetches email messages from IMAP.
 * Designed for use with `.enrich()` to pull messages into the exchange body.
 *
 * @example
 * ```typescript
 * craft()
 *   .from(cron('* /5 * * * *'))
 *   .enrich(mail('INBOX'))
 *   .to(processMessages())
 * ```
 *
 * @experimental
 */
export class MailFetchDestinationAdapter
  implements
    Destination<unknown, MailFetchResult>,
    MergedOptions<MailOptionsMerged>
{
  readonly adapterId = "routecraft.adapter.mail";
  public options: Partial<MailOptionsMerged>;

  constructor(options: Partial<MailServerOptions>) {
    this.options = options as Partial<MailOptionsMerged>;
  }

  mergedOptions(
    context: import("../../context.ts").CraftContext,
  ): MailOptionsMerged {
    return getMergedImapOptions(
      context,
      this.options as Partial<MailServerOptions>,
    ) as unknown as MailOptionsMerged;
  }

  async send(exchange: Exchange<unknown>): Promise<MailFetchResult> {
    const context = getExchangeContext(exchange);
    const resolved = context
      ? getMergedImapOptions(
          context,
          this.options as Partial<MailServerOptions>,
        )
      : (this.options as MailServerOptions);

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

    try {
      const folder = resolved.folder ?? "INBOX";
      await client.mailboxOpen(folder);
      const messages = await fetchMessages(client, resolved);
      return messages;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  /**
   * Extract metadata from fetch result for observability.
   *
   * @param result - The fetch result
   * @returns Metadata record
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const messages = result as MailFetchResult;
    return {
      folder: (this.options as Partial<MailServerOptions>).folder ?? "INBOX",
      messageCount: messages.length,
      uids: messages.map((m) => m.uid),
    };
  }
}
