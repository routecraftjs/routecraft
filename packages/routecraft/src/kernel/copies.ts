/**
 * How many copies of this package have loaded in the process.
 *
 * Each copy registers a symbol of its own under one registered key when it
 * loads, so the count is per module instance: the ESM and CJS builds of one
 * install count as two, as do two installs. Ports resolve across copies,
 * since a port's key is the registered symbol for its name, but the
 * bindings a door trusts for a refusal (`RC5068`, `RC5065`, `RC5049`,
 * `RC5038`) are module-local, so a refusal raised by one copy is answered
 * by a door of the other as a plain failure. The context warns at build
 * when it finds more than one copy.
 */

const COPIES_KEY = Symbol.for("routecraft.kernel.copies");
const THIS_COPY = Symbol("routecraft.kernel.copy");

type GlobalWithCopies = typeof globalThis & {
  [COPIES_KEY]?: Set<symbol>;
};

const copies = ((globalThis as GlobalWithCopies)[COPIES_KEY] ??=
  new Set<symbol>());
copies.add(THIS_COPY);

/** The number of copies of the kernel loaded in this process, this one included. */
export function kernelCopies(): number {
  return copies.size;
}
