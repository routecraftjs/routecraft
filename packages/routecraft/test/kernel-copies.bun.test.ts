import { expect, test } from "bun:test";
import { kernelCopies } from "../src/kernel/copies.ts";

const COPIES_KEY = Symbol.for("routecraft.kernel.copies");

/**
 * @case A second copy of the kernel registers itself
 * @preconditions This copy registered at load; a symbol standing for another copy is added under the shared key and removed again
 * @expectedResult The count is this copy alone before, two while the other is registered, and this copy alone after
 */
test("counts every copy of the kernel registered in the process", () => {
  const copies = (globalThis as { [COPIES_KEY]?: Set<symbol> })[COPIES_KEY];
  expect(copies).toBeInstanceOf(Set);
  const before = kernelCopies();
  expect(before).toBeGreaterThanOrEqual(1);
  const other = Symbol("routecraft.kernel.copy");
  copies!.add(other);
  try {
    expect(kernelCopies()).toBe(before + 1);
  } finally {
    copies!.delete(other);
  }
  expect(kernelCopies()).toBe(before);
});
