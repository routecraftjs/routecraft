import type { Rule } from "eslint";
import requireNamedRouteRule from "./rules/require-named-route.ts";
import batchBeforeFromRule from "./rules/batch-before-from.ts";
import singleToPerRouteRule from "./rules/single-to-per-route.ts";
import capabilityBoundariesRule from "./rules/capability-boundaries.ts";

export const rules: Record<string, Rule.RuleModule> = {
  "require-named-route": requireNamedRouteRule,
  "batch-before-from": batchBeforeFromRule,
  "single-to-per-route": singleToPerRouteRule,
  // Opt-in only: capability-boundaries encodes a specific repository layout
  // and is deliberately excluded from the recommended/all configs below.
  "capability-boundaries": capabilityBoundariesRule,
};

export const configs = {
  all: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
      "@routecraft/routecraft/batch-before-from": "error",
      "@routecraft/routecraft/single-to-per-route": "warn",
    },
  },
  recommended: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
      "@routecraft/routecraft/batch-before-from": "warn",
      "@routecraft/routecraft/single-to-per-route": "warn",
    },
  },
};

export default {
  rules,
  configs,
};
