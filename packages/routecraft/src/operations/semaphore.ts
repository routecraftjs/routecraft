import { SleepAbortedError } from "./cancellable-sleep.ts";

/**
 * One exchange waiting for a slot to free. Resolved (with a fresh release
 * function) when a holder releases, or rejected with
 * {@link SleepAbortedError} when its `signal` aborts first.
 *
 * @internal
 */
interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * A counting semaphore: bounds how many holders may run at once, queueing
 * the rest FIFO. The shared concurrency primitive behind `.concurrency()`
 * (the bulkhead wrapper) and, in future, bounded `.split()` fan-out.
 *
 * Synchronous-first, like {@link TokenBucket}: under the single-threaded
 * event loop a batch of concurrent exchanges each take a distinct slot (or
 * a distinct queue position) in the same tick, so admission order is
 * deterministic FIFO and the cap is never exceeded.
 *
 * State is in-memory and lives PER ROUTE (one `Semaphore` per Route, held
 * by a controller's WeakMap), never per exchange. A handed-out release
 * function is idempotent: calling it twice frees exactly one slot.
 *
 * @internal
 */
export class Semaphore {
  readonly #max: number;
  #inUse = 0;
  readonly #waiters: SemaphoreWaiter[] = [];

  constructor(max: number) {
    this.#max = max;
  }

  /** Configured maximum simultaneous holders. */
  get max(): number {
    return this.#max;
  }

  /** Slots currently held (admitted but not yet released). */
  get inUse(): number {
    return this.#inUse;
  }

  /** Exchanges currently queued, waiting for a slot to free. */
  get waiting(): number {
    return this.#waiters.length;
  }

  /**
   * Take a slot only if one is free right now. Returns a release function
   * on success, or `undefined` when all slots are in use (the caller fails
   * fast rather than waiting). Used by reject mode.
   */
  tryAcquire(): (() => void) | undefined {
    if (this.#inUse < this.#max) {
      this.#inUse += 1;
      return this.#makeRelease();
    }
    return undefined;
  }

  /**
   * Acquire a slot, waiting FIFO until one frees when all are in use.
   * Resolves with a release function. Rejects with {@link SleepAbortedError}
   * the moment `signal` aborts (route shutdown), so a stopping route does
   * not strand an exchange in the wait queue. Used by queue mode.
   */
  acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new SleepAbortedError());
    if (this.#inUse < this.#max) {
      this.#inUse += 1;
      return Promise.resolve(this.#makeRelease());
    }
    return new Promise<() => void>((resolve, reject) => {
      const waiter: SemaphoreWaiter = { resolve, reject };
      if (signal) {
        waiter.signal = signal;
        waiter.onAbort = () => {
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          reject(new SleepAbortedError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.#waiters.push(waiter);
    });
  }

  /**
   * Build an idempotent release function. The slot is freed at most once
   * regardless of how many times the function is called, so a wrapper that
   * releases in a `finally` AND on an early path never double-frees.
   */
  #makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#release();
    };
  }

  /**
   * Free one slot: hand it straight to the next waiter (the slot stays "in
   * use", transferred without a decrement so the cap holds), or decrement
   * `#inUse` when no one is waiting.
   */
  #release(): void {
    const next = this.#waiters.shift();
    if (next) {
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener("abort", next.onAbort);
      }
      next.resolve(this.#makeRelease());
      return;
    }
    this.#inUse -= 1;
  }
}
