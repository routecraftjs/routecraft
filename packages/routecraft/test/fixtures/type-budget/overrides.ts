import {
  definePlugin,
  defineProject,
  direct,
  step,
  type Plugin,
} from "../../../src/index.ts";

/**
 * Two plugins the application does not install: a brought plugin whose id
 * the application lists itself, and the default auth plugin displaced by a
 * listed plugin of its id beside a service typed as the plain `Plugin`.
 */

const bundled = definePlugin({
  id: "budget.feature",
  steps: { obsolete: () => step<number, number>((ex) => ex.body) },
});
const bundle = definePlugin({ id: "budget.bundle", installs: [bundled] });
const replacement = definePlugin({
  id: "budget.feature",
  steps: { current: () => step<number, number>((ex) => ex.body) },
});
const replaced = defineProject({ plugins: [bundle, replacement] });

export const current = replaced
  .craft()
  .id("current")
  .from<number>(direct())
  .current();

export const obsolete = replaced
  .craft()
  .id("obsolete")
  .from<number>(direct())
  .obsolete();

const service: Plugin = { id: "budget.service", bind() {} };
const ownAuth = definePlugin({ id: "routecraft.auth" });
const displaced = defineProject({ plugins: [ownAuth, service] });

export const authenticated = displaced
  .craft()
  .id("authenticated")
  .from<number>(direct())
  .authenticate(() => undefined);
