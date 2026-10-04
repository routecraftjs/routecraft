import { authenticate } from "../../auth/authenticate.ts";
import { isAuthentic, markAuthentic } from "../../auth/authentic.ts";
import { isRestored, markRestored } from "../../auth/restored.ts";
import { principalOf } from "../../exchange.ts";
import {
  AUTHORITY,
  setFallbackAuthority,
  type Authority,
} from "../../kernel/authority.ts";
import { registerShippedPlugin } from "../../kernel/defaults.ts";
import { definePlugin } from "../../kernel/plugin.ts";

/**
 * The framework's authority: what fills `AUTHORITY` unless replaced.
 * Exported for a replacement that decorates it; code that needs an
 * authority reads its application's with `authorityOf`, so a replacement
 * decides every mint and every check.
 */
export const defaultAuthority: Authority = {
  mint: authenticate,
  brand: markAuthentic,
  isAuthentic,
  restore: markRestored,
  isRestored,
  read: principalOf,
};

/** The plugin that provides {@link AUTHORITY}, installed by default. */
export function principalsPlugin() {
  return definePlugin({
    id: "routecraft.principals",
    provides: [AUTHORITY],
    bind(c) {
      c.provide(AUTHORITY, defaultAuthority);
    },
  });
}

setFallbackAuthority(defaultAuthority);
registerShippedPlugin(principalsPlugin, { default: true });
