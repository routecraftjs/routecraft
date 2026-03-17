import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import type { MergedOptions } from "../../context.ts";
import { rcError } from "../../error.ts";
import type {
  MailSendPayload,
  MailSendResult,
  MailOptionsMerged,
  MailClientOptions,
} from "./types.ts";
import { getMergedSmtpOptions, createSmtpTransport } from "./shared.ts";

/**
 * Destination adapter that sends email via SMTP.
 * Used with `.to(mail())` to send messages.
 *
 * The exchange body must conform to {@link MailSendPayload}.
 * Connection config and defaults (from, replyTo) come from merged options.
 *
 * @example
 * ```typescript
 * craft()
 *   .from(direct('outbound-email', {}))
 *   .to(mail())
 * ```
 *
 * @experimental
 */
export class MailSendDestinationAdapter
  implements
    Destination<MailSendPayload, MailSendResult>,
    MergedOptions<MailOptionsMerged>
{
  readonly adapterId = "routecraft.adapter.mail";
  public options: Partial<MailOptionsMerged>;

  constructor(options?: Partial<MailClientOptions>) {
    this.options = (options ?? {}) as Partial<MailOptionsMerged>;
  }

  mergedOptions(
    context: import("../../context.ts").CraftContext,
  ): MailOptionsMerged {
    return getMergedSmtpOptions(
      context,
      this.options as Partial<MailClientOptions>,
    ) as unknown as MailOptionsMerged;
  }

  async send(exchange: Exchange<MailSendPayload>): Promise<MailSendResult> {
    const context = getExchangeContext(exchange);
    const resolved = context
      ? getMergedSmtpOptions(
          context,
          this.options as Partial<MailClientOptions>,
        )
      : (this.options as MailClientOptions);

    const transporter = await createSmtpTransport(resolved);
    const payload = exchange.body;

    const mailOptions = {
      from: payload.from ?? resolved.from,
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
      cc: payload.cc,
      bcc: payload.bcc,
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
      const isAuthError =
        error instanceof Error &&
        (error.message.includes("auth") ||
          error.message.includes("credentials") ||
          error.message.includes("535"));

      throw rcError(
        isAuthError ? "RC5011" : "RC5010",
        error instanceof Error ? error : undefined,
        {
          message: `Mail adapter SMTP ${isAuthError ? "authentication" : "send"} failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      );
    }
  }

  /**
   * Extract metadata from send result for observability.
   *
   * @param result - The send result
   * @returns Metadata record
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
