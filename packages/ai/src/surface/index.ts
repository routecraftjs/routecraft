export { hasSurface, surface } from "./adapter.ts";
export { SurfaceDisconnected } from "./errors.ts";
export {
  AGENT_SURFACE_HEADER,
  surfaceRefOf,
  type AgentSurfaceKind,
  type AgentSurfaceRef,
} from "./header.ts";
export {
  AGENT_SURFACES,
  AGENT_SURFACE_TURNS,
  registerSurface,
  registerTurn,
  surfaceFor,
  turnSurfaceOf,
} from "./registry.ts";
export type {
  AgentSurfaceConnection,
  SurfaceMethod,
  SurfaceRequest,
  SurfaceRequestParams,
  SurfaceRequestResponses,
  SurfaceUpdate,
} from "./types.ts";
