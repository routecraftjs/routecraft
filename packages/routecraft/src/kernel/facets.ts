import {
  DefaultExchange,
  getExchangeContext,
  type Exchange,
} from "../exchange.ts";
import { rcError } from "../error.ts";

/** Names this module put on the exchange prototype. */
const installed = new Set<string>();

/** Fields every exchange carries as its own, not on its prototype. */
const OWN_FIELDS: ReadonlySet<string> = new Set([
  "id",
  "headers",
  "body",
  "logger",
  "context",
]);

/**
 * Names the language reads off every object. A facet getter under `then`
 * would make every exchange a thenable: returning one from an async
 * function would call it, and on an exchange of an application without the
 * plugin that call is the `RC1111` refusal, surfacing as a rejection. One
 * under `toJSON` would be read by `JSON.stringify`, so logging or persisting
 * such an exchange would throw the same way.
 */
const PROTOCOL_NAMES: ReadonlySet<string> = new Set(["then", "toJSON"]);

/**
 * Whether a facet name is already something every exchange is: one of its
 * own fields or a member of its prototype.
 *
 * @internal
 */
export function isReservedFacet(namespace: string): boolean {
  if (installed.has(namespace)) return false;
  return (
    OWN_FIELDS.has(namespace) ||
    PROTOCOL_NAMES.has(namespace) ||
    namespace in DefaultExchange.prototype
  );
}

/**
 * Make `ex.<namespace>` readable on every exchange.
 *
 * The getter is shared by every application in the process and answers from
 * the exchange's own context. An exchange of an application that did not
 * install the plugin is refused with `RC1111`, the fault a step of an
 * uninstalled plugin gets, rather than reading another application's facet
 * or failing later as a TypeError on `undefined`.
 *
 * @throws RC1114 when the name is already a property every exchange has,
 *   or one the language reads off every object (`then`)
 * @internal
 */
export function installFacet(namespace: string): void {
  if (installed.has(namespace)) return;
  if (isReservedFacet(namespace)) {
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
