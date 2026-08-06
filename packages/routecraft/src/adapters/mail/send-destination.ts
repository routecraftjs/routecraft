import type { Destination, SendContext } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import type { MailSendPayload, MailClientOptions } from "./types.ts";
import {
  getClientManager,
  createSmtpTransport,
  buildMessageOptions,
  throwMailConnectionError,
  MailHeaders,
} from "./shared.ts";

/**
 * Destination adapter that sends email via SMTP.
 * Used with `.to(mail())` to send messages.
 *
 * A true push-out: `send` is void and the body flows through unchanged. The
 * send receipt surfaces via headers on the continuing exchange:
 * `routecraft.mail.messageId` ({@link MailHeaders.MESSAGE_ID}), plus
 * `routecraft.mail.accepted` / `routecraft.mail.rejected` recipient lists.
 *
 * When a MailClientManager is available (via context mail config), uses the
 * shared SMTP transporter. Otherwise falls back to standalone transporter.
 *
 * The exchange body must conform to {@link MailSendPayload}.
 * Connection config and defaults (from, replyTo, cc, bcc) come from the
 * named account config, overridable per-operation.
 *
 * @example
 * ```typescript
 * craft()
 *   .id('outbound-email')
 *   .from(direct())
 *   .to(mail())
 * ```
 */
export class MailSendDestinationAdapter implements Destination<MailSendPayload> {
  readonly adapterId = "routecraft.adapter.mail";
  private readonly adapterOptions: MailClientOptions;
  private cachedTransporter?: Awaited<ReturnType<typeof createSmtpTransport>>;
  private cachedTransporterKey?: string;

  constructor(options?: MailClientOptions) {
    this.adapterOptions = options ?? {};
  }

  async send(
    exchange: Exchange<MailSendPayload>,
    ctx?: SendContext,
  ): Promise<void> {
    const context = getExchangeContext(exchange);
    const manager = getClientManager(context);
    const account = this.adapterOptions.account;

    // Resolve options
    const resolved: MailClientOptions = manager
      ? manager.resolveSmtpOptions(account, this.adapterOptions)
      : (this.adapterOptions as MailClientOptions);

    // Get transporter: pooled or standalone (with caching)
    let transporter: Awaited<ReturnType<typeof createSmtpTransport>>;
    const hasConnectionOverride =
      this.adapterOptions.host !== undefined ||
      this.adapterOptions.port !== undefined ||
      this.adapterOptions.secure !== undefined ||
      this.adapterOptions.auth !== undefined;
    const usePool = !!manager && !hasConnectionOverride;

    if (usePool) {
      transporter = await manager!.getSmtp(account);
    } else {
      const key = `${resolved.host}:${resolved.port}:${resolved.auth?.user}:${resolved.auth?.pass}`;
      if (!this.cachedTransporter || this.cachedTransporterKey !== key) {
        this.cachedTransporter = await createSmtpTransport(resolved);
        this.cachedTransporterKey = key;
      }
      transporter = this.cachedTransporter;
    }

    const mailOptions = buildMessageOptions(exchange.body, resolved);

    try {
      const info = await transporter.sendMail(mailOptions);

      // Receipt headers, not a body replacement: the body flows through
      // unchanged and downstream steps read the receipt off the headers.
      ctx?.setHeader(MailHeaders.MESSAGE_ID, info.messageId ?? "");
      ctx?.setHeader(
        MailHeaders.ACCEPTED,
        Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      );
      ctx?.setHeader(
        MailHeaders.REJECTED,
        Array.isArray(info.rejected) ? info.rejected.map(String) : [],
      );
    } catch (error) {
      throwMailConnectionError(error, "SMTP");
    }
  }

  /**
   * Extract metadata for observability. Send is void, so the hook receives
   * the receipt-header record collected by the `.to()` step.
   */
  getMetadata(receiptHeaders: unknown): Record<string, unknown> {
    const receipts = (receiptHeaders ?? {}) as Record<string, unknown>;
    return {
      messageId: receipts[MailHeaders.MESSAGE_ID],
      accepted: receipts[MailHeaders.ACCEPTED],
      rejected: receipts[MailHeaders.REJECTED],
    };
  }
}
