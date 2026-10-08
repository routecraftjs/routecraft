import type { CraftContext } from "../context.ts";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { anySignal } from "../shared/abort.ts";
import {
  type Exchange,
  HeadersKeys,
  DefaultExchange,
  EXCHANGE_INTERNALS,
  clearResumeStepState,
  isDropped,
  isDeferredRun,
  OperationType,
  peekResumeStepState,
  setResumeStepState,
  getStartedAt,
  setStartedAt,
} from "../exchange.ts";
import {
  isRecovery,
  applyDropDirective,
  type RecoveryDefer,
} from "../recovery.ts";
import { deferExchange } from "../kernel/continuation/park.ts";
import { DeferralHeaders } from "../kernel/continuation/exchange-state.ts";
import { insufficientAuthorityOf } from "../authorization-refusal.ts";
import { parseDuration } from "../shared/duration.ts";
import { SPLIT_PARENT_STORE } from "../operations/split.ts";
import { rcError, RoutecraftError } from "../error.ts";
import { isRoutecraftError } from "../brand.ts";
import {
  type Adapter,
  type Step,
  type StepContext,
  type StepOutcome,
  getAdapterLabel,
} from "../types.ts";
import { buildInputValidationStep, buildParseStep } from "./synthetic-steps.ts";
import { applyOutputStage } from "./validation.ts";
import {
  CHAIN_SURVIVAL,
  type ExecutedDefinition,
  type DetachedKind,
  detachedDefinition,
} from "./chain-policy.ts";
import type { CompiledPositions } from "./positions.ts";
import type { Position } from "../kernel/positions.ts";
import type { ForwardFn, Route } from "../route.ts";
import {
  routeTags,
  runExchangeHooks,
  runsOn,
  type ErrorHook,
  type InstalledHook,
  type RunKind,
  type WrapperHook,
} from "../kernel/hooks.ts";

/**
 * Dependencies the pipeline executor needs from the owning route. Passed
 * explicitly so the step loop is a free function (moved verbatim from
 * DefaultRoute.runSteps; only `this.*` references became `deps.*`).
 */
export interface ExecutorDeps {
  routeId: string;
  context: CraftContext;
  /** The owning route, surfaced on error event payloads. */
  route: Route;
  /**
   * The chain positions this run executes under, plus its steps.
   *
   * Deliberately the same type the detached policy produces. Listing the
   * fields again here would be a second place to forget one, and the whole
   * point of deriving the policy from `RouteDefinition` is that there is
   * only one.
   */
  definition: ExecutedDefinition;
  /** Build a forward callable whose target inherits `caller`'s headers. */
  buildForward: (caller: Exchange) => ForwardFn;
  /**
   * When set and no `errorHandler` is defined, an unhandled failure of
   * the parent exchange THROWS out of `runPipeline` instead of firing
   * the default error path (`route:error` + `context:error` +
   * `route:exchange:failed`). Used by the route-scope resilience
   * segment steps, whose nested executor invocations must surface a
   * failed attempt to the wrapping retry / timeout logic rather than
   * emitting terminal failure events per attempt. Failed split
   * children keep the default per-child accounting.
   *
   * @internal
   */
  rethrowUnhandled?: boolean;
  /**
   * When set, the step loop stops scheduling further steps once the
   * signal aborts: the in-flight step settles, its outcome is
   * discarded, and the queue drains without running the remaining
   * steps. Used by the route-scope timeout segment so an expired
   * attempt cannot keep producing downstream side effects (e.g. a
   * `.to()` firing after the caller already received RC5011).
   *
   * @internal
   */
  abortSignal?: AbortSignal;
  /**
   * When set, route-scope `.concurrency()` queues this run for a slot
   * rather than refusing it. Resolved from `CHAIN_SURVIVAL.concurrency`,
   * which is where a kind declares whether it can absorb a refusal.
   *
   * The bound still holds: the semaphore is the route's own, shared with
   * the ingress leg, so this waits for the same slot rather than escaping
   * the limit.
   *
   * @internal
   */
  admissionMustWait?: boolean;
  /**
   * The plugin hooks this run places in the chain's slots. Set by the route
   * for the run that admits an exchange; a nested segment never carries the
   * admission slots, and a detached run carries only `perAttempt`.
   *
   * @internal
   */
  slots?: RouteSlots;
  /**
   * The kind of run this is, which decides the hooks that apply to it.
   * Absent on a normal run. Carried apart from {@link ExecutorDeps.slots}
   * because a run with no hooks of its own still reports its kind to the
   * `error` slot and to points.
   *
   * @internal
   */
  runKind?: RunKind;
  /**
   * The route's positions as its application's providers filled them. Which
   * of them this run executes is read from {@link ExecutorDeps.definition}:
   * a position absent there is skipped even when compiled here. A nested
   * segment carries none.
   *
   * @internal
   */
  positions?: CompiledPositions;
}

/**
 * The plugin hooks that apply to one route, ready for the executor: one
 * synthetic step per exchange slot that has any, and the `perAttempt`
 * wrappers.
 *
 * @internal
 */
export interface RouteSlots {
  readonly beforeAuth?: Step<Adapter>;
  readonly afterAuth?: Step<Adapter>;
  readonly admitted?: Step<Adapter>;
  readonly perAttempt: readonly InstalledHook[];
  readonly tags: readonly string[];
}

/**
 * The slots a detached run carries. A run that re-enters below admission
 * carries the `perAttempt` wrappers alone. An admission resume completes the
 * admission its first run never reached, so it also carries `afterAuth` and
 * `admitted` around the `authorize` it re-runs; `beforeAuth` already ran on
 * the first run. Absent when nothing hooks the route.
 *
 * @param deps - The route's own deps, which hold its compiled slot steps
 * @internal
 */
export function detachedSlots(
  deps: ExecutorDeps,
  kind?: DetachedKind,
): RouteSlots | undefined {
  const tags = routeTags(deps.route.definition);
  const perAttempt =
    deps.context.hooks?.forRoute("perAttempt", deps.routeId, tags) ?? [];
  const afterAuth = kind === "admission" ? deps.slots?.afterAuth : undefined;
  const admitted = kind === "admission" ? deps.slots?.admitted : undefined;
  if (perAttempt.length === 0 && !afterAuth && !admitted) return undefined;
  return {
    ...(afterAuth ? { afterAuth } : {}),
    ...(admitted ? { admitted } : {}),
    perAttempt,
    tags,
  };
}

/**
 * Run the step loop for an exchange.
 *
 * The chain is built in the order `.standards/pre-from-filter-chain.md`
 * fixes. A source-attached `parse` and `.input()` validation become a
 * synthetic step at the head of the chain (one step when both are present),
 * so an `RC5016` or `RC5065` flows through `.error()` like any other step
 * error. Surrounding positions (circuitBreaker, retry, timeout, concurrency)
 * wrap the tail from the inside out through nested executors; the error
 * position is this run's catch boundary, not a step.
 *
 * Admission is tracked as a fact (the last pre-admission step settled), not
 * inferred from a failed site lookup: a route-scope resilience segment
 * throws from a synthetic carrier with no site while being well past
 * admission, and treating that as an admission park would re-run every
 * completed step. Only a source parser is unreproducible on resume (it is a
 * per-message closure), so a park above a pending one is refused; a
 * standalone `.input()` step is rebuilt from `definition.discovery.input`.
 *
 * On a step error with no route handler, the context error chain runs
 * before the `rethrowUnhandled` escape: a context handler that parks the
 * exchange has resolved it, and surfacing that to a wrapping retry would
 * re-run work now waiting on a human. Once an outer abort has fired, a
 * cooperating step's failure is a consequence of the deadline already
 * reported (RC5011), so no `route:step:error` is emitted for it.
 *
 * A defer raised after the run was cancelled is refused with RC5054, so no
 * resume link outlives a run its caller already saw fail; an abort that
 * lands during the store write is resolved inside `deferExchange` before
 * the deferred event. The error position records the step that actually
 * failed, keyed by the error object, so an error-path park borrows the
 * inner step rather than the resilience segment the outer loop holds.
 *
 * @param exchange The initial exchange to process
 * @param startTime The timestamp when exchange processing started (for duration calculation)
 * @returns The last processed exchange
 * @private
 */
