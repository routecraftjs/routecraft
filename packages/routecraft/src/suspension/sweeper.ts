import type { CraftContext } from "../context.ts";
import { expireSuspension } from "./revive.ts";
import type { SuspensionStore } from "./types.ts";

/** How often the sweeper looks for overdue suspensions, when unconfigured. */
export const DEFAULT_SWEEP_INTERVAL = "60s";

/**
 * How long a suspension stays resumable when `.suspend()` names no `ttl`.
 *
 * Three days. Long enough to survive a weekend, so an approver who is away
 * on Friday still has a live link on Monday, and short enough that an
 * unanswered approval does not sit in the store forever. Configurable per
 * context, and overridable per suspend.
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
  /** The sweep currently running. See {@link SuspensionSweeper.stop}. */
  private inFlight: Promise<unknown> | undefined;
  /**
   * Records this context can never retire, because it does not have their
   * route. Held per sweeper rather than per sweep: routes do not appear
   * mid-run, so re-deciding this every tick would re-read and re-warn about
   * the same records for as long as the process lives.
   */
  private readonly unowned = new Set<string>();
  /**
   * Set the moment shutdown begins, which is earlier than teardown: routes
   * are aborted and drained before plugins are torn down, so a tick landing
   * in that window would retire into a route that can no longer notify.
   */
  private stopping = false;
  private offStopping: (() => void) | undefined;

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
    // Records this pass could not retire stay `suspended`, so they return at
    // the head of every later page and the window has to grow past them.
    // Growth is capped, so past the cap the sweep sees nothing behind them
    // and retires nothing at all; that state is reported below rather than
    // left to be inferred from a silent absence of expiries.
    const stuck = new Set<string>(this.unowned);
    const missing = new Map<string, number>();
    for (;;) {
      const limit = SWEEP_BATCH + Math.min(stuck.size, SWEEP_BATCH);
      const due = await this.store.findExpired(now, limit);
      const batch = due.filter((suspension) => !stuck.has(suspension.id));
      if (batch.length === 0) {
        if (stuck.size >= SWEEP_BATCH) {
          this.context.logger.error(
            { stuck: stuck.size },
            "Expiry has stalled: the overdue set is filled with suspensions this context cannot retire, so nothing will expire until they are cleared.",
          );
        }
        break;
      }

      for (const suspension of batch) {
        // Between retirements, not only between pages: shutdown can begin
        // mid-batch, and a claim taken after that point notifies nobody.
        if (this.stopping) return retired;
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
          // so it is left for the deployment that owns it. Counted rather
          // than logged per record: an orphaned route means one problem,
          // not one problem per parked exchange.
          missing.set(
            suspension.routeId,
            (missing.get(suspension.routeId) ?? 0) + 1,
          );
          this.unowned.add(suspension.id);
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

      if (due.length < limit) break;
      this.context.logger.info(
        { retired },
        "Still retiring expired suspensions",
      );
    }

    for (const [routeId, count] of missing) {
      this.context.logger.warn(
        { routeId, count },
        `${count} expired suspension(s) belong to route "${routeId}", which this context does not have, so they were left for a context that does. Either that route was renamed or removed while suspensions for it were still parked, or two deployments are sharing one suspension store and should not be.`,
      );
    }
    return retired;
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
    // Held in the same slot the interval uses, so a shutdown arriving during
    // the scan waits for it rather than closing the store underneath it.
    this.inFlight = this.runStartScan().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight;
  }

  /** @internal */
  private async runStartScan(): Promise<void> {
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
    this.offStopping = this.context.on("context:stopping", () => {
      void this.stop();
    });
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.sweep()
        .catch((err: unknown) => {
          this.context.logger.error(
            { err },
            "Suspension sweep failed; the next tick will retry.",
          );
        })
        .finally(() => {
          this.inFlight = undefined;
        });
    }, this.intervalMs);
    // A sweep must never be the reason a process stays alive: it exists to
    // serve routes, and a context whose routes have all finished should
    // exit.
    this.timer.unref?.();
  }

  /**
   * Stop the periodic sweep and wait for the one in flight. Idempotent.
   *
   * Awaiting matters more than clearing the interval: the caller closes the
   * store next, and a sweep still running would meet a closed handle. Worse,
   * a retirement that already won its transition would re-enter a route that
   * has drained, leaving the record `expired` with its approver never told
   * and nothing left to revisit it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.offStopping?.();
    this.offStopping = undefined;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.inFlight;
  }
}
