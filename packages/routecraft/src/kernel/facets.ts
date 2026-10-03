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
 * the exchange's own context. An exchange of an application that did not
 * install the plugin is refused with `RC1111`, the fault a step of an
 * uninstalled plugin gets, rather than reading another application's facet
 * or failing later as a TypeError on `undefined`.
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
      const context = getExchangeContext(this);
      const facet = context?.facetOf(namespace);
      if (facet) return facet(this);
      // An exchange with no application (a bare test exchange) reads
      // nothing; one whose application lacks the plugin is a definition error.
      if (!context) return undefined;
      throw rcError("RC1111", undefined, {
        message: `ex.${namespace} was read, but this application installs no plugin with that facet. Install the plugin, or build the route with the project's craft() so the read is a compile error instead.`,
      });
    },
  });
  installed.add(namespace);
}
