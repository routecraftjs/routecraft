import type { Rule } from "eslint";
import requireNamedRouteRule from "./rules/require-named-route.ts";
import batchBeforeFromRule from "./rules/batch-before-from.ts";
import mcpServerOptionsRule from "./rules/mcp-server-options.ts";
import singleToPerRouteRule from "./rules/single-to-per-route.ts";

export const rules: Record<string, Rule.RuleModule> = {
  "require-named-route": requireNamedRouteRule,
  "batch-before-from": batchBeforeFromRule,
  "mcp-server-options": mcpServerOptionsRule,
  "single-to-per-route": singleToPerRouteRule,
};

export const configs = {
  all: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
      "@routecraft/routecraft/batch-before-from": "error",
      "@routecraft/routecraft/mcp-server-options": "error",
      "@routecraft/routecraft/single-to-per-route": "warn",
    },
  },
  recommended: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
      "@routecraft/routecraft/batch-before-from": "warn",
      "@routecraft/routecraft/mcp-server-options": "error",
      "@routecraft/routecraft/single-to-per-route": "warn",
    },
  },
};

export default {
  rules,
  configs,
};
