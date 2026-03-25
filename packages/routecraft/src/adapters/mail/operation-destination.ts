import type { Destination } from "../../operations/to.ts";
import type { Exchange } from "../../exchange.ts";
import { getExchangeContext } from "../../exchange.ts";
import type { MailAction, MailSendPayload } from "./types.ts";
import {
  requireClientManager,
  resolveMailTarget,
  toArray,
  buildMimeMessage,
  throwMailConnectionError,
} from "./shared.ts";

/**
 * Destination adapter for IMAP operations on mail messages.
 * Handles move, copy, delete, flag, unflag, and append actions.
 *
 * Uses the MailClientManager from context for connection pooling.
 * Supports batch operations when exchange body is MailMessage[].
 *
 * @example
 * ```typescript
 * craft()
 *   .from(mail('INBOX', { markSeen: false }))
 *   .to(mail({ action: 'move', folder: 'Archive' }))
 *
 * craft()
 *   .from(direct('compose', {}))
 *   .to(mail({ action: 'append', folder: 'Drafts', flags: ['\\Draft'] }))
 * ```
 *
 * @experimental
 */
export class MailOperationDestinationAdapter implements Destination<
  unknown,
  void
> {
  readonly adapterId = "routecraft.adapter.mail";

  constructor(private readonly action: MailAction) {}

  async send(exchange: Exchange<unknown>): Promise<void> {
    const context = getExchangeContext(exchange);
    const manager = requireClientManager(context);
    const account = this.action.account;

    if (this.action.action === "append") {
      await this.handleAppend(exchange);
      return;
    }

    const { uids, folder } = resolveMailTarget(exchange, this.action.target);
    if (uids.length === 0) return;

    const client = await manager.acquireImap(account, folder);

    try {
      await client.mailboxOpen(folder);
      manager.trackMailbox(account, client, folder);
      const uidStr = uids.join(",");

      switch (this.action.action) {
        case "move":
          await client.messageMove(uidStr, this.action.folder, { uid: true });
          break;
        case "copy":
          await client.messageCopy(uidStr, this.action.folder, { uid: true });
          break;
        case "delete":
          await client.messageDelete(uidStr, { uid: true });
          break;
        case "flag":
          await client.messageFlagsAdd(uidStr, toArray(this.action.flags), {
            uid: true,
          });
          break;
        case "unflag":
          await client.messageFlagsRemove(uidStr, toArray(this.action.flags), {
            uid: true,
          });
          break;
      }
    } catch (error) {
      throwMailConnectionError(error, "IMAP");
    } finally {
      manager.releaseImap(account, client);
    }
  }

  private async handleAppend(exchange: Exchange<unknown>): Promise<void> {
    const context = getExchangeContext(exchange);
    const manager = requireClientManager(context);
    const action = this.action as Extract<MailAction, { action: "append" }>;
    const account = action.account;

    const smtpOpts = manager.resolveSmtpOptions(account);
    const raw = await buildMimeMessage(
      exchange.body as MailSendPayload,
      smtpOpts,
    );

    const client = await manager.acquireImap(account, action.folder);
    try {
      await client.append(
        action.folder,
        raw,
        toArray(action.flags ?? []),
        action.date,
      );
    } catch (error) {
      throwMailConnectionError(error, "IMAP");
    } finally {
      manager.releaseImap(account, client);
    }
  }

  /**
   * Extract metadata from the operation for observability.
   */
  getMetadata(): Record<string, unknown> {
    const { target, ...rest } = this.action;
    void target;
    return rest;
  }
}
