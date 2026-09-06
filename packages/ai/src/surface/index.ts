export { hasSurface, surface } from "./adapter.ts";
export {
  AGENT_SURFACE_HEADER,
  surfaceRefOf,
  type AgentSurfaceKind,
  type AgentSurfaceRef,
} from "./header.ts";
export { AGENT_SURFACES, registerSurface, surfaceFor } from "./registry.ts";
export type {
  AgentSurfaceConnection,
  SurfaceMethod,
  SurfaceRequestParams,
  SurfaceRequestResponses,
  SurfaceUpdate,
} from "./types.ts";
