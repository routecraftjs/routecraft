import type { Adapter, Step } from "@routecraft/routecraft";
import {
  describeSteps,
  type InferredNode,
  type StepsDescription,
} from "@routecraft/routecraft/internal";

export type { InferredNode, StepsDescription };

/**
 * Describe the identity of a list of steps as the continuation digest and
 * the cache read it, for a plugin author's own tests.
 *
 * Two things are worth asserting about a step or an adapter you ship:
 * `inferred` is empty (the digest sees the whole definition, so `RC5071`
 * stays quiet on a route that defers), and `digest` moves when an option
 * that changes behaviour changes and holds when a secret rotates.
 *
 * @param steps - A route definition's `steps`, e.g. `route.build()[0].steps`
 *
 * @example
 * ```ts
 * const steps = (rate: number) =>
 *   project.craft().id("r").from(direct()).withTax(rate).build()[0]!.steps;
 * expect(describeIdentity(steps(0.1)).inferred).toEqual([]);
 * expect(describeIdentity(steps(0.1)).digest).not.toBe(
 *   describeIdentity(steps(0.2)).digest,
 * );
 * ```
 */
export function describeIdentity(
  steps: ReadonlyArray<Step<Adapter>>,
): StepsDescription {
  return describeSteps(steps);
}
