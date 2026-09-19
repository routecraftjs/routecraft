import type { Plugin } from "../contracts/index.ts";

/**
 * Observes only, and therefore needs nothing from core but the event bus.
 * This is the subsystem the register measures at zero core imports today,
 * and it is unchanged by the design.
 */
export function telemetry(sink: string[]): Plugin {
  return {
    id: "routecraft.telemetry",
    apply(ctx) {
      const reg = ctx.on("*", (payload) => {
        const { event } = payload as { event: string };
        sink.push(event);
      });
      ctx.onTeardown(() => reg.dispose());
    },
  };
}
