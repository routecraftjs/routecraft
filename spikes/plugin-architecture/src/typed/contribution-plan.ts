import type {
  Plugin,
  PluginContext,
  StepContribution,
  WrapperContribution,
} from "../contracts/index.ts";
/** Definitions are available before boot; closures bind services only at apply.
 * Same mechanism for each kind. Preserve the generic definition alongside
 * the lifecycle plugin so a typed facade can be derived from installed values.
 */
export interface Definition<T> {
  readonly bind: (ctx: PluginContext) => T;
}
export function definePlan<
  const S extends Record<string, Definition<StepContribution>>,
>(
  id: string,
  plan: {
    readonly steps: S;
    readonly wrappers: readonly Definition<WrapperContribution>[];
  },
): Plugin & { readonly plan: typeof plan } {
  return {
    id,
    plan,
    apply(ctx) {
      for (const [name, def] of Object.entries(plan.steps)) {
        const step = def.bind(ctx);
        if (step.name !== name) throw Error(`Step name mismatch: ${name}`);
        ctx.contribute(step);
      }
      for (const def of plan.wrappers) ctx.contribute(def.bind(ctx));
    },
  };
}
