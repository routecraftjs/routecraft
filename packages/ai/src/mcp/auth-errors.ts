/**
 * Auth error classification moved to core so the HTTP and MCP bearer paths
 * share one classifier (`packages/routecraft/src/auth/error-classification.ts`).
 * This module re-exports it so existing importers and tests are untouched.
 */
export {
  classifyRejectionReason,
  isExpiredTokenError,
  isInfrastructureError,
  type AuthRejectionReason,
} from "@routecraft/routecraft";
