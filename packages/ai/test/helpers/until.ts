/**
 * Wait for a condition, bounded, so a test that never settles reports as an
 * assertion rather than as a timeout with nothing named.
 *
 * One copy for the package. Three files held their own before, and they had
 * already drifted on the one thing that matters least visibly, the bound, so
 * the same wait meant different things in adjacent files.
 */

import { expect } from "bun:test";

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function until(
  condition: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition()) && Date.now() < deadline) await sleep(1);
  expect(await condition()).toBe(true);
}
