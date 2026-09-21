import { randomUUID } from "node:crypto";
import {
  type Family,
  type Plugin,
  type Chain,
  type Phase,
  type TypedExchange,
  type Cursor,
} from "./dsl.ts";
import {
  Fault,
  type Step,
  type StepContext,
  type StepOutcome,
  port,
  anchor,
} from "./contracts.ts";
export const RESILIENCE = port<true>("resilience@1");
export const RETRY = anchor(RESILIENCE, "retry"),
  TIMEOUT = anchor(RESILIENCE, "timeout"),
  CONCURRENCY = anchor(RESILIENCE, "concurrency"),
  BREAKER = anchor(RESILIENCE, "breaker");
type Operations<
  B,
  P extends readonly Plugin[],
  H extends object,
  S extends Phase,
> = {
  title(this: Cursor<B, P, H, "before">, title: string): Chain<B, P, H, S>;
  transform<R>(
    this: Cursor<B, P, H, "after">,
    fn: (body: B, ex: TypedExchange<B, P, H>) => R,
  ): Chain<Awaited<R>, P, H, "after">;
  delay(this: Cursor<B, P, H, "after">, ms: number): Chain<B, P, H, S>;
};
export interface OperationsFamily extends Family {
  readonly methods: Operations<
    this["Body"],
    this["Plugins"],
    this["Headers"],
    this["Phase"]
  >;
}
export function retryStep(step: Step, attempts: number): Step {
  return {
    ...step,
    version: `${step.version}/retry:${attempts}`,
    execute: async (ex, ctx) => {
      if (!Number.isInteger(attempts) || attempts < 1)
        throw new Fault(step.owner, "RETRY_OPTIONS", String(attempts));
      for (let i = 1; ; i++) {
        ctx.signal.throwIfAborted();
        const controller = new AbortController();
        const signal = AbortSignal.any([ctx.signal, controller.signal]);
        try {
          return await step.execute(ex, {
            ...ctx,
            signal,
            attemptId: randomUUID(),
            commit: (effect) => {
              signal.throwIfAborted();
              return ctx.commit(effect);
            },
          });
        } catch (e) {
          if (i >= attempts) throw e;
        } finally {
          controller.abort(new Fault(step.owner, "ATTEMPT_ENDED", step.id));
        }
      }
    },
  };
}
export function timeoutStep(step: Step, ms: number): Step {
  return {
    ...step,
    version: `${step.version}/timeout:${ms}`,
    execute: async (ex, ctx) => {
      const controller = new AbortController(),
        signal = AbortSignal.any([ctx.signal, controller.signal]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const child: StepContext = {
        ...ctx,
        signal,
        commit: (effect) => {
          signal.throwIfAborted();
          return ctx.commit(effect);
        },
      };
      const work = Promise.resolve().then(() => step.execute(ex, child));
      ctx.track(work);
      try {
        return await Promise.race([
          work,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              const f = new Fault(step.owner, "TIMEOUT", step.id);
              controller.abort(f);
              reject(f);
            }, ms);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort(new Fault(step.owner, "ATTEMPT_ENDED", step.id));
      }
    },
  };
}
export const operations: Plugin<OperationsFamily, Record<never, never>> = {
  id: "routecraft.operations",
  facets: {},
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ): Operations<B, P, H, S> {
    return {
      title(title) {
        if (cursor.phase !== "before")
          throw new Fault(cursor.owner, "DSL_PHASE", "title");
        return cursor.configure({ "operations.title": title });
      },
      transform: (fn) => cursor.map(fn),
      delay: (ms) =>
        cursor.wrap((step) => ({
          ...step,
          version: `${step.version}/delay:${ms}`,
          execute: async (ex, ctx) => {
            await new Promise((r) => setTimeout(r, ms));
            ctx.signal.throwIfAborted();
            return step.execute(ex, ctx);
          },
        })),
    };
  },
};
type ResilienceMethods<
  B,
  P extends readonly Plugin[],
  H extends object,
  S extends Phase,
