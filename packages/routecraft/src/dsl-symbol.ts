/**
 * Symbol used by registerDsl to access the builder's internal addStep method.
 * Defined in a separate module to avoid circular imports between builder.ts
 * and dsl.ts.
 */
export const PUSH_STEP: unique symbol = Symbol.for(
  "routecraft.builder.pushStep",
);
