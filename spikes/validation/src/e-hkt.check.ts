/**
 * Compile-time arbitration of encoding E against F8's four columns.
 * Every line here is checked by `tsc`, not asserted in prose.
 */
import { builder, deferral, operations } from "./e-hkt.ts";

type Expect<T extends true> = T;
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

const b = builder<
  readonly [typeof operations, typeof deferral],
  { subject: string; size: number }
>([operations, deferral]);

// FLUENT: one chain, no pipe, no free functions.
const afterTransform = b.transform((mail) => mail.subject);
const afterFilter = afterTransform.filter((subject) => subject.length > 0);
const afterHeader = afterFilter.header("x-seen", "1");
const afterSecond = afterHeader.transform((subject) => subject.length);
export const afterDefer = afterSecond.defer("needs approval");

// BODY TYPE FLOWS, with every lambda parameter inferred and never annotated.
export type T1 = Expect<
  Equals<ReturnType<typeof afterTransform.bodyType>, string>
>;
export type T2 = Expect<
  Equals<ReturnType<typeof afterFilter.bodyType>, string>
>;
export type T3 = Expect<
  Equals<ReturnType<typeof afterHeader.bodyType>, string>
>;
export type T4 = Expect<
  Equals<ReturnType<typeof afterSecond.bodyType>, number>
>;
export type T5 = Expect<Equals<ReturnType<typeof afterDefer.bodyType>, number>>;

// The incoming body is visible to the lambda without annotation.
export const inferredParam = b.transform((mail) => mail.size * 2);
export type T6 = Expect<
  Equals<ReturnType<typeof inferredParam.bodyType>, number>
>;

// PLUGIN-EXTENSIBLE: a stranger's plugin, no core change, no augmentation.
import type { StepDef, StepSig, TypedPlugin } from "./e-hkt.ts";
import type { Exchange } from "../../plugin-architecture/src/contracts/index.ts";

interface RedactSig extends StepSig {
  readonly params: [fields: readonly (keyof this["Body"])[]];
  readonly out: this["Body"];
}

export const acmeRedact = {
  id: "acme.redact",
  steps: {
    redact: {
      make: ((fields: readonly string[]) => ({
        label: "redact",
        run: (ex: Exchange) => {
          for (const f of fields)
            delete (ex.body as Record<string, unknown>)[f];
        },
      })) as StepDef<RedactSig>["make"],
    } as StepDef<RedactSig>,
  },
} as const satisfies TypedPlugin;

const withStranger = builder<
  readonly [typeof operations, typeof acmeRedact],
  { subject: string; size: number }
>([operations, acmeRedact]);

// The stranger's step is typed AGAINST THE CURRENT BODY: `keyof Body`.
export const redacted = withStranger.redact(["subject"]);
export type T7 = Expect<
  Equals<
    ReturnType<typeof redacted.bodyType>,
    { subject: string; size: number }
  >
>;

// SOUND, part 1: a step from a declined plugin is not on the builder.
const withoutDeferral = builder<
  readonly [typeof operations],
  { subject: string }
>([operations]);
// @ts-expect-error `defer` belongs to the deferral plugin, which is declined.
withoutDeferral.defer("nope");

// SOUND, part 2: there is no way to declare a step without implementing it.
// `steps` is a value; its keys ARE the runtime registry's keys. The defect
// candidate B and encoding C both have is not expressible here.

// SOUND, part 3: a wrong argument is rejected against the CURRENT body.
// @ts-expect-error "size" is not a key of the body after `.transform` made it a string.
withStranger.transform((mail) => mail.subject).redact(["size"]);

// @ts-expect-error `header` takes two strings, not one.
b.header("x-only-one");
