import type { AfterTransform } from "./a-naive.ts";

/**
 * Compile-time assertion that encoding A fails, so the failure is checked
 * rather than claimed. If a future TypeScript fixes the limitation, this
 * line starts erroring and tells us to revisit.
 */
type Expect<T extends true> = T;
type IsUnknown<T> = unknown extends T
  ? T extends unknown
    ? true
    : false
  : false;

export type EncodingAErasesTheBodyType = Expect<IsUnknown<AfterTransform>>;
