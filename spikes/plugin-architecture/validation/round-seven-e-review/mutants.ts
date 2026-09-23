import type { Mutant } from "./runner.ts";
/**
 * Review mutants, each aimed at a mechanism the shipped list does not touch.
 * Run against the existing acceptance suite only (`test/round-two`), so a
 * survivor means the head's own tests cannot see that behaviour change.
 * The filter is the test most likely to notice; the whole suite is not run
 * per mutant, matching the shipped runner's discipline.
 */
export const mutants: Mutant[] = [
  [
    "sweep processes only the first page",
    "runtime.ts",
    "if (page.length < pageSize) break;",
    "break;",
    "sweep",
  ],
  [
    "orphan does not advance the scan cursor",
    "runtime.ts",
    "cursor = entry; visited++;",
    "visited++; if (this.#routes.get(entry.routeId)) cursor = entry;",
    "orphan",
  ],
  [
    "expiry scan page is unordered",
    "storage.ts",
    ".sort((a, b) => a.expiresAt - b.expiresAt || (a.id < b.id ? -1 : 1))",
    "",
    "findExpired",
  ],
  [
    "sweep never purges settled records",
    "runtime.ts",
    "retention !== undefined ? await store.purgeSettled(now - retention) : 0;",
    "0;",
    "boot scans the store",
  ],
  [
    "sweep releases live claims, ignoring the lease",
    "runtime.ts",
    "lease !== undefined ? await store.releaseClaims(now - lease) : 0;",
    "lease !== undefined ? await store.releaseClaims(now) : 0;",
    "boot scans the store",
  ],
  [
    "settle reports expiry even when a concurrent resume won",
    "runtime.ts",
    'if (settled?.state === "resumed") return this.duplicate(settled); throw error;',
    "throw error;",
    "resume",
  ],
  [
    "claimed record proceeds down the resume path",
    "runtime.ts",
    'if (record.state !== "waiting" || record.claimedAt !== undefined)',
    'if (record.state !== "waiting")',
    "resume",
  ],
  [
    "lent grants are not honoured by the gate",
    "auth.ts",
    "const held = new Set([...p.grants, ...p.lent]);",
    "const held = new Set([...p.grants]);",
    "authoriz",
  ],
  [
    "codec accepts a non-finite number",
    "codec.ts",
    'if (!Number.isFinite(value)) throw refuse(owner, path, "a non-finite number");',
    "",
    "codec",
  ],
  [
    "codec drops a symbol value silently",
    "codec.ts",
    'case "symbol": throw refuse(owner, path, "a symbol");',
    'case "symbol": return undefined;',
    "codec",
  ],
  [
    "codec accepts the reserved date envelope as data",
    "codec.ts",
    'if (keys.length === 1 && keys[0] === DATE_TAG) throw refuse(owner, path, "the reserved date envelope");',
    "",
    "Date",
  ],
  [
    "codec revives a corrupt date envelope as an invalid Date",
    "codec.ts",
    "if (!Number.isNaN(revived.getTime())) return revived;",
    "return revived;",
    "Date",
  ],
  [
    "codec cycle check removed",
    "codec.ts",
    'if (seen.has(object)) throw refuse(owner, path, "a cycle");',
    "",
    "codec",
  ],
  [
    "duplicate route id accepted at compile",
    "runtime.ts",
    "if (this.#routes.has(spec.id))",
    "if (false)",
    "boot failure taxonomy",
  ],
  [
    "resumedAt header dropped from the continuation",
    "runtime.ts",
    "[DEFERRAL_RESUMED_AT]: now,",
    "",
    "resume",
  ],
  [
    "boot report bounds stranded ids to one",
    "storage.ts",
    "const stranded = await store.resumedWithoutOutcome(100);",
    "const stranded = await store.resumedWithoutOutcome(1);",
    "boot scans the store",
  ],
];
