/**
 * The direct channel behind an imported route.
 *
 * Registered in the direct store under the route's local endpoint, so
 * `direct('lab:hello')`, `forward('lab:hello', ...)`, `CraftClient.sendDirect`
 * and a `directTool` all reach it through the code paths they already use.
 * A send becomes `POST /ops/routes/{id}/exchanges` on the remote, and the
 * remote's outcome is mapped onto the in-process one: a completed exchange
 * is the body, a drop is `RC5031`, a park is the standard `Suspended`
 * acknowledgment, and the door's own refusals and failures become codes a
 * caller can tell apart.
 */

import type { CraftContext } from "../../context";
import { rcError } from "../../error";
import { DefaultExchange, type Exchange } from "../../exchange";
import type { DirectChannel } from "../../adapters/direct/types";
import { InMemoryDirectChannel } from "../../adapters/direct/shared";
import { createSuspended } from "../../suspension/suspended";
import { OpsClientError, type OpsHttpClient } from "../ops/client";

/** What a channel needs to know about the route it fronts. */
export interface RemoteTarget {
  ctx: CraftContext;
  /** The remote's name in `defineConfig({ remotes })`. */
  remote: string;
  /** The route id on the remote. */
  id: string;
  /** The local endpoint, for log lines and messages. */
  endpoint: string;
  client: OpsHttpClient;
  /** The remote named for a reader, without the credential. */
  describe(): string;
  /**
   * Called when the remote answers 404 for this route, which means the
   * inventory is stale: the route is gone, or the dispatch tier closed.
   * Awaited before the failure is thrown, so the next call sees the truth.
   */
  onMissing(): Promise<void>;
}

/**
 * A direct channel that dispatches to another instance.
 *
 * It also carries the shadow rule. A local route may subscribe onto an
 * endpoint this channel holds, or may already hold the endpoint when the
 * remote's inventory arrives; either way `local` is set and the local
 * route answers every send, with a warning naming the remote route that is
 * being shadowed, because a shadow is the promotion window and a caller
 * reading the logs should be able to see which of the two ran.
 */
export class RemoteDirectChannel implements DirectChannel<Exchange> {
  /** The local route's channel when one shadows this endpoint. */
  local: DirectChannel<Exchange> | undefined;

  constructor(
    private readonly target: RemoteTarget,
    local?: DirectChannel<Exchange>,
  ) {
    this.local = local;
  }

  async send(endpoint: string, exchange: Exchange): Promise<Exchange> {
    if (this.local !== undefined && !this.shadowLifted()) {
      const { ctx, remote, id, endpoint: local } = this.target;
      ctx.logger.warn(
        { endpoint: local, remote, remoteRouteId: id },
        `Direct endpoint "${local}" is answered by the local route; the route "${id}" of remote "${remote}" is shadowed and stays reachable as "${remote}:${id}"`,
      );
      return this.local.send(endpoint, exchange);
    }
    return this.dispatch(exchange);
  }

  /**
   * Whether the shadowing local route has stopped since the wrapper was
   * installed. A stopping route unsubscribes the channel it captured at
   * start, not this wrapper, so the wrapper reads that channel's own
   * subscription state rather than guessing from an error a route may
   * legitimately throw. Only the in-memory channel exposes it; under a
   * custom channel type the shadow holds until the inventory drops the
   * endpoint.
   */
  private shadowLifted(): boolean {
    if (
      !(this.local instanceof InMemoryDirectChannel) ||
      this.local.subscribed
    ) {
      return false;
    }
    const { ctx, remote, id, endpoint: local } = this.target;
    this.local = undefined;
    ctx.logger.info(
      { endpoint: local, remote, remoteRouteId: id },
      `The local route on "${local}" has stopped; the route "${id}" of remote "${remote}" answers it from now on`,
    );
    return true;
  }

