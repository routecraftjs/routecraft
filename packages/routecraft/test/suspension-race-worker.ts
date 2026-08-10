/**
 * One contender in the multi-process compare-and-swap race.
 *
 * Spawned by `suspension-store.bun.test.ts`. Opens its own connection to a
 * shared on-disk database, waits for a start deadline the parent picked so
 * every contender attempts the transition at once, and reports on stdout
 * whether its `markResumed` won.
 *
 * A separate process is what makes the race real: both sqlite drivers are
 * synchronous, so two `markResumed` calls issued from one process can never
 * interleave and would pass even against a naive read-then-write.
 */
import { SqliteSuspensionStore } from "../src/suspension/index.ts";

const [path, id, startAt, subject] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
];

const store = await SqliteSuspensionStore.open({ path });

// Spin rather than sleep: the point is to have every contender inside
// markResumed within the same millisecond, and a timer would let the runtime
// stagger the wakeups.
const deadline = Number(startAt);
while (Date.now() < deadline) {
  /* spin to the barrier */
}

const result = await store.markResumed(id, { at: new Date(), by: { subject } });
await store.close();

process.stdout.write(JSON.stringify({ subject, won: result.won }));
