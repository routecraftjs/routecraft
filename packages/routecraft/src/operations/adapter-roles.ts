import { rcError, type RoutecraftError } from "../error.ts";
import type { Destination } from "./to.ts";
import type { Enricher } from "./enrich.ts";

/**
 * Structural checks for the adapter role slots, shared by the steps that
 * resolve them (`.to()`, `.tap()`, `.enrich()`) so send-wins resolution has
 * exactly one definition. Leaf module on purpose: it imports only types, so
 * every operation module can depend on it without cycles.
 */

/** Structural check for the send slot. @internal */
export function hasSend<T>(adapter: object): adapter is Destination<T> {
  return typeof (adapter as Destination<T>).send === "function";
}

/** Structural check for the fetch slot. @internal */
export function hasFetch<T, R>(adapter: object): adapter is Enricher<T, R> {
  return typeof (adapter as Enricher<T, R>).fetch === "function";
}

/**
 * RC5003 for a `.to()` / `.tap()` target that fills neither role slot.
 * `.enrich()` keeps its own fetch-only wording and does not use this.
 * @internal
 */
export function missingSlotError(op: "`.to()`" | "`.tap()`"): RoutecraftError {
  return rcError("RC5003", undefined, {
    message: `${op} target implements neither \`send\` nor \`fetch\``,
    suggestion:
      "Pass a Destination (send), an Enricher (fetch), or a function form",
  });
}
