import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import type {
  MailSendPayload,
  MailSendResult,
  MailClientOptions,
} from "./types.ts";
import {
  getClientManager,
  createSmtpTransport,
  throwMailConnectionError,
} from "./shared.ts";

/**
 * Destination adapter that sends email via SMTP.
 * Used with `.to(mail())` to send messages.
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
 *
 * @experimental
 */
export class MailSendDestinationAdapter implements Destination<
  MailSendPayload,
  MailSendResult
> {
  readonly adapterId = "routecraft.adapter.mail";
  private readonly adapterOptions: MailClientOptions;
  private cachedTransporter?: Awaited<ReturnType<typeof createSmtpTransport>>;
  private cachedTransporterKey?: string;

  constructor(options?: MailClientOptions) {
    this.adapterOptions = options ?? {};
  }

  async send(exchange: Exchange<MailSendPayload>): Promise<MailSendResult> {
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

    const payload = exchange.body;

    const mailOptions = {
      from: payload.from ?? resolved.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      cc: payload.cc ?? resolved.cc,
      bcc: payload.bcc ?? resolved.bcc,
      replyTo: payload.replyTo ?? resolved.replyTo,
      attachments: payload.attachments?.map((att) => ({
        filename: att.filename,
        content: att.content,
        contentType: att.contentType,
      })),
    };

    try {
      const info = await transporter.sendMail(mailOptions);

      return {
        messageId: info.messageId ?? "",
        accepted: Array.isArray(info.accepted) ? info.accepted.map(String) : [],
        rejected: Array.isArray(info.rejected) ? info.rejected.map(String) : [],
        response: info.response ?? "",
      };
    } catch (error) {
      throwMailConnectionError(error, "SMTP");
    }
  }

  /**
   * Extract metadata from send result for observability.
   */
  getMetadata(result: unknown): Record<string, unknown> {
    const sendResult = result as MailSendResult;
    return {
      messageId: sendResult.messageId,
      accepted: sendResult.accepted,
      rejected: sendResult.rejected,
    };
  }
}
