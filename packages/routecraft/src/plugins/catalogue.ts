import { catalogueOf, type StepCatalogue } from "../kernel/steps.ts";
import { authSteps, type AuthPlugin } from "./auth/index.ts";
import { deferralSteps } from "../deferral/steps.ts";
import type { DeferralPlugin } from "../deferral/config.ts";

/**
 * The plugins `@routecraft/routecraft` ships that add route methods or
 * facets. The root `craft()` is typed by all of them; a project's `craft()`
 * by the ones it installs.
 */
export type ShippedPlugins = AuthPlugin | DeferralPlugin;

/**
 * The plugins every application installs that add route methods or facets.
 * A project's `craft()` always has these.
 */
export type DefaultPlugins = AuthPlugin;

/**
 * The route methods of {@link ShippedPlugins}: what the root `craft()`
 * installs on every builder.
 *
 * @internal
 */
export const shippedCatalogue: StepCatalogue = catalogueOf([
  { id: "routecraft.auth", steps: authSteps },
  { id: "routecraft.deferral", steps: deferralSteps },
]);