export async function runPipeline(
  deps: ExecutorDeps,
  exchange: Exchange,
  startTime: number,
): Promise<{
  exchange: Exchange;
  failed: boolean;
  dropped: boolean;
  /** The exchange deferred at a `.defer()`; execution one ends here. */
  deferred: boolean;
  error?: unknown;
}> {
  const internals = EXCHANGE_INTERNALS.get(exchange);
  const sourceParse = internals?.parse;
  const sourceValidate = internals?.applyValidation;
  const sourceFailureMode = internals?.parseFailureMode ?? "fail";
  if (internals && (sourceParse || sourceValidate)) {
    // An exchange forwarded back through the queue must not parse twice.
    delete internals.parse;
    delete internals.parseFailureMode;
    delete internals.applyValidation;
  }

  const positions = deps.positions;
  const def = deps.definition;
  let tail: Step<Adapter>[] = [
    ...(def.cache && positions?.cacheCheck ? [positions.cacheCheck] : []),
    ...def.steps,
    ...(def.cache && positions?.cacheStore ? [positions.cacheStore] : []),
  ];
  // Innermost so a slot is held per attempt and freed between retry
  // backoffs; stacked calls nest with the first declared outermost.
  if (def.concurrency && positions) {
    for (let i = positions.concurrency.length - 1; i >= 0; i--) {
      tail = [
        buildPositionStep(deps, tail, positions.concurrency[i]!, "concurrency"),
      ];
    }
  }
  if (def.timeout && positions?.timeout) {
    tail = [buildPositionStep(deps, tail, positions.timeout, "timeout")];
  }
  // The `perAttempt` slot sits inside retry and outside timeout: a wrapper
  // there surrounds every attempt, and a deadline applies inside it.
  const wrappers = (deps.slots?.perAttempt ?? []).filter((entry) =>
    runsOn(entry.hook as WrapperHook, deps.runKind ?? "normal"),
  );
  if (wrappers.length > 0) {
    tail = [buildPerAttemptSegmentStep(deps, tail, wrappers)];
  }
  if (def.retry && positions?.retry) {
    tail = [buildPositionStep(deps, tail, positions.retry, "retry")];
  }
  // Outside retry, so one exhausted run of attempts is one breaker failure.
  if (def.circuitBreaker && positions?.circuitBreaker) {
    tail = [
      buildPositionStep(deps, tail, positions.circuitBreaker, "circuitBreaker"),
    ];
  }
  // A gate rather than a wrapper: it admits once, so a retried attempt never
  // takes a second token.
  if (def.throttle && positions) {
    tail = [...positions.throttle, ...tail];
  }

  // Held by reference so the loop can tell when it has run.
  const admissionStep: Step<Adapter> | undefined = sourceParse
    ? buildParseStep(sourceParse, sourceFailureMode, sourceValidate)
    : sourceValidate
      ? buildInputValidationStep(sourceValidate)
      : undefined;
  let pendingSourceParse = sourceParse !== undefined;
  const slots = deps.slots;
  const preAdmission: Step<Adapter>[] = [
    ...(slots?.beforeAuth ? [slots.beforeAuth] : []),
    ...(def.authorize && positions ? positions.authorize : []),
    ...(slots?.afterAuth ? [slots.afterAuth] : []),
    ...(admissionStep ? [admissionStep] : []),
  ];
  const lastPreAdmission = preAdmission.at(-1);
  let admitted = lastPreAdmission === undefined;

  const initialSteps: Step<Adapter>[] = [
    ...preAdmission,
    ...(slots?.admitted ? [slots.admitted] : []),
    ...tail,
  ];

  const queue: { exchange: Exchange; steps: Step<Adapter>[] }[] = [
    { exchange: exchange, steps: initialSteps },
  ];

  let lastProcessedExchange: Exchange = exchange;
  let failed = false;
  let dropped = false;
  let stepError: unknown;
  // The parent exchange's lifecycle events are emitted by handler().
  const parentExchangeId = exchange.id;
  const seenChildExchanges = new Set<string>();
  const childStartTimes = new Map<string, number>();
  const failedChildExchanges = new Set<string>();

  // Snapshot existing split parent keys so cleanup only touches groups
  // created during THIS invocation, not groups from concurrent handlers.
  const parentMap = deps.context.getStore(SPLIT_PARENT_STORE) as
    Map<string, Exchange> | undefined;
  const preExistingGroups = parentMap
    ? new Set(parentMap.keys())
    : new Set<string>();

  // Snapshotted by `captureDownstream` so debounce can release a held
  // exchange through its continuation later.
  let currentRemaining: Step<Adapter>[] = [];

  // takePending only collects survivors, so a filter-dropped split child
  // never leaves aggregate waiting.
  const stepContext: StepContext = {
    // Handed to steps so cancellation-aware IO stops on expiry, not just
    // the scheduling loop.
    ...(deps.abortSignal ? { signal: deps.abortSignal } : {}),
    // A claimed continuation stays claimed inside the tail: a step-scope
    // bulkhead queues it the way the route-scope one does.
    ...(deps.admissionMustWait ? { mustWait: true as const } : {}),
    takePending(predicate: (candidate: Exchange) => boolean): Exchange[] {
      const taken: Exchange[] = [];
      for (let i = 0; i < queue.length;) {
        if (predicate(queue[i].exchange)) {
          taken.push(queue[i].exchange);
          queue.splice(i, 1);
        } else {
          i++;
        }
      }
      return taken;
    },
    async runPaths(runs): Promise<void> {
      // No rethrowUnhandled: a failing path fires its own error events and
      // cannot take the route down.
      await Promise.allSettled(
        runs.map((run) =>
          runPipeline(
            nestedDeps(deps, run.steps, { abortSignal: deps.abortSignal }),
            run.exchange,
            Date.now(),
          ),
        ),
      );
    },
    async runPath(run): Promise<{
      failed: boolean;
      dropped: boolean;
      error?: unknown;
      aborted?: boolean;
    }> {
      const result = await runPipeline(
        nestedDeps(deps, run.steps, { abortSignal: deps.abortSignal }),
        run.exchange,
        Date.now(),
      );
      return {
        failed: result.failed,
        dropped: result.dropped,
        // Without this, failover mistakes an abandoned attempt for a handled one.
        aborted: deps.abortSignal?.aborted === true,
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    },
    captureDownstream(): (
      exchange: Exchange,
    ) => Promise<{ failed: boolean; dropped: boolean }> {
      return makeDownstreamRunner(deps, currentRemaining);
    },
    async invoke(point: string, target: Exchange): Promise<Exchange> {
      const table = deps.context.hooks;
      if (!table?.hasPoint(point)) {
        throw rcError("RC1112", undefined, {
          message: `A step on route "${deps.routeId}" invoked the point "${point}", which no installed plugin declares.`,
        });
      }
      const tags = routeTags(deps.route.definition);
      return runExchangeHooks(
        table,
        table.forRoute(point, deps.routeId, tags),
        target,
        {
          routeId: deps.routeId,
          tags,
          slot: point,
          kind: deps.runKind ?? "normal",
        },
      );
    },
  };

  while (queue.length > 0) {
    // An abandoned run's result is already discarded; further steps would only add side effects.
    if (deps.abortSignal?.aborted) break;

    const popped = queue.shift()!;
    const { steps } = popped;
    let exchange = popped.exchange;
    if (steps.length === 0) {
      // Emit route:exchange:completed for child exchanges when their steps are done
      if (
        exchange.id !== parentExchangeId &&
        seenChildExchanges.has(exchange.id) &&
        !failedChildExchanges.has(exchange.id)
      ) {
        const childStart = childStartTimes.get(exchange.id) ?? startTime;
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        deps.context.emit("route:exchange:completed", {
          routeId: deps.routeId,
          exchangeId: exchange.id,
          correlationId,
          duration: Date.now() - childStart,
          exchange,
        });
      }
      lastProcessedExchange = exchange;
      continue;
    }

    // Emit route:exchange:started for child exchanges on first encounter
    if (
      exchange.id !== parentExchangeId &&
      !seenChildExchanges.has(exchange.id)
    ) {
      seenChildExchanges.add(exchange.id);
      const childNow = Date.now();
      childStartTimes.set(exchange.id, childNow);
      // On internals so aggregate can read child duration; they survive rewrap.
      setStartedAt(exchange, childNow);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      deps.context.emit("route:exchange:started", {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
      });
    }

    const [step, ...remainingSteps] = steps;
    currentRemaining = remainingSteps;

    // Prefer the DSL label (e.g., "log") over the raw OperationType (e.g., "tap")
    const stepLabel = step.label ?? step.operation;

    // Headers are frozen; rewrap keeps the id and internals.
    exchange = DefaultExchange.rewrap(exchange, {
      headers: { ...exchange.headers, [HeadersKeys.OPERATION]: stepLabel },
    });

    const adapterLabel = getAdapterLabel(step.adapter);
    exchange.logger.debug(
      {
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      },
      "Processing step",
    );

    const stepStartTime = Date.now();
    const correlationId = exchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;

    // Emit route:step:started event unless the step manages its own events
    if (!step.skipStepEvents) {
      deps.context.emit("route:step:started", {
        routeId: deps.routeId,
        exchangeId: exchange.id,
        correlationId,
        operation: stepLabel,
        ...(adapterLabel ? { adapter: adapterLabel } : {}),
      });
    }

    try {
      const outcome = await step.execute(exchange, stepContext);
      if (step === admissionStep) pendingSourceParse = false;
      if (step === lastPreAdmission) admitted = true;
      // Cleared only on a settled step, so a thrown attempt keeps the state for its retry.
      clearResumeStepState(exchange);

      switch (outcome?.kind) {
        case "continue":
          queue.push({ exchange: outcome.exchange, steps: remainingSteps });
          break;
        case "complete":
          queue.push({ exchange: outcome.exchange, steps: [] });
          break;
        case "branch":
          queue.push({
            exchange: outcome.exchange,
            steps: [...outcome.steps, ...remainingSteps],
          });
          break;
        case "fanOut":
          for (const child of outcome.exchanges) {
            queue.push({ exchange: child, steps: remainingSteps });
          }
          break;
        case "drop":
          break;
        case "defer": {
          if (!outcome.request) {
            throw rcError("RC5032", undefined, {
              message: `Step "${stepLabel}" returned a "defer" outcome without a defer request, so the engine cannot work out what to defer or what would resume.`,
            });
          }
          // A cancelled run must not leave a live resume link its caller saw fail.
          if (deps.abortSignal?.aborted) {
            throw rcError("RC5054", deps.abortSignal.reason, {
              message: `Step "${stepLabel}" raised a deferral after its run was cancelled; nothing was deferred.`,
            });
          }
          const deferred = await deferExchange(
            deps.context,
            outcome.exchange,
            outcome.request,
            deps.routeId,
            deps.abortSignal,
          );
          queue.push({ exchange: deferred, steps: [] });
          break;
        }
        default:
          // A kind this engine does not schedule (a plugin built against a
          // later release, a misspelling) must not read as success with the
          // tail silently skipped.
          throw rcError("RC5032", undefined, {
            message: `Step "${stepLabel}" returned an outcome of kind "${String(
              (outcome as { kind?: unknown } | null | undefined)?.kind,
            )}", which this engine cannot schedule. Return continue, complete, drop, branch, fanOut or defer.`,
          });
      }

      // Emit route:step:completed event unless the step manages its own events
      if (!step.skipStepEvents) {
        const stepDuration = Date.now() - stepStartTime;
        const correlationId = exchange.headers[
          HeadersKeys.CORRELATION_ID
        ] as string;
        deps.context.emit("route:step:completed", {
          routeId: deps.routeId,
          exchangeId: exchange.id,
          correlationId,
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          duration: stepDuration,
          ...("metadata" in outcome && outcome.metadata
            ? { metadata: outcome.metadata }
            : {}),
        });
      }
    } catch (error) {
      const err = processError(error);
      const correlationId = exchange.headers[
        HeadersKeys.CORRELATION_ID
      ] as string;
      const duration = Date.now() - startTime;

      if (!deps.abortSignal?.aborted) {
        deps.context.emit("route:step:error", {
          routeId: deps.routeId,
          error: err,
          route: deps.route,
          exchange,
          operation: stepLabel,
        });
      }

      noteFailingStep(exchange, err, step);

      const isChild = exchange.id !== parentExchangeId;
      /**
       * Apply a ring's decision to this run's bookkeeping. A split child's
       * decision settles that child alone: a recovered child completes with
       * its own terminal event and never becomes the run's result, and its
       * siblings and the join after them still run.
       */
      const settle = (decision: ErrorDecision): void => {
        if (decision.kind === "dropped") {
          if (!isChild) dropped = true;
          return;
        }
        if (isChild) {
          if (decision.kind === "recovered") {
            queue.push({ exchange: decision.exchange, steps: [] });
          }
          return;
        }
        lastProcessedExchange = decision.exchange;
      };

      if (deps.definition.errorHandler) {
        deps.context.emit("route:error-handler:invoked", {
          routeId: deps.routeId,
          exchangeId: exchange.id,
          correlationId,
          originalError: err,
          failedOperation: stepLabel,
          scope: "route",
        });

        try {
          const forward = deps.buildForward(exchange);
          const result = await deps.definition.errorHandler(
            err,
            exchange,
            forward,
          );
          if (isRecovery(result) && result.kind === "rethrow") {
            throw err;
          }
          settle(
            await applyErrorDecision(deps, {
              exchange,
              originalError: err,
              result,
              stepLabel,
              correlationId,
              scope: "route",
              pendingSourceParse,
              admitted,
              failingStep: failingStepOf(exchange, err) ?? step,
              handler: "route",
              ...(deps.route.definition.errorPathSchema
                ? { schema: deps.route.definition.errorPathSchema }
                : {}),
            }),
          );
        } catch (handlerError) {
          const handlerErr = processError(handlerError);
          exchange.logger.error(
            {
              operation: stepLabel,
              err: handlerErr,
              context: "error handler",
            },
            handlerErr.meta.message,
          );
          deps.context.emit("route:error-handler:failed", {
            routeId: deps.routeId,
            exchangeId: exchange.id,
            correlationId,
            originalError: err,
            failedOperation: stepLabel,
            recoveryStrategy: "route-error-handler",
            scope: "route",
          });

          const decided = await runErrorSlot(deps, {
            exchange,
            originalError: handlerErr,
            stepLabel,
            correlationId,
            pendingSourceParse,
            admitted,
            // Keyed by `err`: the failing-step map has never seen `handlerErr`.
            failingStep: failingStepOf(exchange, err) ?? step,
          });
          if (decided) {
            settle(decided);
          } else {
            announceFailure(
              deps,
              exchange,
              handlerErr,
              correlationId,
              duration,
            );
            if (exchange.id !== parentExchangeId) {
              failedChildExchanges.add(exchange.id);
            } else {
              failed = true;
              stepError = handlerErr;
            }
          }
        }

        // The pipeline does not resume after the handler, success or failure.
        if (isChild) continue;
        return {
          exchange: lastProcessedExchange,
          failed,
          dropped,
          deferred: isDeferredRun(exchange),
          error: stepError,
        };
      }

      // Above the rethrowUnhandled escape: a parked exchange must not reach a wrapping retry.
      const decided = await runErrorSlot(deps, {
        exchange,
        originalError: err,
        stepLabel,
        correlationId,
        pendingSourceParse,
        admitted,
        failingStep: failingStepOf(exchange, err) ?? step,
      });
      if (decided) {
        settle(decided);
        // Same as after a route handler: the pipeline does not resume.
        if (isChild) continue;
        return {
          exchange: lastProcessedExchange,
          failed,
          dropped,
          deferred: isDeferredRun(exchange),
          error: stepError,
        };
      }

      // Inside a nested segment the wrapping step decides, not the default error path.
      if (deps.rethrowUnhandled && exchange.id === parentExchangeId) {
        throw err;
      }

      exchange.logger.error(
        {
          operation: stepLabel,
          ...(adapterLabel ? { adapter: adapterLabel } : {}),
          err,
        },
        err.meta.message,
      );
      announceFailure(deps, exchange, err, correlationId, duration);
      if (exchange.id !== parentExchangeId) {
        failedChildExchanges.add(exchange.id);
      } else {
        failed = true;
        stepError = err;
      }

      // No return: remaining split children still need processing.
    }
  }

  // Pre-existing groups belong to concurrent handlers on the same context.
  if (parentMap && parentMap.size > 0) {
    for (const groupId of Array.from(parentMap.keys())) {
      if (preExistingGroups.has(groupId)) continue;
      const parentEx = parentMap.get(groupId);
      if (parentEx) {
        const hierarchy = parentEx.headers[HeadersKeys.SPLIT_HIERARCHY] as
          string[] | undefined;
        // Only clean up groups that are NOT part of a nested hierarchy
        if (!hierarchy || !hierarchy.includes(groupId)) {
          parentMap.delete(groupId);
        }
      }
    }
  }

  // The drop flag lives on shared internals, so it is visible through rewraps.
  if (isDropped(exchange)) {
    dropped = true;
  }

  return {
    exchange: lastProcessedExchange,
    failed,
    dropped,
    deferred: isDeferredRun(exchange),
    error: stepError,
  };
}

/**
 * What an error ring decided, once the decision has been applied.
 *
 * `unhandled` is deliberately absent: a ring that declined returns nothing,
 * so "no decision" cannot be mistaken for a decision with a missing field.
 *
 * @internal
 */
type ErrorDecision =
  | { kind: "recovered"; exchange: Exchange }
  | { kind: "dropped" }
  /** Parked durably. The run ends with the `Deferred` acknowledgment. */
  | { kind: "deferred"; exchange: Exchange };

/**
 * The step that failed, keyed by the error object it threw.
 *
 * Keyed by the ERROR rather than held on the exchange for one reason: a
 * failure inside a route-scope resilience segment is caught by the nested
 * run, rethrown so the wrapping segment can react, and caught again by the
 * outer run, which is holding the SEGMENT step rather than the step that
 * actually failed. The error object travels intact through that (a
 * `RoutecraftError` passes through `processError` unchanged), so it is the
 * one thing that still names the real position by the time a handler
 * decides.
 *
 * Weak, so nothing has to be cleared, and first-writer-wins, so the
 * innermost catch is the one that counts.
 *
 * Scoped to the EXCHANGE rather than the module, because the key is an object
 * the application owns: a route that throws a preallocated error instance
 * from more than one place would otherwise bind it to the first step that
 * ever failed with it, for the lifetime of the process and across every
 * context in it. The nested segment run this exists for shares its
 * exchange with the outer run, so exchange scope is all the reach it needs.
 *
 * @internal
 */
function failingStepMap(
  exchange: Exchange,
): WeakMap<object, Step<Adapter>> | undefined {
  const internals = EXCHANGE_INTERNALS.get(exchange);
  if (!internals) return undefined;
  internals.failingSteps ??= new WeakMap<object, Step<Adapter>>();
  return internals.failingSteps;
}

/** @internal */
function noteFailingStep(
  exchange: Exchange,
  error: unknown,
  step: Step<Adapter>,
): void {
  if (typeof error !== "object" || error === null) return;
  const map = failingStepMap(exchange);
  if (!map || map.has(error)) return;
  map.set(error, step);
}

/** @internal */
function failingStepOf(
  exchange: Exchange,
  error: unknown,
): Step<Adapter> | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  return failingStepMap(exchange)?.get(error);
}

