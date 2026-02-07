import type { Rule } from "eslint";
import requireNamedRouteRule from "./rules/require-named-route.ts";
import batchBeforeFromRule from "./rules/batch-before-from.ts";
import toolSourceOptionsRule from "./rules/tool-source-options.ts";
import singleToPerRouteRule from "./rules/single-to-per-route.ts";

export const rules: Record<string, Rule.RuleModule> = {
  "require-named-route": requireNamedRouteRule,
  "batch-before-from": batchBeforeFromRule,
  "tool-source-options": toolSourceOptionsRule,
  "single-to-per-route": singleToPerRouteRule,
};

export const configs = {
  all: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
      "@routecraft/routecraft/batch-before-from": "error",
      "@routecraft/routecraft/tool-source-options": "error",
      "@routecraft/routecraft/single-to-per-route": "warn",
    },
  },
  recommended: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
      "@routecraft/routecraft/batch-before-from": "warn",
      "@routecraft/routecraft/tool-source-options": "error",
      "@routecraft/routecraft/single-to-per-route": "warn",
    },
  },
};

export default {
  rules,
  configs,
};