> = {
  retry(attempts: number): Chain<B, P, H, S>;
  timeout(ms: number): Chain<B, P, H, S>;
};
export interface ResilienceFamily extends Family {
  readonly methods: ResilienceMethods<
    this["Body"],
    this["Plugins"],
    this["Headers"],
    this["Phase"]
  >;
}
export const resilience: Plugin<ResilienceFamily, Record<never, never>> = {
  id: "routecraft.resilience",
  facets: {},
  provides: [RESILIENCE],
  methods<B, P extends readonly Plugin[], H extends object, S extends Phase>(
    cursor: Cursor<B, P, H, S>,
  ): ResilienceMethods<B, P, H, S> {
    return {
      retry: (attempts) =>
        cursor.phase === "before"
          ? cursor.configure({ "resilience.retry": attempts })
          : cursor.wrap((step) => retryStep(step, attempts)),
      timeout: (ms) =>
        cursor.phase === "before"
          ? cursor.configure({ "resilience.timeout": ms })
          : cursor.wrap((step) => timeoutStep(step, ms)),
    };
  },
  bind(ctx) {
    ctx.provide(RESILIENCE, true);
    ctx.contribute({
      kind: "wrapper",
      id: "breaker",
      anchor: BREAKER,
      before: [{ anchor: RETRY, presence: "required" }],
      survival: {
        normal: true,
        resume: false,
        debounce: false,
        errorChannel: false,
      },
      bind: ({ route, setStatus }) => {
        let failures = 0;
        const limit = Number(route.options?.["resilience.breaker"] ?? Infinity);
        return async (next, run) => {
          if (failures >= limit)
            throw new Fault(ctx.id, "CIRCUIT_OPEN", route.id);
          try {
            return await next(run);
          } catch (e) {
            if (++failures >= limit)
              setStatus("circuit-broken", "failure threshold");
            throw e;
          }
        };
      },
    });
    ctx.contribute({
      kind: "wrapper",
      id: "retry",
      anchor: RETRY,
      before: [{ anchor: TIMEOUT, presence: "required" }],
      survival: {
        normal: true,
        resume: true,
        debounce: false,
        errorChannel: false,
      },
      bind:
        ({ route }) =>
        async (next, run) => {
          const attempts = Number(route.options?.["resilience.retry"] ?? 1);
          if (!Number.isInteger(attempts) || attempts < 1)
            throw new Fault(ctx.id, "RETRY_OPTIONS", String(attempts));
          for (let i = 1; ; i++) {
            run.signal.throwIfAborted();
            try {
              // Attempts share the exchange, as shipped: a retried step sees what the failed attempt left.
              return await next(run);
            } catch (e) {
              if (i >= attempts) throw e;
            }
          }
        },
    });
    ctx.contribute({
      kind: "wrapper",
      id: "timeout",
      anchor: TIMEOUT,
      before: [{ anchor: CONCURRENCY, presence: "required" }],
      survival: {
        normal: true,
        resume: true,
        debounce: false,
        errorChannel: false,
      },
      bind:
        ({ route }) =>
        async (next, run) => {
          const ms = route.options?.["resilience.timeout"];
          if (typeof ms !== "number") return next(run);
          const controller = new AbortController();
          const signal = AbortSignal.any([run.signal, controller.signal]);
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              next({ ...run, signal }),
              new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                  const f = new Fault(ctx.id, "TIMEOUT", route.id);
                  controller.abort(f);
                  reject(f);
                }, ms);
              }),
            ]);
          } finally {
            clearTimeout(timer);
            controller.abort();
          }
        },
    });
    ctx.contribute({
      kind: "wrapper",
      id: "concurrency",
      anchor: CONCURRENCY,
      survival: {
        normal: true,
        resume: true,
        debounce: false,
        errorChannel: false,
      },
      bind: ({ route }) => {
        let active = 0;
        return async (next, run) => {
          const max = Number(
            route.options?.["resilience.concurrency"] ?? Infinity,
          );
          if (active >= max) throw new Fault(ctx.id, "CONCURRENCY", route.id);
          active++;
          try {
            return await next(run);
          } finally {
            active--;
          }
        };
      },
    });
  },
};
export const manual = { owner: "application", subscribe: async () => () => {} };
export function instruction(
  owner: string,
  id: string,
  execute: Step["execute"],
  children: readonly Step[] = [],
): Step {
  return { owner, id, version: "1", execute, children, source: [execute] };
}
export function continueWith(ex: Parameters<Step["execute"]>[0]): StepOutcome {
  return { kind: "continue", exchange: ex };
}