/**
 * The scopes the park this exchange was revived from was raised for, when it
 * was revived from one at all.
 *
 * Read from a framework header rather than from the store because the
 * executor has the exchange and not the record; a revival writes the header
 * from the record's own field, absent value included.
 *
 * @internal
 */
function parkedRefusedScopes(
  exchange: Exchange,
): readonly string[] | undefined {
  const carried = exchange.headers[DeferralHeaders.REFUSED_SCOPES];
  return Array.isArray(carried) && carried.every((s) => typeof s === "string")
    ? (carried as readonly string[])
    : undefined;
}

/**
 * Consult the context's error handlers, in registration order.
 *
 * Reached only where the route's own handling gave up: no route handler, or
 * one that rethrew or threw. The first handler to return anything other than
 * `undefined` decides; `undefined` passes to the next.
 *
 * A handler that throws is reported and the chain CONTINUES to the next one,
 * and its throw never replaces the error that reaches the failure path. A
 * chain whose first member could take the whole context's error reporting
 * down with it would be worse than no chain. Applying a decision (a park
 * refused, a store write or notify failing) is guarded the same way, so the
 * exchange always reaches a terminal event. A `rethrow` answer declines for
 * the whole chain: a later handler may not overturn it.
 *
 * A run with `rethrowUnhandled` consults no ring at all. Its nested
 * definition carries no `errorHandler`, so consulting the context ring there
 * would let a context handler pre-empt the route's own `.error()` and settle
 * the failure before the declared retry policy ran. Both rings get their
 * turn at the outermost run once the segment's attempts are exhausted.
 *
 * The handler's `forward` is bound to the failing exchange, like a route
 * `.error()` handler's, so it carries the principal and correlation id.
 *
 * @returns What was decided, or `undefined` when nothing was
 *
 * @internal
 */