  async subscribe(
    context: CraftContext,
    endpoint: string,
    handler: (message: Exchange) => Promise<Exchange>,
  ): Promise<void> {
    this.local ??= new InMemoryDirectChannel<Exchange>();
    await this.local.subscribe(context, endpoint, handler);
  }

  async unsubscribe(context: CraftContext, endpoint: string): Promise<void> {
    if (this.local === undefined) return;
    await this.local.unsubscribe(context, endpoint);
    // The local route left, so the remote answers again: a capability
    // demoted from the laptop still exists on the server.
    this.local = undefined;
  }

  private async dispatch(exchange: Exchange): Promise<Exchange> {
    const { ctx, remote, id, client } = this.target;
    let outcome: Awaited<ReturnType<OpsHttpClient["dispatch"]>>;
    try {
      outcome = await client.dispatch(id, exchange.body);
    } catch (error: unknown) {
      throw await this.translate(error);
    }
    switch (outcome.outcome) {
      case "completed":
        return new DefaultExchange(ctx, {
          body: outcome.body,
          headers: exchange.headers,
        });
      case "suspended": {
        // Re-branded so the local transports recognise the park the way they
        // recognise one of their own: the ops door answers 202, an agent
        // tool reports it, and a route with `.suspend()` downstream is not
        // fooled by a body that merely looks parked. Resume stays at the
        // remote's door, under the remote's policy.
        const { suspensionId, token, schema, expiresAt } = outcome.suspension;
        return new DefaultExchange(ctx, {
          body: createSuspended({
            suspensionId,
            token,
            ...(schema !== undefined ? { schema } : {}),
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          }),
          headers: exchange.headers,
        });
      }
      case "dropped":
        throw rcError("RC5031", undefined, {
          message: `Route "${id}" on remote "${remote}" dropped the exchange instead of completing it; there is no response body. ${outcome.message}`,
        });
      default:
        // The client only guarantees an object came back. Anything that is
        // not one of the three outcomes is an instance this side does not
        // understand, and it fails as a remote failure rather than as a
        // TypeError in whoever reads the result.
        throw rcError("RC5064", undefined, {
          message: `Dispatching route "${id}" on remote "${remote}" (${this.target.describe()}): the remote answered with an envelope this instance does not recognise (outcome ${JSON.stringify((outcome as { outcome?: unknown }).outcome)}). Check that the address is a routecraft ops server of a compatible version.`,
        });
    }
  }

  /**
   * Map the client's failure onto the codes a caller branches on.
   *
   * Every message names the remote and the route and never the bearer:
   * the client's own messages already hold that line, and this layer only
   * adds which remote it was.
   */
  private async translate(error: unknown): Promise<Error> {
    const { remote, id } = this.target;
    const where = `route "${id}" on remote "${remote}" (${this.target.describe()})`;
    if (!(error instanceof OpsClientError)) {
      return rcError("RC5062", error, {
        message: `Dispatching ${where} failed before an answer arrived: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
    switch (error.kind) {
      case "unreachable":
        return rcError("RC5062", error, {
          message: `Dispatching ${where}: ${error.message}`,
        });
      case "refused":
        return rcError("RC5063", error, {
          message: `Dispatching ${where}: ${error.message}`,
        });
      case "absent":
        await this.target.onMissing();
        return rcError("RC5004", error, {
          message: `Dispatching ${where}: the remote answered 404, so the route is gone from the remote or its dispatch tier is closed. The inventory has been refreshed; a route the remote no longer lists is no longer a direct endpoint here.`,
        });
      case "error":
        // No status means the request never completed: a timeout, where
        // the work may still be running on the remote. Not retryable, for
        // the reason the client's own message gives.
        if (error.status === undefined) {
          return rcError("RC5062", error, {
            message: `Dispatching ${where}: ${error.message}`,
            retryable: false,
          });
        }
        return rcError("RC5064", error, {
          message: `Dispatching ${where}: ${error.message}`,
        });
    }
  }
}
