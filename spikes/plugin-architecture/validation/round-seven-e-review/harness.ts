/* eslint-disable no-console -- Executable review evidence. */
/**
 * Controls on the mutation harness itself, by execution. A harness that can
 * count a broken build as a kill inflates every figure it reports, so the
 * three failure shapes a mutant can take are each run through the real
 * discipline and the verdict is asserted: a parse error and a load error
 * must be INVALID, never killed; a pattern that no longer matches must throw
 * rather than silently run the unmutated copy. The last check reports every
 * mutant in the shipped list whose pattern matches more than once, because
 * `String.replace` edits the first occurrence and nothing verifies it is the
 * intended one.
 */
import { mutants } from "../round-two/mutants.ts";
import {
  disposableCopy,
  dispose,
  occurrences,
  runMutant,
  type Mutant,
} from "./runner.ts";

const controls: [expected: "invalid", label: string, mutant: Mutant][] = [
  [
    "invalid",
    "parse error in a kernel module",
    [
      "control: parse error",
      "codec.ts",
      "export const DATE_TAG =",
      "this is not typescript ( export const DATE_TAG =",
      "codec and pending",
    ],
  ],
  [
    "invalid",
    "load error (import of a missing export)",
    [
      "control: missing export",
      "codec.ts",
      'export const DATE_TAG = "$date";',
      'import { noSuchExport } from "./contracts.ts"; export const DATE_TAG = String(noSuchExport);',
      "codec and pending",
    ],
  ],
];

const dir = disposableCopy();
let failures = 0;
try {
  for (const [expected, label, mutant] of controls) {
    const started = Date.now();
    const { verdict, killedByTimer } = await runMutant(dir, mutant);
    const ok = verdict === expected;
    if (!ok) failures++;
    console.log(
      `${ok ? "HARNESS OK" : "HARNESS FAIL"}: ${label} -> ${verdict}${killedByTimer ? " (hung; classed by the kill timer)" : ""} in ${Date.now() - started}ms`,
    );
  }
  try {
    await runMutant(dir, [
      "control: stale pattern",
      "codec.ts",
      "this text is not in codec.ts",
      "irrelevant",
      "codec and pending",
    ]);
    failures++;
    console.log("HARNESS FAIL: a pattern that no longer matches did not throw");
  } catch (e) {
    console.log(`HARNESS OK: stale pattern throws: ${String(e)}`);
  }
  const ambiguous = mutants.filter(
    ([, file, from]) => occurrences(file, from) > 1,
  );
  for (const [name, file, from] of ambiguous)
    console.log(
      `AMBIGUOUS PATTERN: "${name}" matches ${occurrences(file, from)} places in ${file}; only the first is mutated`,
    );
  console.log(
    `HARNESS: ${controls.length + 1 - failures}/${controls.length + 1} controls hold; ${ambiguous.length}/${mutants.length} shipped mutants have an ambiguous pattern`,
  );
} finally {
  dispose(dir);
}
if (failures) process.exit(1);