async function runErrorSlot(
  deps: ExecutorDeps,
  args: {
    exchange: Exchange;
    originalError: RoutecraftError;
    stepLabel: string;
    correlationId: string;
    pendingSourceParse: boolean;
    admitted: boolean;
    /** The step that failed, as the step loop holds it. */
    failingStep?: Step<Adapter>;
  },
): Promise<ErrorDecision | undefined> {
  if (deps.rethrowUnhandled) return undefined;
  const { observe, decide } = deps.context.errorHooks(deps.route);
  if (observe.length === 0 && decide.length === 0) return undefined;
  // Every revival stamps `resumedAt` and no first run carries it.
  const execution =
    args.exchange.headers[DeferralHeaders.RESUMED_AT] !== undefined ? 2 : 1;
  const kind: RunKind = deps.runKind ?? (execution === 2 ? "resume" : "normal");
  const tags = routeTags(deps.route.definition);
  const info = {
    routeId: deps.routeId,
    tags,
    slot: "error",
    kind,
    execution,
    forward: deps.buildForward(args.exchange),
  } as const;

  // Observe hooks hear the failure and never decide; one that throws is
  // reported and the rest still hear it.
  for (const entry of observe) {
    const hook = entry.hook as ErrorHook;
    if (!runsOn(hook, kind, "error")) continue;
    try {
      const heard = await hook.run(args.originalError, args.exchange, info);
      if (heard !== undefined) {
        throw rcError("RC1115", undefined, {
          message: `Observe hook ${entry.id} in "error" returned a value. An observe hook hears the failure; decide it from a mutate hook.`,
        });
      }
    } catch (thrown) {
      args.exchange.logger.error(
        { err: processError(thrown), hook: entry.id },
        "An error-slot observe hook threw; the failure continues to the rest of the slot.",
      );
    }
  }

  const handlers = decide.filter((entry) =>
    runsOn(entry.hook as ErrorHook, kind, "error"),
  );
  for (const entry of handlers) {
    const handler = entry.hook as ErrorHook;
    deps.context.emit("route:error-handler:invoked", {
      routeId: deps.routeId,
      exchangeId: args.exchange.id,
      correlationId: args.correlationId,
      originalError: args.originalError,
      failedOperation: args.stepLabel,
      scope: "slot",
    });
    try {
      const result = await handler.run(args.originalError, args.exchange, info);
      if (result === undefined) continue;
      if (isRecovery(result) && result.kind === "rethrow") {
        return undefined;
      }
      if (isRecovery(result) && result.kind === "defer" && !handler.mayDefer) {
        throw rcError("RC1115", undefined, {
          message: `Error hook ${entry.id} answered recovery.defer() without declaring { mayDefer: true }. The declaration is what lets the application refuse to start without a deferral runtime; add it to the hook.`,
        });
      }
      // Inside the try: an escaping park failure would leave no terminal event.
      return await applyErrorDecision(deps, {
        exchange: args.exchange,
        originalError: args.originalError,
        result,
        stepLabel: args.stepLabel,
        correlationId: args.correlationId,
        scope: "slot",
        pendingSourceParse: args.pendingSourceParse,
        admitted: args.admitted,
        ...(args.failingStep ? { failingStep: args.failingStep } : {}),
        handler: entry.id,
        ...(handler.schema ? { schema: handler.schema } : {}),
      });
    } catch (thrown) {
      const handlerErr = processError(thrown);
      args.exchange.logger.error(
        {
          operation: args.stepLabel,
          err: handlerErr,
          context: "error-slot hook",
          hook: entry.id,
        },
        handlerErr.meta.message,
      );
      deps.context.emit("route:error-handler:failed", {
        routeId: deps.routeId,
        exchangeId: args.exchange.id,
        correlationId: args.correlationId,
        originalError: args.originalError,
        failedOperation: args.stepLabel,
        recoveryStrategy: "error-slot-hook",
        scope: "slot",
        hook: entry.id,
      });
      continue;
    }
  }
  return undefined;
}

