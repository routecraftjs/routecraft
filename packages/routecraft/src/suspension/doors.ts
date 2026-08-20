import type { CraftContext } from "../context.ts";
import type { AnswerPolicy } from "./types.ts";
import { policyConstrains } from "./answerer.ts";

/**
 * What the registered `.resume()` doors of a context collectively serve.
 *
 * @internal
 */
export interface DoorSurface {
  /** At least one door serves every channel (declares no `keys`). */
  readonly hasOpenDoor: boolean;
  /** Every channel some door declares. */
  readonly keys: ReadonlySet<string>;
  /** Route ids of doors that resolve no principal in their own pipeline. */
  readonly anonymous: readonly string[];
  /** Route ids of doors that declare no `keys`. */
  readonly keyless: readonly string[];
}

/**
 * Summarise the resume doors registered in a context.
 *
 * @internal
 */
export function doorSurface(context: CraftContext): DoorSurface {
  const keys = new Set<string>();
  const anonymous: string[] = [];
  const keyless: string[] = [];
  let hasOpenDoor = false;
  for (const route of context.getRoutes()) {
    for (const door of route.definition.resumeDoors ?? []) {
      if (!door.authenticates) anonymous.push(route.definition.id);
      if (door.keys === undefined) {
        hasOpenDoor = true;
        keyless.push(route.definition.id);
        continue;
      }
      for (const key of door.keys) keys.add(key);
    }
  }
  return { hasOpenDoor, keys, anonymous, keyless };
}

/**
 * Whether any registered door would accept a record parked on this channel.
 *
 * @internal
 */
export function servesKey(context: CraftContext, key: string): boolean {
  const surface = doorSurface(context);
  return surface.hasOpenDoor || surface.keys.has(key);
}

/**
 * Warn at startup about the two ways a suspension policy and the doors that
 * must honour it can be wired past each other.
 *
 * Both are silent in production otherwise. A keyed site with a keyless door
 * gets the segmentation it asked for ignored, and an answerer policy on an
 * ingress that resolves no principal fails closed at request time, days
 * after the park, on a link the approver was already sent. Neither is
 * expensive to notice here, where both halves are known.
 *
 * @internal
 */
export function auditSuspensionDoors(context: CraftContext): void {
  const sites = context.getRoutes().flatMap((route) =>
    (route.definition.suspendSteps ?? []).map((step) => ({
      routeId: route.definition.id,
      key: (step as { key?: string }).key,
      answer: (step as { answer?: AnswerPolicy }).answer,
      authorize: (step as { authorize?: unknown }).authorize,
    })),
  );
  if (sites.length === 0) return;

  const surface = doorSurface(context);

  const keyed = sites.filter((site) => site.key !== undefined);
  if (keyed.length > 0 && surface.keyless.length > 0) {
    context.logger.warn(
      {
        channels: [...new Set(keyed.map((site) => site.key))],
        doors: [...new Set(surface.keyless)],
      },
      "Suspend sites declare channel keys, but a .resume() door declares no keys and therefore serves every channel. Keys bound what one ingress can answer; a keyless door next to them removes that bound. Declare .resume({ keys }) on each door.",
    );
  }

  const policed = sites.filter(
    (site) => policyConstrains(site.answer) || site.authorize !== undefined,
  );
  if (policed.length > 0 && surface.anonymous.length > 0) {
    context.logger.warn(
      {
        sites: [...new Set(policed.map((site) => site.routeId))],
        doors: [...new Set(surface.anonymous)],
      },
      "Suspend sites declare who may answer them, but a .resume() route resolves no principal, so there is nothing to check that policy against and every answer through it will be refused with RC5056. Add .authenticate() (or a route-entry .authorize()) to the resume route.",
    );
  }
}
