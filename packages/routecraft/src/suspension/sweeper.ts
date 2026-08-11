import type { CraftContext } from "../context.ts";
import { expireSuspension } from "./revive.ts";
import type { SuspensionStore } from "./types.ts";

/** How often the sweeper looks for overdue suspensions, when unconfigured. */
export const DEFAULT_SWEEP_INTERVAL = "60s";

/**
 * How long a suspension stays resumable when `.suspend()` names no `ttl`.
 *
 * A working week's worth of hours. Long enough that an approver who is away
 * for a few days still has a live link, short enough that an unanswered
 * approval does not sit in the store forever. Configurable per context, and
 * overridable per suspend.
 */
export const DEFAULT_SUSPENSION_TTL = "72h";

/**
 * Suspensions retired per `findExpired` call.
 *
 * The scan pages rather than loading the overdue set in one query, because
 * the backlog after a long outage is unbounded and each retirement runs a
 * route's error handler. Paging keeps memory flat and lets the startup scan
 * report progress instead of appearing hung.
 */
const SWEEP_BATCH = 100;

/**
 * Stranded resumes fetched for the boot summary.
 *
 * Bounded because this is a report, not a work queue: past a certain point
 * the count is the signal and the ids stop being individually actionable.
 */
const STRANDED_REPORT = 100;

/**
 * Drives expiry for one context.
 *
 * Expiry has to be pushed rather than pulled. A `ttl` exists so a route can
 * react when nobody answers, and by definition nobody is going to present a
 * token for a suspension that timed out, so without something firing on a
 * schedule the "escalate after 72 hours" flow never runs at all.
 *
 * The sweeper never decides an outcome by itself: it competes for the same
 * compare-and-swap a late answer competes for, so a suspension resumed at
 * the instant it expires has exactly one winner, and only that winner
 * notifies.
 *
 * @internal
 */
export class SuspensionSweeper {
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(
    private readonly context: CraftContext,
    private readonly store: SuspensionStore,
    private readonly intervalMs: number,
  ) {}

  /**
   * Retire every suspension already overdue at `now`.
   *
   * Returns how many this pass retired, which is what makes the startup
   * scan able to say whether a restart had work waiting for it.
   */
  async sweep(now: Date = new Date()): Promise<number> {
    let retired = 0;
    // Records this pass could not retire. They stay `suspended`, so they
    // come back at the head of every later page, and the page has to grow
    // past them: a full page of records this context cannot retire (a route
    // it does not have, a store refusing the transition) would otherwise be
    // read forever without the sweep ever reaching what sits behind them.
    const stuck = new Set<string>();
    for (;;) {
      const limit = SWEEP_BATCH + stuck.size;
      const due = await this.store.findExpired(now, limit);
      const batch = due.filter((suspension) => !stuck.has(suspension.id));
      if (batch.length === 0) return retired;

      for (const suspension of batch) {
        const deadline = suspension.expiresAt;
        if (deadline === undefined) {
          stuck.add(suspension.id);
          continue;
        }
        const route = this.context.getRouteById(suspension.routeId);
        if (!route) {
          // The store outlives any one deployment, so it can hold work for
          // a route this process does not have. Retiring it here would
          // consume the record with nobody able to run its error channel,
          // so it is left for the deployment that owns it.
          this.context.logger.warn(
            { suspensionId: suspension.id, routeId: suspension.routeId },
            `Expired suspension belongs to route "${suspension.routeId}", which this context does not have, so it was left for a context that does. Either that route was renamed or removed while suspensions for it were still parked, or two deployments are sharing one suspension store and should not be.`,
          );
          stuck.add(suspension.id);
          continue;
        }
        try {
          const { cas } = await expireSuspension(
            this.context,
            this.store,
            route,
            { ...suspension, expiresAt: deadline },
          );
          if (cas.won) retired++;
          else stuck.add(suspension.id);
        } catch (err) {
          stuck.add(suspension.id);
          // One route's error handler throwing must not strand the rest of
          // the batch: the sweep is the only thing that will ever visit
          // them.
          this.context.logger.error(
            { err, suspensionId: suspension.id, routeId: suspension.routeId },
            "Failed to retire an expired suspension; continuing the sweep.",
          );
        }
      }

      if (due.length < limit) return retired;
      this.context.logger.info(
        { retired },
        "Still retiring expired suspensions",
      );
    }
  }

  /**
   * Sweep what expired while the process was down, and report what is
   * parked.
   *
   * Awaited by `start()` on purpose, so a context is not ready until its
   * overdue work has reached the routes that own it. An operator restarting
   * after an outage gets the escalations before the new traffic, which is
   * the order they would have arrived in had the process stayed up.
   */
  async scanOnStart(): Promise<void> {
    const retired = await this.sweep();
    const summary = await this.store.pending();
    const stranded = await this.store.resumedWithoutTerminal(STRANDED_REPORT);

    this.context.logger.info(
      {
        retiredOnStart: retired,
        pending: summary.count,
        ...(summary.oldest !== undefined
          ? { oldestSuspendedAt: summary.oldest.toISOString() }
          : {}),
        stranded: stranded.length,
        ...(stranded[0] !== undefined
          ? { oldestStrandedAt: stranded[0].suspendedAt.toISOString() }
          : {}),
      },
      "Suspension store scanned",
    );

    if (stranded.length > 0) {
      // Reported, never re-driven. Each of these spent its approval and may
      // have half applied its side effects, so an operator decides what
      // happens to it. Ids at debug because the count is what an alert
      // watches and the ids are what an investigation needs.
      this.context.logger.warn(
        { stranded: stranded.length },
        "Suspensions were resumed but never recorded an outcome, so a process died mid-continuation. Their approvals are spent and nothing will retry them; each needs an operator.",
      );
      this.context.logger.debug(
        { suspensionIds: stranded.map((record) => record.id) },
        "Stranded suspension ids",
      );
    }
  }

  /** Begin the periodic sweep. Idempotent. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      void this.sweep()
        .catch((err: unknown) => {
          this.context.logger.error(
            { err },
            "Suspension sweep failed; the next tick will retry.",
          );
        })
        .finally(() => {
          this.running = false;
        });
    }, this.intervalMs);
    // A sweep must never be the reason a process stays alive: it exists to
    // serve routes, and a context whose routes have all finished should
    // exit.
    this.timer.unref?.();
  }

  /** Stop the periodic sweep. Idempotent. */
  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
