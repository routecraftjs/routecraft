import type { FnOptions, RegisteredFn } from "../../src/index.ts";

/**
 * A resolved fn with its handler callable on `unknown`, the way the tool
 * bridge calls it once the input has passed `fn.input`. A test that drives a
 * resolved handler directly stands in for that bridge, so it takes on the
 * same obligation: pass input the schema accepts.
 */
export function callable(fn: RegisteredFn): FnOptions {
  return fn as FnOptions;
}
