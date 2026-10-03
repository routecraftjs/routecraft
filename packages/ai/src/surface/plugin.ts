import type { Plugin, PluginContext } from "@routecraft/routecraft";
import { bindSurfaceLifecycle } from "./cancellation.ts";
import { SURFACES, createSurfaceState } from "./state.ts";

/**
 * The surfaces runtime: provides {@link SURFACES}, the one state every
 * surface backend publishes into and every `surface()` call resolves
 * against, and binds the cancellation lifecycle that keeps it.
 *
 * Its own plugin rather than part of a backend or the agent runtime. The
 * agent runtime never reads a surface: the readers are `surface()` steps in
 * ordinary routes and the backend that publishes connections, so owning it
 * there would subscribe the lifecycle in every application with agents,
 * including the ones no editor can ever reach. And it is not the ACP
 * mount's, because a backend is one writer of the seam rather than the
 * seam: a second backend would otherwise collide with the first on the
 * port. Each backend brings this plugin along through `installs`, so an
 * application never lists it, gets it once however many backends it runs,
 * and has none of it when no backend is installed, which `surface()` reads
 * as no surface.
 *
 * @internal
 */
export function surfacesPlugin(): Plugin {
  return {
    id: "routecraft.ai.surfaces",
    provides: [SURFACES],
    bind(c: PluginContext) {
      const state = createSurfaceState(c.logger);
      c.provide(SURFACES, state);
      bindSurfaceLifecycle(state, c);
    },
  };
}
