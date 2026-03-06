import { describe, test, expectTypeOf } from "vitest";
import { CraftContext } from "../src/context.ts";
import type { EventHandler, EventName, EventPayload } from "../src/types.ts";

describe("CraftContext event subscription type safety", () => {
  /**
   * @case Verifies exact event subscriptions preserve exact payload typing
   * @preconditions on() and once() are called with concrete EventName literals
   * @expectedResult Handlers receive the matching EventPayload type for the exact event
   */
  test("Exact events infer exact payload types", () => {
    const ctx = new CraftContext();

    ctx.on("context:stopping", (payload) => {
      expectTypeOf(payload).toEqualTypeOf<EventPayload<"context:stopping">>();
      expectTypeOf(payload.details.reason).toEqualTypeOf<unknown | undefined>();
    });

    ctx.once("route:started", (payload) => {
      expectTypeOf(payload).toEqualTypeOf<EventPayload<"route:started">>();
      expectTypeOf(payload.details.route.definition.id).toEqualTypeOf<string>();
    });
  });

  /**
   * @case Verifies wildcard subscriptions remain supported with general event payloads
   * @preconditions on() and once() are called with wildcard string patterns
   * @expectedResult Overloads accept wildcard strings and handlers use the general EventName payload shape
   */
  test("Wildcard patterns still accept general event handlers", () => {
    const ctx = new CraftContext();

    const onWildcard: (
      event: string,
      handler: EventHandler<EventName>,
    ) => () => void = ctx.on.bind(ctx);
    const onceWildcard: (
      event: string,
      handler: EventHandler<EventName>,
    ) => () => void = ctx.once.bind(ctx);

    expectTypeOf(onWildcard).toBeFunction();
    expectTypeOf(onceWildcard).toBeFunction();

    ctx.on("route:*", (payload) => {
      expectTypeOf(payload).toMatchTypeOf<EventPayload<EventName>>();
    });

    ctx.once("*", (payload) => {
      expectTypeOf(payload).toMatchTypeOf<EventPayload<EventName>>();
    });
  });

  /**
   * @case Verifies exact events reject mismatched handler payload types
   * @preconditions on() and once() are called with a concrete event name and an incompatible handler payload type
   * @expectedResult TypeScript reports an error for the mismatched handler payload
   */
  test("Exact events reject mismatched handler payloads", () => {
    const ctx = new CraftContext();
    const wrongHandler: EventHandler<"context:started"> = () => {};

    // @ts-expect-error exact event handlers must match the subscribed event payload
    ctx.on("context:stopping", wrongHandler);

    // @ts-expect-error exact event handlers must match the subscribed event payload
    ctx.once("context:stopping", wrongHandler);

    expectTypeOf(ctx).toBeObject();
  });
});