/**
 * Turn a handler's non-`undefined`, non-rethrow answer into a decision, and
 * emit the events that go with it.
 *
 * Shared by the route ring and the context ring so the two cannot drift into
 * recovering, dropping or parking differently for the same answer. `rethrow`
 * is handled by each caller instead, because it means something different to
 * each: at route scope it falls into the handler-threw path, and at context
 * scope it declines for the chain.
 *
 * @internal
 */
async function applyErrorDecision(
  deps: ExecutorDeps,
  args: {
    exchange: Exchange;
    originalError: RoutecraftError;
    result: unknown;
    stepLabel: string;
    correlationId: string;
    scope: "route" | "slot";
    pendingSourceParse: boolean;
    admitted: boolean;
    failingStep?: Step<Adapter>;
    /** Who decided: the route's own handler, or the error hook's id. */
    handler: "route" | string;
    /** The deciding handler's declared resume schema, when it parks. */
    schema?: StandardSchemaV1;
  },
): Promise<ErrorDecision> {
  const strategy =
    args.scope === "route" ? "route-error-handler" : "error-slot-hook";

  if (isRecovery(args.result) && args.result.kind === "drop") {
    applyDropDirective({
      context: deps.context,
      routeId: deps.routeId,
      exchange: args.exchange,
      originalError: args.originalError,
      failedOperation: args.stepLabel,
      correlationId: args.correlationId,
      reason: args.result.reason,
      scope: args.scope,
      route: deps.route,
    });
    return { kind: "dropped" };
  }

  if (isRecovery(args.result) && args.result.kind === "defer") {
    const deferred = await parkFromErrorPath(deps, {
      exchange: args.exchange,
      directive: args.result,
      originalError: args.originalError,
      pendingSourceParse: args.pendingSourceParse,
      admitted: args.admitted,
      ...(args.failingStep ? { failingStep: args.failingStep } : {}),
      handler: args.handler,
      ...(args.schema ? { schema: args.schema } : {}),
    });
    deps.context.emit("route:error-handler:recovered", {
      routeId: deps.routeId,
      exchangeId: deferred.id,
      correlationId: args.correlationId,
      originalError: args.originalError,
      failedOperation: args.stepLabel,
      recoveryStrategy: strategy,
      scope: args.scope,
    });
    return { kind: "deferred", exchange: deferred };
  }

  // Rewrap keeps the id, so telemetry follows the same logical exchange.
  const recovered = DefaultExchange.rewrap(args.exchange, {
    body: args.result,
  });
  deps.context.emit("route:error:caught", {
    routeId: deps.routeId,
    error: args.originalError,
    route: deps.route,
    exchange: recovered,
  });
  deps.context.emit("route:error-handler:recovered", {
    routeId: deps.routeId,
    exchangeId: recovered.id,
    correlationId: args.correlationId,
    originalError: args.originalError,
    failedOperation: args.stepLabel,
    recoveryStrategy: strategy,
    scope: args.scope,
  });
  return { kind: "recovered", exchange: recovered };
}

