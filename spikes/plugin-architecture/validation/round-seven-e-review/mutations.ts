/* eslint-disable no-console -- Executable review evidence. */
/**
 * Run the review mutants against the head's own acceptance suite and report
 * every verdict. A mutant that survives its named filter is re-run against
 * the WHOLE suite before it is called a survivor, because a filter that
 * names the wrong test would otherwise manufacture one. Survivors are
 * findings, not failures of this script.
 */
import { mutants } from "./mutants.ts";
import {
  disposableCopy,
  dispose,
  occurrences,
  runMutant,
  runSuite,
  verdictOf,
  type Mutant,
} from "./runner.ts";

const FULL = "^(?!independently compiled plugin)";
const dir = disposableCopy();
const tally = { killed: 0, survived: 0, invalid: 0 };
try {
  // The unchanged copy must pass the whole suite first, or every full-suite
  // kill below is void. The packed consumer test is excluded: it packs a
  // tarball from scripts the disposable copy does not carry, exactly as the
  // shipped runner's copy does not, and it exercises no kernel behaviour a
  // mutant here could change. Without this control the first run of this
  // script reported sixteen full-suite kills that were all that one test.
  const control = await runSuite(dir, FULL, 60_000);
  if (verdictOf(control.code, control.output) !== "survived")
    throw Error(`unchanged copy fails the full suite:\n${control.output}`);
  console.log("CONTROL: unchanged copy passes the full suite");
  for (const mutant of mutants) {
    const [name, file, from] = mutant;
    const n = occurrences(file, from);
    if (n !== 1) throw Error(`${name}: pattern matches ${n} places`);
    const filtered = await runMutant(dir, mutant);
    let { verdict } = filtered;
    let note = filtered.killedByTimer
      ? " (kill timer)"
      : filtered.failures.length
        ? ` by "${filtered.failures[0]}"`
        : "";
    if (verdict === "survived") {
      const full: Mutant = [name, file, from, mutant[3], FULL];
      const confirm = await runMutant(dir, full, 60_000);
      if (confirm.verdict !== "survived") {
        verdict = confirm.verdict;
        note = ` (survived the filter "${mutant[4]}"; ${confirm.verdict} by the full suite: "${confirm.failures[0] ?? "no test named"}")`;
      } else note = " (full suite)";
    }
    tally[verdict]++;
    console.log(`${verdict.toUpperCase()}: ${name}${note}`);
  }
  console.log(
    `REVIEW MUTANTS: ${tally.killed} killed, ${tally.survived} survived, ${tally.invalid} invalid of ${mutants.length}`,
  );
} finally {
  dispose(dir);
}
