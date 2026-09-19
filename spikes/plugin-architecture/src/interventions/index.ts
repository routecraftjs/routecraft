import type {
  Contribution,
  ExchangeContribution,
  HandlerContribution,
  HandlerPoint,
  Pipeline,
  RouteView,
  StepContribution,
  WrapperContribution,
} from "../contracts/index.ts";
import { topoSort } from "../kernel/graph.ts";

export class DuplicateStepError extends Error {
  constructor(name: string, first: string, second: string) {
    super(
      `Two plugins contribute the step "${name}": "${first}" and "${second}". ` +
        `Decline one, or ask its author to rename.`,
    );
    this.name = "DuplicateStepError";
  }
}

/**
 * Participation seam. Holds contributions per point and freezes at start.
 *
 * Wrapper order is computed from declared constraints rather than compiled
 * into the executor, which is what lets a plugin insert into the middle of
 * the chain with no core change.
 */
export class InterventionRegistry {
  readonly #wrappers: WrapperContribution[] = [];
  readonly #steps = new Map<string, { own: string; c: StepContribution }>();
  readonly #handlers: HandlerContribution[] = [];
  readonly #exchange: ExchangeContribution[] = [];
  #frozen = false;

  add(contribution: Contribution, ownerId: string): void {
    if (this.#frozen) {
      throw new Error(`"${ownerId}" contributed after start`);
    }
    switch (contribution.kind) {
      case "wrapper":
        this.#wrappers.push(contribution);
        return;
      case "step": {
        const existing = this.#steps.get(contribution.name);
        if (existing !== undefined) {
          throw new DuplicateStepError(
            contribution.name,
            existing.own,
            ownerId,
          );
        }
        this.#steps.set(contribution.name, { own: ownerId, c: contribution });
        return;
      }
      case "handler":
        this.#handlers.push(contribution);
        return;
      case "exchange":
        this.#exchange.push(contribution);
        return;
    }
  }

  freeze(): void {
    this.#frozen = true;
  }

  /**
   * Outermost first. `before: ["x"]` means this wrapper sits outside `x`, so
   * `x` must be sorted after it; the graph edge therefore runs from the inner
   * wrapper to the outer one.
   */
  orderedWrappers(): readonly WrapperContribution[] {
    const nodes = this.#wrappers.map((w) => ({
      id: w.id,
      after: [
        ...(w.after ?? []),
        ...this.#wrappers
          .filter((other) => (other.before ?? []).includes(w.id))
          .map((other) => other.id),
      ],
      wrapper: w,
    }));
    return topoSort(nodes, { requireAll: false }).map((n) => n.wrapper);
  }

  /** Composes the ordered wrappers around a pipeline. */
  compose(inner: Pipeline, route: RouteView): Pipeline {
    const ordered = this.orderedWrappers();
    let pipeline = inner;
    for (let i = ordered.length - 1; i >= 0; i--) {
      pipeline = ordered[i]!.wrap(pipeline, route);
    }
    return pipeline;
  }

  step(name: string): StepContribution | undefined {
    return this.#steps.get(name)?.c;
  }

  stepNames(): readonly string[] {
    return [...this.#steps.keys()];
  }

  handlers(point: HandlerPoint): readonly HandlerContribution[] {
    return this.#handlers.filter((h) => h.point === point);
  }

  exchangeExtensions(): readonly ExchangeContribution[] {
    return this.#exchange;
  }
}