/**
 * Park an exchange a handler answered `recovery.defer()` for.
 *
 * The handler names no position, and must not: it runs outside the step tree
 * and a position it chose could revive a continuation the approval was never
 * taken against. The executor resolves one instead, from the step that
 * actually failed.
 *
 * Four refusals, all BEFORE the store write, so a park the framework will
 * not make never reaches the record and its `notify` never runs:
 *
 * - the failing position cannot be revived (`RC5051`), which is exactly the
 *   set a `DeferSignal` is refused from;
 * - the failure was raised after admission at a position the walk does not
 *   address (`RC5051`), which is a framework-owned carrier around the
 *   pipeline: a route-scope `.timeout()` raising its deadline, a bulkhead
 *   refusing, a breaker fast-failing. Those sit above steps that have
 *   already run, so parking one would resume from the top of the route and
 *   charge every completed step's side effects twice. An ordinary step
 *   failure inside such a segment is unaffected, because the nested run
 *   notes the real step before it rethrows;
 * - the failure came from above a source-attached parse that a resume cannot
 *   reproduce (`RC5051`). The pending parser is never run at park time:
 *   `recovery.defer()` is generic, so a handler may answer it on an `RC5012`
 *   or an `RC5023` as readily as on the `RC5038` a step-up reacts to, and
 *   parsing here would feed a caller's bytes to a parser below the authorize
 *   position, inverting the ordering the pre-from chain fixes;
 * - the run is already cancelled (`RC5054`), the same as the `defer`
 *   outcome case. Cancellation is read from the route's execution signal as
 *   well as the run's own, because a route-scope handler runs in the outer
 *   run, which carries no signal when the deadline belongs to a nested
 *   `.timeout()`. The same composite is handed to `deferExchange`, so a stop
 *   landing during the write denies the record rather than leaving a live
 *   link.
 *
 * Plus the loop-closing rule: a resumed exchange is not parked again for
 * scopes a lend was already asked for, so a lend that did not satisfy the
 * gate cannot ask a human forever.
 *
 * The failing step is the one the loop held; the error-keyed lookup is the
 * fallback for a failure inside a route-scope resilience segment, where the
 * outer loop holds the synthetic carrier. The error alone is not enough: a
 * route handler that throws its own error hands the context chain one with
 * no entry.
 *
 * The notify hook is bounded by the route's intake signal (widened by an
 * enclosing `.timeout()`), the same pair the resume `authorize` hook races,
 * so an unsettled hook cannot hold drain open. It only stops waiting on a
 * park that already committed; it never refuses one.
 *
 * @internal
 */
async function parkFromErrorPath(
  deps: ExecutorDeps,
  args: {
    exchange: Exchange;
    directive: RecoveryDefer;
    originalError: RoutecraftError;
    pendingSourceParse: boolean;
    admitted: boolean;
    failingStep?: Step<Adapter>;
    handler: string;
    schema?: StandardSchemaV1;
  },
): Promise<Exchange> {
  const definition = deps.route.definition;
  const failing =
    args.failingStep ?? failingStepOf(args.exchange, args.originalError);
  const resolved = failing
    ? definition.errorPathSites?.get(failing)
    : undefined;

  if (resolved?.kind === "refused") {
    throw rcError("RC5051", args.originalError, { message: resolved.refusal });
  }

  // Storing position 0 here would re-run every completed step on resume.
  if (args.admitted && resolved === undefined) {
    throw rcError("RC5051", args.originalError, {
      message: `Route "${deps.routeId}" failed at a position the defer-site walk does not address, after the exchange had already been admitted. This is a framework-owned position around the pipeline (a route-scope .timeout(), .retry(), .circuitBreaker() or .concurrency() raising its own failure rather than a step's), and parking there would have to resume from the top of the route and re-run every step that already completed. Park from a failure raised by a step instead.`,
    });
  }

  const admission = resolved === undefined;
  if (admission && args.pendingSourceParse) {
    throw rcError("RC5051", args.originalError, {
      message: `Route "${deps.routeId}" failed before its source's parse ran, and an error-path park here cannot be revived: the parser arrives per message on the queue envelope and is neither stored with the record nor re-derivable from the route, so the continuation would resume against an unparsed body. Park from a position below the parse, or let the failure stand. A route fed by an identity-bearing transport (http, direct, mcp) attaches no source parser and is unaffected.`,
    });
  }
  const site = admission ? definition.admissionSite : resolved.site;
  if (!site) {
    throw rcError("RC5051", args.originalError, {
      message: `Route "${deps.routeId}" has no resolved defer sites, so an error-path park has no position to revive from. This route was not produced by craft().build().`,
    });
  }

  // The execution signal, not intake: a route that only stops accepting work still parks.
  const cancellation = anySignal(deps.route.signal, deps.abortSignal);
  if (cancellation?.aborted) {
    throw rcError("RC5054", cancellation.reason, {
      message: `Route "${deps.routeId}" answered a failure with recovery.defer() after its run was cancelled; nothing was deferred.`,
    });
  }

  const refused = insufficientAuthorityOf(args.originalError)?.scopes;
  const alreadyAsked = parkedRefusedScopes(args.exchange);
  if (
    refused &&
    alreadyAsked &&
    refused.every((scope) => alreadyAsked.includes(scope))
  ) {
    throw rcError("RC5051", args.originalError, {
      message: `Route "${deps.routeId}" refused the same scope(s) again after a resume that was supposed to supply them (${refused.join(", ")}), so it is not parked a second time. A lend that does not satisfy the gate must not be able to ask a human for the same thing forever; check that the scopes being lent are the ones the gate reads (a lend on the actor's ring is only read by a gate declaring effective: true).`,
    });
  }

  const { notify, ttl, meta, callBinding, stepState } = args.directive.request;
  const schema = args.schema;
  const notifySignal = anySignal(deps.route.intakeSignal, deps.abortSignal);
  return await deferExchange(
    deps.context,
    args.exchange,
    {
      site,
      ...(notifySignal ? { notifySignal } : {}),
      ...(schema !== undefined ? { schema } : {}),
      ...(meta !== undefined ? { meta } : {}),
      ...(callBinding !== undefined ? { callBinding } : {}),
      ...(ttl !== undefined
        ? { expiresInMs: parseDuration(ttl, "recovery.defer({ ttl })") }
        : {}),
      ...(stepState !== undefined ? { stepState } : {}),
      ...(notify !== undefined ? { notify } : {}),
      errorPath: {
        origin: admission ? "admission" : "step",
        handler: args.handler,
        ...(refused ? { refusedScopes: refused } : {}),
      },
    },
    deps.routeId,
    cancellation,
  );
}

/**
 * Synthetic adapter carriers for the positions that surround the chain
 * tail. Distinct adapter ids so telemetry correlating by `adapter` can tell
 * retry re-runs (`routecraft.retry`) from deadline guards
 * (`routecraft.timeout`) without parsing the step label. No carrier has
 * behaviour; the provider's position does the work.
 */
type PositionName = "circuitBreaker" | "retry" | "timeout" | "concurrency";

const POSITION_CARRIERS: Record<
  PositionName,
  { readonly operation: OperationType; readonly adapter: Adapter }
> = {
  circuitBreaker: {
    operation: OperationType.CIRCUIT_BREAKER,
    adapter: { adapterId: "routecraft.circuitBreaker" },
  },
  retry: {
    operation: OperationType.PROCESS,
    adapter: { adapterId: "routecraft.retry" },
  },
  timeout: {
    operation: OperationType.PROCESS,
    adapter: { adapterId: "routecraft.timeout" },
  },
  concurrency: {
    operation: OperationType.CONCURRENCY,
    adapter: { adapterId: "routecraft.concurrency" },
  },
};

/**
 * Convert a nested segment run's result into the {@link StepOutcome} the
 * outer pipeline schedules: a deliberately dropped run resolves as a
 * drop, every other run continues with the produced exchange. Shared by
 * the timeout / retry / circuit-breaker segment builders so the mapping
 * lives in one place.
 *
 * A run that deferred inside the segment has already been answered, so it
 * maps to `complete` rather than a second `defer`: the outer run schedules
 * nothing further and the exchange is deferred once.
 */
