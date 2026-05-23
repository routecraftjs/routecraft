/**
 * Dot-path utilities shared by the `mask` and `keep` transform helpers so
 * both address nested fields ("review.rating") the same way. All writers are
 * immutable: they clone along the touched path and leave the input untouched,
 * matching the framework's exchange-immutability contract.
 *
 * @internal
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the value at a dot path, or `undefined` if any segment is missing. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Whether every segment of a dot path is an own key down the chain. */
export function hasPath(obj: unknown, path: string): boolean {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (!isRecord(cur) || !(seg in cur)) return false;
    cur = cur[seg];
  }
  return true;
}

/** Return a copy of `obj` with the value at the dot path replaced. */
export function setPath<T>(obj: T, path: string, value: unknown): T {
  const [head, ...rest] = path.split(".");
  const base: Record<string, unknown> = isRecord(obj) ? obj : {};
  if (rest.length === 0) {
    return { ...base, [head]: value } as T;
  }
  return { ...base, [head]: setPath(base[head], rest.join("."), value) } as T;
}

/** Return a copy of `obj` with the value at the dot path removed. */
export function deletePath<T>(obj: T, path: string): T {
  const [head, ...rest] = path.split(".");
  if (!isRecord(obj) || !(head in obj)) return obj;
  const clone: Record<string, unknown> = { ...obj };
  if (rest.length === 0) {
    delete clone[head];
  } else {
    clone[head] = deletePath(clone[head], rest.join("."));
  }
  return clone as T;
}

/** Build a new object containing only the given dot paths from `obj`. */
export function pickPaths<T>(obj: T, paths: string[]): T {
  let out = {} as T;
  for (const path of paths) {
    if (hasPath(obj, path)) out = setPath(out, path, getPath(obj, path));
  }
  return out;
}
