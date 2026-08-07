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
 * `routecraft.mail.sentMessageId` ({@link MailHeaders.SENT_MESSAGE_ID}),
 * the `routecraft.mail.accepted` / `routecraft.mail.rejected` recipient
 * lists, and the raw SMTP response on `routecraft.mail.response`. The
 * inbound `routecraft.mail.messageId` (set by the mail source) is left
 * untouched, so mail-to-mail routes keep their correlation id.
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
      // The sent message's id gets its OWN key so a mail-to-mail route
      // (`.from(mail(...))....to(mail())`) keeps the inbound
      // routecraft.mail.messageId intact for correlation.
      ctx?.setHeader(MailHeaders.SENT_MESSAGE_ID, info.messageId ?? "");
      ctx?.setHeader(
        MailHeaders.ACCEPTED,
        Array.isArray(info.accepted) ? info.accepted.map(String) : [],
      );
      ctx?.setHeader(
        MailHeaders.REJECTED,
        Array.isArray(info.rejected) ? info.rejected.map(String) : [],
      );
      ctx?.setHeader(MailHeaders.RESPONSE, info.response ?? "");
    } catch (error) {
      throwMailConnectionError(error, "SMTP");
    }
  }

  /**
   * Extract send metadata for observability: receives the receipt-header
   * record collected by the `.to()` step (send is void).
   */
  getSendMetadata(receiptHeaders: unknown): Record<string, unknown> {
    const receipts = (receiptHeaders ?? {}) as Record<string, unknown>;
    const meta: Record<string, unknown> = {};
    if (receipts[MailHeaders.SENT_MESSAGE_ID] !== undefined)
      meta["messageId"] = receipts[MailHeaders.SENT_MESSAGE_ID];
    if (receipts[MailHeaders.ACCEPTED] !== undefined)
      meta["accepted"] = receipts[MailHeaders.ACCEPTED];
    if (receipts[MailHeaders.REJECTED] !== undefined)
      meta["rejected"] = receipts[MailHeaders.REJECTED];
    return meta;
  }
}