function segmentResultToOutcome(result: {
  exchange: Exchange;
  dropped: boolean;
}): StepOutcome {
  if (result.dropped) return { kind: "drop" } as const;
  if (isDeferredRun(result.exchange)) {
    return { kind: "complete", exchange: result.exchange } as const;
  }
  return { kind: "continue", exchange: result.exchange } as const;
}

/**
 * One position that surrounds the chain tail, as a step of the run.
 *
 * The provider decides how often, and whether, the tail runs; the executor
 * owns what one run of it is. `attempt` runs the tail through a nested
 * executor that rethrows instead of failing the exchange, so the position
 * sees each failure and the outer run sees only the outcome it returns.
 *
 * The abandon signal is read per execution from the step context, never at
 * build time: an outer timeout mints one per attempt.
 *
 * A resumed continuation re-enters its deferring step with the same deferred
 * state on every attempt, even after a settled step inside an earlier
 * attempt cleared it, so a later retryable failure does not restart the
 * deferring step from scratch.
 */
function buildPositionStep(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  position: Position,
  name: PositionName,
): Step<Adapter> {
  const carrier = POSITION_CARRIERS[name];
  return {
    operation: carrier.operation,
    label: name,
    adapter: carrier.adapter,
    skipStepEvents: true,
    execute(exchange, ctx) {
      const abandon = ctx?.signal ?? deps.abortSignal;
      const resumeSnapshot = peekResumeStepState(exchange);
      return position.run({
        routeId: deps.routeId,
        scope: "route",
        stepLabel: "route",
        route: deps.route,
        exchange,
        signal: anySignal(deps.route.intakeSignal, abandon),
        ...(abandon ? { abandon } : {}),
        mustWait: deps.admissionMustWait === true,
        forward: deps.buildForward(exchange),
        emit: (event, details) => deps.context.emit(event, details),
        async attempt(signal) {
          if (resumeSnapshot !== undefined) {
            setResumeStepState(exchange, resumeSnapshot);
          }
          return segmentResultToOutcome(
            await runPipeline(
              nestedDeps(deps, segment, {
                rethrowUnhandled: true,
                abortSignal: signal,
              }),
              exchange,
              Date.now(),
            ),
          );
        },
      });
    },
  };
}

/**
 * Executor deps for a nested `runPipeline` invocation: same route identity
 * and capabilities, but the step array carries only the wrapped segment and
 * no `errorHandler` / `retry` / `timeout` (the outer invocation owns filter
 * #1 and the segment wrappers themselves; omitting them here is also what
 * stops the nested run from re-wrapping recursively).
 *
 * Two callers, distinguished by `opts`:
 * - Resilience segments (timeout / retry / circuit breaker) pass
 *   `rethrowUnhandled: true` so a failed attempt throws out of the nested
 *   run and the segment step can react, and the timeout segment additionally
 *   passes its `abortSignal` so an expired attempt stops scheduling.
 * - Multicast paths omit `rethrowUnhandled` so a path that throws resolves
 *   through the default error path for its own clone (firing that exchange's
 *   `route:error` / `context:error` / `route:exchange:failed`) rather than
 *   propagating, so one failing path neither rejects `runPaths` nor disturbs
 *   the others, while still forwarding any outer `abortSignal` so a
 *   route-scope timeout can stop in-flight paths.
 *
 * The empty definition is deliberately outside `CHAIN_SURVIVAL`: a nested
 * segment is not a re-entry, so it has nothing to declare per position. The
 * invocation above it already applied the chain.
 */
function nestedDeps(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  opts: {
    rethrowUnhandled?: boolean;
    abortSignal?: AbortSignal | undefined;
  } = {},
): ExecutorDeps {
  return {
    routeId: deps.routeId,
    context: deps.context,
    route: deps.route,
    buildForward: deps.buildForward,
    ...(opts.rethrowUnhandled ? { rethrowUnhandled: true } : {}),
    ...(opts.abortSignal ? { abortSignal: opts.abortSignal } : {}),
    ...(deps.runKind ? { runKind: deps.runKind } : {}),
    ...(deps.admissionMustWait ? { admissionMustWait: true } : {}),
    definition: { steps: segment },
  };
}

/**
 * Build the detached-release runner handed out by `captureDownstream`.
 *
 * Module-level on purpose, for two verified reasons:
 *
 * - The returned closure must capture ONLY route-stable state (`deps` and
 *   the downstream step array). Building it inside `runPipeline` would chain
 *   it to that invocation's activation context (pinning the capturing
 *   arrival's queue for as long as the runner is retained) and, worse, to
 *   `deps.abortSignal`: when the capturing arrival ran inside a route-scope
 *   timeout / concurrency attempt, that per-attempt signal can abort later
 *   and would permanently poison every future release into scheduling zero
 *   steps. A released exchange is a fresh detached flow, so it inherits NO
 *   abort signal.
 * - For a holding operation (debounce) the released exchange IS the route's
 *   primary flow, not a side effect, so unlike fan-out paths the detached
 *   run honors the route-scope `.error()` handler and enforces the route's
 *   `.output()` schemas before completion. Both are read from
 *   `deps.route.definition` (the full definition) because the capturing
 *   invocation may be a nested segment whose own `deps.definition` has them
 *   stripped.
 *
 * The released exchange gets its own `route:exchange:started` / `:completed`
 * lifecycle pair, and the whole release flow (pipeline, output validation,
 * completion emit) is `trackTask`ed so `drain()` waits for it whether or not
 * the caller awaits the runner.
 */
function makeDownstreamRunner(
  deps: ExecutorDeps,
  downstream: Step<Adapter>[],
): (exchange: Exchange) => Promise<{ failed: boolean; dropped: boolean }> {
  return (releaseExchange) => {
    const release = runDetachedPipeline(
      deps,
      downstream,
      releaseExchange,
      "debounce",
    );
    deps.route.trackTask(release);
    return release;
  };
}

/**
 * Run `steps` against `exchange` as a detached, first-class run of the
 * route: its own `route:exchange:started` / `:completed` pair, the route-scope
 * `.error()` handler honoured, and the route's `.output()` schemas enforced
 * before completion.
 *
 * Two callers, sharing the run's shape but not its chain. `debounce`
 * releases a held exchange into the steps that follow it, and a resume
 * revives a deferred exchange into its continuation. Neither is a side-effect
 * clone: in both cases the exchange IS the route's primary flow, resuming
 * partway down a pipeline whose earlier steps must not re-run.
 *
 * `kind` is what separates them, because the chain above the entry point
 * means different things for each: a released exchange is work the route
 * held back and never admitted, while a resumed one entered the route once
 * and was admitted then. Which positions apply is declared per position in
 * `chain-policy.ts` rather than decided here.
 *
 * The run inherits NO abort signal. A signal from the capturing attempt (a
 * route-scope timeout) can fire long after, and a detached run is a fresh
 * flow rather than a continuation of that attempt.
 *
 * @param kind - Which detached run this is, selecting the chain policy
 *
 * @internal
 */
