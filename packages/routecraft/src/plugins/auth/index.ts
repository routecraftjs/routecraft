import { authorize } from "../../auth/authorize.ts";
import { definePlugin } from "../../kernel/plugin.ts";
import { registerDefaultPlugin } from "../../kernel/defaults.ts";
import {
  ENFORCEMENT,
  type EnforcementPositions,
} from "../../kernel/positions.ts";
import { ValidateStep } from "../../operations/validate.ts";

/**
 * The framework's gate: what fills the `authorize` position unless an
 * installed plugin replaces {@link ENFORCEMENT}.
 */
export const enforcementProvider: EnforcementPositions = {
  authorize: (options) => new ValidateStep(authorize(options)),
};

/** The plugin that provides {@link ENFORCEMENT}, installed by default. */
export function authPlugin() {
  return definePlugin({
    id: "routecraft.auth",
    provides: [ENFORCEMENT],
    bind(c) {
      c.provide(ENFORCEMENT, enforcementProvider);
    },
  });
}

registerDefaultPlugin("routecraft.auth", authPlugin);
