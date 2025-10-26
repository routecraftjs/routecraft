import type { Rule } from "eslint";
import requireNamedRouteRule from "./rules/require-named-route.ts";

export const rules: Record<string, Rule.RuleModule> = {
  "require-named-route": requireNamedRouteRule,
};

export const configs = {
  all: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
    },
  },
  recommended: {
    rules: {
      "@routecraft/routecraft/require-named-route": "error",
    },
  },
};

export default {
  rules,
  configs,
};
