export { hasSurface, surface } from "./adapter.ts";
export { SurfaceDisconnected } from "./errors.ts";
export {
  AGENT_SURFACE_HEADER,
  surfaceRefOf,
  type AgentSurfaceKind,
  type AgentSurfaceRef,
} from "./header.ts";
export { surfacesPlugin } from "./plugin.ts";
export {
  registerSurface,
  registerTurn,
  surfaceFor,
  turnSurfaceOf,
} from "./registry.ts";
export { SURFACES, type SurfaceState } from "./state.ts";
export type {
  AgentSurfaceConnection,
  SurfaceMethod,
  SurfaceRequest,
  SurfaceRequestParams,
  SurfaceRequestResponses,
  SurfaceUpdate,
} from "./types.ts";
