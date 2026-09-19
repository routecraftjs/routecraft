import {
  builder,
  type StepDef,
  type StepSig,
  type TypedPlugin,
} from "./e-hkt.ts";
import type { Exchange } from "../../plugin-architecture/src/contracts/index.ts";
interface S0 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S1 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S2 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S3 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S4 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S5 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S6 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S7 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S8 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S9 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S10 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S11 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S12 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S13 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S14 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S15 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S16 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S17 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S18 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S19 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S20 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S21 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S22 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S23 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S24 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S25 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S26 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S27 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S28 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S29 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S30 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S31 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S32 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S33 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S34 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S35 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S36 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S37 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S38 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}
interface S39 extends StepSig {
  readonly params: [fn: (body: this["Body"]) => unknown];
  readonly out: this["Args"] extends readonly [(body: never) => infer R]
    ? R
    : never;
}

export const forty = {
  id: "scale",
  steps: {
    op0: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op0",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S0>["make"],
    } as StepDef<S0>,
    op1: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op1",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S1>["make"],
    } as StepDef<S1>,
    op2: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op2",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S2>["make"],
    } as StepDef<S2>,
    op3: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op3",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S3>["make"],
    } as StepDef<S3>,
    op4: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op4",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S4>["make"],
    } as StepDef<S4>,
    op5: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op5",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S5>["make"],
    } as StepDef<S5>,
    op6: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op6",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S6>["make"],
    } as StepDef<S6>,
    op7: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op7",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S7>["make"],
    } as StepDef<S7>,
    op8: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op8",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S8>["make"],
    } as StepDef<S8>,
    op9: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op9",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S9>["make"],
    } as StepDef<S9>,
    op10: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op10",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S10>["make"],
    } as StepDef<S10>,
    op11: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op11",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S11>["make"],
    } as StepDef<S11>,
    op12: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op12",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S12>["make"],
    } as StepDef<S12>,
    op13: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op13",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S13>["make"],
    } as StepDef<S13>,
    op14: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op14",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S14>["make"],
    } as StepDef<S14>,
    op15: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op15",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S15>["make"],
    } as StepDef<S15>,
    op16: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op16",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S16>["make"],
    } as StepDef<S16>,
    op17: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op17",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S17>["make"],
    } as StepDef<S17>,
    op18: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op18",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S18>["make"],
    } as StepDef<S18>,
    op19: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op19",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S19>["make"],
    } as StepDef<S19>,
    op20: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op20",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S20>["make"],
    } as StepDef<S20>,
    op21: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op21",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S21>["make"],
    } as StepDef<S21>,
    op22: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op22",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S22>["make"],
    } as StepDef<S22>,
    op23: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op23",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S23>["make"],
    } as StepDef<S23>,
    op24: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op24",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S24>["make"],
    } as StepDef<S24>,
    op25: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op25",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S25>["make"],
    } as StepDef<S25>,
    op26: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op26",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S26>["make"],
    } as StepDef<S26>,
    op27: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op27",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S27>["make"],
    } as StepDef<S27>,
    op28: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op28",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S28>["make"],
    } as StepDef<S28>,
    op29: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op29",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S29>["make"],
    } as StepDef<S29>,
    op30: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op30",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S30>["make"],
    } as StepDef<S30>,
    op31: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op31",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S31>["make"],
    } as StepDef<S31>,
    op32: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op32",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S32>["make"],
    } as StepDef<S32>,
    op33: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op33",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S33>["make"],
    } as StepDef<S33>,
    op34: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op34",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S34>["make"],
    } as StepDef<S34>,
    op35: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op35",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S35>["make"],
    } as StepDef<S35>,
    op36: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op36",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S36>["make"],
    } as StepDef<S36>,
    op37: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op37",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S37>["make"],
    } as StepDef<S37>,
    op38: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op38",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S38>["make"],
    } as StepDef<S38>,
    op39: {
      make: ((fn: (b: unknown) => unknown) => ({
        label: "op39",
        run: (ex: Exchange) => void (ex.body = fn(ex.body)),
      })) as StepDef<S39>["make"],
    } as StepDef<S39>,
  },
} as const satisfies TypedPlugin;
const big = builder<readonly [typeof forty], { seed: string }>([forty]);
const c0 = big;
const c1 = c0.op0((b) => ({ n: 0, prev: b }));
const c2 = c1.op1((b) => ({ n: 1, prev: b }));
const c3 = c2.op2((b) => ({ n: 2, prev: b }));
const c4 = c3.op3((b) => ({ n: 3, prev: b }));
const c5 = c4.op4((b) => ({ n: 4, prev: b }));
const c6 = c5.op5((b) => ({ n: 5, prev: b }));
const c7 = c6.op6((b) => ({ n: 6, prev: b }));
const c8 = c7.op7((b) => ({ n: 7, prev: b }));
const c9 = c8.op8((b) => ({ n: 8, prev: b }));
const c10 = c9.op9((b) => ({ n: 9, prev: b }));
const c11 = c10.op10((b) => ({ n: 10, prev: b }));
const c12 = c11.op11((b) => ({ n: 11, prev: b }));
const c13 = c12.op12((b) => ({ n: 12, prev: b }));
const c14 = c13.op13((b) => ({ n: 13, prev: b }));
const c15 = c14.op14((b) => ({ n: 14, prev: b }));
const c16 = c15.op15((b) => ({ n: 15, prev: b }));
const c17 = c16.op16((b) => ({ n: 16, prev: b }));
const c18 = c17.op17((b) => ({ n: 17, prev: b }));
const c19 = c18.op18((b) => ({ n: 18, prev: b }));
const c20 = c19.op19((b) => ({ n: 19, prev: b }));
const c21 = c20.op20((b) => ({ n: 20, prev: b }));
const c22 = c21.op21((b) => ({ n: 21, prev: b }));
const c23 = c22.op22((b) => ({ n: 22, prev: b }));
const c24 = c23.op23((b) => ({ n: 23, prev: b }));
const c25 = c24.op24((b) => ({ n: 24, prev: b }));
const c26 = c25.op25((b) => ({ n: 25, prev: b }));
const c27 = c26.op26((b) => ({ n: 26, prev: b }));
const c28 = c27.op27((b) => ({ n: 27, prev: b }));
const c29 = c28.op28((b) => ({ n: 28, prev: b }));
const c30 = c29.op29((b) => ({ n: 29, prev: b }));
const c31 = c30.op30((b) => ({ n: 30, prev: b }));
const c32 = c31.op31((b) => ({ n: 31, prev: b }));
const c33 = c32.op32((b) => ({ n: 32, prev: b }));
const c34 = c33.op33((b) => ({ n: 33, prev: b }));
const c35 = c34.op34((b) => ({ n: 34, prev: b }));
const c36 = c35.op35((b) => ({ n: 35, prev: b }));
const c37 = c36.op36((b) => ({ n: 36, prev: b }));
const c38 = c37.op37((b) => ({ n: 37, prev: b }));
const c39 = c38.op38((b) => ({ n: 38, prev: b }));
const c40 = c39.op39((b) => ({ n: 39, prev: b }));

type Expect2<T extends true> = T;
type NotUnknown<T> = unknown extends T ? false : true;
export type DeepBodyStillFlows = Expect2<
  NotUnknown<ReturnType<typeof c40.bodyType>>
>;
export const deepField: number = c40.bodyType().prev.prev.prev.n;
export const last = c40;
