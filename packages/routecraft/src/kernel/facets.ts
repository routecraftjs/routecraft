import {
  DefaultExchange,
  getExchangeContext,
  type Exchange,
} from "../exchange.ts";
import { rcError } from "../error.ts";

/** Names this module put on the exchange prototype. */
const installed = new Set<string>();

/**
 * Make `ex.<namespace>` readable on every exchange.
 *
 * The getter is shared by every application in the process and answers from
 * the exchange's own context, so an exchange of an application that did not
 * install the plugin reads `undefined` rather than another application's
 * facet.
 *
 * @throws RC1114 when the name is already a property every exchange has
 * @internal
 */
export function installFacet(namespace: string): void {
  if (installed.has(namespace)) return;
  if (namespace in DefaultExchange.prototype) {
    throw rcError("RC1114", undefined, {
      message: `A plugin declares a facet named "${namespace}", which every exchange already has. Give the plugin an explicit namespace.`,
    });
  }
  Object.defineProperty(DefaultExchange.prototype, namespace, {
    configurable: true,
    enumerable: false,
    get(this: Exchange) {
      return getExchangeContext(this)?.facetOf(namespace)?.(this);
    },
  });
  installed.add(namespace);
}
