import type {
  Exchange,
  Pipeline,
  RouteView,
  Source,
  Step,
  Token,
} from "../contracts/index.ts";
import type { Kernel } from "../kernel/index.ts";

let counter = 0;

/**
 * Minimal exchange. Core owns identity, body, headers and the extension
 * lookup, and knows nothing about what any extension holds.
 */
class SpikeExchange implements Exchange {
  readonly id = `ex-${++counter}`;
  readonly headers: Record<string, unknown> = {};
  readonly #ext = new Map<symbol, unknown>();

  constructor(
    readonly routeId: string,
    public body: unknown,
  ) {}

  use<T>(token: Token<T>): T | undefined {
    return this.#ext.get(token.key) as T | undefined;
  }

  attach(key: symbol, value: unknown): void {
    this.#ext.set(key, value);
  }
}

export interface RouteSpec {
  readonly id: string;
  readonly source: Source;
  /** Step names resolved from contributions, with their call-site args. */
  readonly steps: ReadonlyArray<readonly [name: string, ...args: unknown[]]>;
  readonly options?: Readonly<Record<string, unknown>>;
}

export class UnknownStepError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      `No plugin contributes the step "${name}". Contributed steps: ${known.join(", ") || "none"}.`,
    );
    this.name = "UnknownStepError";
  }
}

/**
 * Assembles and runs one route. Owns ordering and the halt contract and
 * owns neither a wrapper nor a step.
 */
export class Runtime {
  constructor(private readonly kernel: Kernel) {}

  assemble(spec: RouteSpec): Pipeline {
    const steps: Step[] = spec.steps.map(([name, ...args]) => {
      const contribution = this.kernel.interventions.step(name);
      if (contribution === undefined) {
        throw new UnknownStepError(name, this.kernel.interventions.stepNames());
      }
      return contribution.factory(...args);
    });

    const view: RouteView = {
      id: spec.id,
      stepLabels: steps.map((s) => s.label),
      optionsFor: (wrapperId) => spec.options?.[wrapperId],
    };

    const inner: Pipeline = async (exchange) => {
      for (const handler of this.kernel.interventions.handlers("entry")) {
        await handler.handle(exchange);
      }
      for (const step of steps) {
        this.kernel.events.emit("step:started", {
          route: spec.id,
          step: step.label,
        });
        await step.run(exchange);
      }
      for (const handler of this.kernel.interventions.handlers("complete")) {
        await handler.handle(exchange);
      }
    };

    return this.kernel.interventions.compose(inner, view);
  }

  /** Feeds one body through an assembled route and returns the exchange. */
  async deliver(spec: RouteSpec, body: unknown): Promise<Exchange> {
    const pipeline = this.assemble(spec);
    const exchange = new SpikeExchange(spec.id, body);
    for (const ext of this.kernel.interventions.exchangeExtensions()) {
      exchange.attach(ext.factory.token.key, ext.factory.create(exchange));
    }
    this.kernel.events.emit("exchange:started", { id: exchange.id });
    try {
      await pipeline(exchange);
      this.kernel.events.emit("exchange:completed", { id: exchange.id });
    } catch (error) {
      for (const handler of this.kernel.interventions.handlers("error")) {
        await handler.handle(exchange, error);
      }
      this.kernel.events.emit("exchange:failed", { id: exchange.id });
      throw error;
    }
    return exchange;
  }
}
