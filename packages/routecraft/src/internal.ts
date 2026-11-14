/**
 * `@routecraft/routecraft/internal`: the names a sibling `@routecraft/*`
 * package needs and a third party must not build on.
 *
 * Three kinds of thing live here and nothing else: the hooks
 * `@routecraft/testing` uses to override an adapter, build helpers the
 * first-party packages share so they apply one rule rather than a copy of
 * it, and the two exchange accessors the agent tier still reads the
 * application through. The accessors are a debt, not a design: the files
 * allowed to import them are listed in the kernel-boundary test, and the
 * list only shrinks. The subpath carries no compatibility promise: a name may change or go
 * in any release, and an import from outside the `@routecraft` scope is
 * unsupported.
 *
 * This file is bundled on its own, apart from the main entry, so everything
 * it reaches exists twice at runtime. A module-level registry or cache
 * reached through here would be a second copy of the one the main entry
 * holds, and a class from here is not the main entry's class: identity
 * crosses the two bundles through `Symbol.for` and brands only, never
 * through `instanceof`. A capability an outsider needs gets a public export from the main
 * entry; it never arrives through this file.
 *
 * @internal
 * @packageDocumentation
 */
export {
  RC_ADAPTER_OVERRIDES,
  SOURCE_FIXTURE,
  isSourceFixture,
  type AdapterOverride,
  type AdapterSendCall,
  type AdapterSourceCall,
  type SendOverrideHandler,
  type SourceFixture,
  type SourceMessage,
  type SourceOverrideBehavior,
} from "./testing-hooks.ts";
export {
  describeSteps,
  type InferredNode,
  type StepsDescription,
} from "./kernel/continuation/identity.ts";
export { getExchangeContext, getExchangeRoute } from "./internal-accessors.ts";
export { clipText } from "./shared/text.ts";
export {
  RENAMED_TO_INPUT,
  rejectStaleOptions,
} from "./shared/stale-options.ts";
export { isDevelopmentRuntime } from "./shared/runtime-env.ts";
export {
  compareRuntimeVersion,
  parseRuntimeVersion,
  type RuntimeVersion,
} from "./shared/runtime-version.ts";