export function runDetachedPipeline(
  deps: ExecutorDeps,
  downstream: ReadonlyArray<Step<Adapter>>,
  releaseExchange: Exchange,
  kind: DetachedKind,
): Promise<DetachedResult> {
  return (async (): Promise<DetachedResult> => {
    const start = Date.now();
    const correlationId = releaseExchange.headers[
      HeadersKeys.CORRELATION_ID
    ] as string;
    deps.context.emit("route:exchange:started", {
      routeId: deps.routeId,
      exchangeId: releaseExchange.id,
      correlationId,
    });
    const routeDefinition = deps.route.definition;
    const slots = detachedSlots(deps, kind);
    const runKind: RunKind = kind === "admission" ? "resume" : kind;
    const nested: ExecutorDeps = {
      routeId: deps.routeId,
      context: deps.context,
      route: deps.route,
      buildForward: deps.buildForward,
      definition: detachedDefinition(routeDefinition, downstream, kind),
      ...(deps.positions ? { positions: deps.positions } : {}),
      ...(CHAIN_SURVIVAL.concurrency[kind].mustNotRefuse
        ? { admissionMustWait: true }
        : {}),
      ...(slots ? { slots } : {}),
      // An admission park resumes like any other continuation.
      runKind,
    };
    let result = await runPipeline(nested, releaseExchange, start);
    result = await applyExitSlot(nested, result, runKind);

    result = await applyOutputStage(
      {
        routeId: deps.routeId,
        context: deps.context,
        route: deps.route,
        buildForward: deps.buildForward,
        ...(routeDefinition.errorHandler
          ? { errorHandler: routeDefinition.errorHandler }
          : {}),
      },
      routeDefinition.discovery?.output,
      result,
      start,
    );

    // A deferred run already had its terminal event, `route:exchange:deferred`.
    if (!result.failed && !result.dropped && !result.deferred) {
      deps.context.emit("route:exchange:completed", {
        routeId: deps.routeId,
        exchangeId: releaseExchange.id,
        correlationId,
        duration: Date.now() - start,
        exchange: result.exchange,
      });
    }
    return {
      failed: result.failed,
      dropped: result.dropped,
      deferred: result.deferred,
      exchange: result.exchange,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  })();
}

/**
 * What a detached run reports back. `error` is present exactly when
 * `failed` is true and the failure reached the run's boundary, which is
 * what a resume needs to cache as the deferral's continuation result.
 *
 * @internal
 */
export interface DetachedResult {
  failed: boolean;
  dropped: boolean;
  /**
   * The run deferred at a `.defer()`. Distinct from every other outcome:
   * the exchange is neither finished nor failed, and its terminal body is
   * the `Deferred` acknowledgment rather than the route's output. A caller
   * that treats it as a completion publishes both a false receipt and the
   * next deferral's resume token.
   */
  deferred: boolean;
  exchange: Exchange;
  error?: unknown;
}

const PER_ATTEMPT_ADAPTER: Adapter = { adapterId: "routecraft.hooks" };

/**
 * The `exit` slot: plugin hooks over an exchange that completed, run before
 * the output stage so what they add is what the caller receives and what the
 * route's `.output()` schema checks.
 *
 * Only a completed run reaches it: a run that dropped, parked or failed has
 * nothing to hand the caller. A hook that throws fails the exchange with its
 * error; the work is done, so there is nothing for an `.error()` handler to
 * recover.
 *
 * @internal
 */
export async function applyExitSlot<
  R extends {
    exchange: Exchange;
    failed: boolean;
    dropped: boolean;
    deferred: boolean;
    error?: unknown;
  },
>(deps: ExecutorDeps, result: R, kind: RunKind): Promise<R> {
  if (result.failed || result.dropped || result.deferred) return result;
  const table = deps.context.hooks;
  if (!table) return result;
  const tags = routeTags(deps.route.definition);
  const hooks = table.forRoute("exit", deps.routeId, tags);
  if (hooks.length === 0) return result;
  try {
    const exchange = await runExchangeHooks(table, hooks, result.exchange, {
      routeId: deps.routeId,
      tags,
      slot: "exit",
      kind,
    });
    return { ...result, exchange };
  } catch (thrown) {
    const err = processError(thrown);
    const exchange = result.exchange;
    // The one place this failure is logged: the hook threw after the work
    // completed, so no handler ring sees it.
    exchange.logger.error({ err, slot: "exit" }, err.meta.message);
    announceFailure(
      deps,
      exchange,
      err,
      exchange.headers[HeadersKeys.CORRELATION_ID] as string,
      Date.now() - (getStartedAt(exchange) ?? Date.now()),
    );
    return { ...result, failed: true, error: err };
  }
}

/**
 * The exchange's terminal failure, announced once: `route:error`,
 * `context:error` and `route:exchange:failed`, in that order. Every failure
 * path announces through here, so the three cannot drift apart.
 */
function announceFailure(
  deps: ExecutorDeps,
  exchange: Exchange,
  error: RoutecraftError,
  correlationId: string,
  duration: number,
): void {
  deps.context.emit("route:error", {
    routeId: deps.routeId,
    error,
    route: deps.route,
    exchange,
  });
  deps.context.emit("context:error", { error, route: deps.route, exchange });
  deps.context.emit("route:exchange:failed", {
    routeId: deps.routeId,
    exchangeId: exchange.id,
    correlationId,
    duration,
    error,
    exchange,
  });
}

/**
 * The `perAttempt` slot: every wrapper a plugin placed there surrounds one
 * attempt of the chain tail, the first listed outermost. A wrapper may time,
 * trace or guard the attempt and may throw; the exchange the attempt
 * produced is what continues.
 */
function buildPerAttemptSegmentStep(
  deps: ExecutorDeps,
  segment: Step<Adapter>[],
  wrappers: readonly InstalledHook[],
): Step<Adapter> {
  return {
    operation: OperationType.HOOKS,
    label: "perAttempt",
    adapter: PER_ATTEMPT_ADAPTER,
    skipStepEvents: true,
    async execute(exchange, ctx) {
      let result: Awaited<ReturnType<typeof runPipeline>> | undefined;
      const info = {
        routeId: deps.routeId,
        tags: deps.slots?.tags ?? [],
        slot: "perAttempt",
        kind: deps.runKind ?? ("normal" as const),
      };
      let attempt: Promise<void> | undefined;
      let proceed = (): Promise<void> => {
        if (attempt) {
          throw rcError("RC1115", undefined, {
            message: `A perAttempt wrapper on route "${deps.routeId}" called proceed() twice. A wrapper surrounds one attempt; retrying is the retry position's job.`,
          });
        }
        attempt = runPipeline(
          nestedDeps(deps, segment, {
            rethrowUnhandled: true,
            abortSignal: ctx?.signal ?? deps.abortSignal,
          }),
          exchange,
          Date.now(),
        ).then((outcome) => {
          result = outcome;
        });
        return attempt;
      };
      for (let i = wrappers.length - 1; i >= 0; i--) {
        const wrapper = wrappers[i]!.hook as WrapperHook;
        const inner = proceed;
        proceed = () => wrapper.wrap(inner, exchange, info);
      }
      // Settle the attempt even if the wrapper did not await it, so retry never overlaps.
      try {
        await proceed();
      } catch (err) {
        await attempt?.catch(() => undefined);
        throw err;
      }
      await attempt;
      if (!result) {
        throw rcError("RC1115", undefined, {
          message: `A perAttempt wrapper on route "${deps.routeId}" returned without calling proceed(). A wrapper surrounds the attempt; to stop it, throw.`,
        });
      }
      return segmentResultToOutcome(result);
    },
  };
}

/**
 * Normalize an operation error into a RoutecraftError.
 * If the error is already a RoutecraftError, it is returned unchanged.
 *
 * @param error - The thrown value (Error or RoutecraftError)
 * @returns A RoutecraftError (existing or RC5001-wrapped)
 * @private
 */
export function processError(error: unknown): RoutecraftError {
  if (isRoutecraftError(error)) {
    return error;
  }
  const msg = error instanceof Error ? error.message : String(error);
  return rcError("RC5001", error, { message: msg });
}
