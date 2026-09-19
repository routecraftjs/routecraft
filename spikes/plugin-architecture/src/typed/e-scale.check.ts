// Generated stress fixture: 40 independently installed generic method families.
import {
  from,
  operations,
  type Extension,
  type MethodFamily,
  type Chain,
  type Cursor,
} from "./e-installed.ts";
type M0<B, P extends readonly Extension[]> = { op0(): Chain<B, P> };
interface F0 extends MethodFamily {
  readonly methods: M0<this["Body"], this["Plugins"]>;
}
const p0: Extension<F0> = {
  name: "p0",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M0<B, P> => ({ op0: () => host.keep(() => true) }),
};
type M1<B, P extends readonly Extension[]> = { op1(): Chain<B, P> };
interface F1 extends MethodFamily {
  readonly methods: M1<this["Body"], this["Plugins"]>;
}
const p1: Extension<F1> = {
  name: "p1",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M1<B, P> => ({ op1: () => host.keep(() => true) }),
};
type M2<B, P extends readonly Extension[]> = { op2(): Chain<B, P> };
interface F2 extends MethodFamily {
  readonly methods: M2<this["Body"], this["Plugins"]>;
}
const p2: Extension<F2> = {
  name: "p2",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M2<B, P> => ({ op2: () => host.keep(() => true) }),
};
type M3<B, P extends readonly Extension[]> = { op3(): Chain<B, P> };
interface F3 extends MethodFamily {
  readonly methods: M3<this["Body"], this["Plugins"]>;
}
const p3: Extension<F3> = {
  name: "p3",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M3<B, P> => ({ op3: () => host.keep(() => true) }),
};
type M4<B, P extends readonly Extension[]> = { op4(): Chain<B, P> };
interface F4 extends MethodFamily {
  readonly methods: M4<this["Body"], this["Plugins"]>;
}
const p4: Extension<F4> = {
  name: "p4",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M4<B, P> => ({ op4: () => host.keep(() => true) }),
};
type M5<B, P extends readonly Extension[]> = { op5(): Chain<B, P> };
interface F5 extends MethodFamily {
  readonly methods: M5<this["Body"], this["Plugins"]>;
}
const p5: Extension<F5> = {
  name: "p5",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M5<B, P> => ({ op5: () => host.keep(() => true) }),
};
type M6<B, P extends readonly Extension[]> = { op6(): Chain<B, P> };
interface F6 extends MethodFamily {
  readonly methods: M6<this["Body"], this["Plugins"]>;
}
const p6: Extension<F6> = {
  name: "p6",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M6<B, P> => ({ op6: () => host.keep(() => true) }),
};
type M7<B, P extends readonly Extension[]> = { op7(): Chain<B, P> };
interface F7 extends MethodFamily {
  readonly methods: M7<this["Body"], this["Plugins"]>;
}
const p7: Extension<F7> = {
  name: "p7",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M7<B, P> => ({ op7: () => host.keep(() => true) }),
};
type M8<B, P extends readonly Extension[]> = { op8(): Chain<B, P> };
interface F8 extends MethodFamily {
  readonly methods: M8<this["Body"], this["Plugins"]>;
}
const p8: Extension<F8> = {
  name: "p8",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M8<B, P> => ({ op8: () => host.keep(() => true) }),
};
type M9<B, P extends readonly Extension[]> = { op9(): Chain<B, P> };
interface F9 extends MethodFamily {
  readonly methods: M9<this["Body"], this["Plugins"]>;
}
const p9: Extension<F9> = {
  name: "p9",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M9<B, P> => ({ op9: () => host.keep(() => true) }),
};
type M10<B, P extends readonly Extension[]> = { op10(): Chain<B, P> };
interface F10 extends MethodFamily {
  readonly methods: M10<this["Body"], this["Plugins"]>;
}
const p10: Extension<F10> = {
  name: "p10",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M10<B, P> => ({ op10: () => host.keep(() => true) }),
};
type M11<B, P extends readonly Extension[]> = { op11(): Chain<B, P> };
interface F11 extends MethodFamily {
  readonly methods: M11<this["Body"], this["Plugins"]>;
}
const p11: Extension<F11> = {
  name: "p11",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M11<B, P> => ({ op11: () => host.keep(() => true) }),
};
type M12<B, P extends readonly Extension[]> = { op12(): Chain<B, P> };
interface F12 extends MethodFamily {
  readonly methods: M12<this["Body"], this["Plugins"]>;
}
const p12: Extension<F12> = {
  name: "p12",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M12<B, P> => ({ op12: () => host.keep(() => true) }),
};
type M13<B, P extends readonly Extension[]> = { op13(): Chain<B, P> };
interface F13 extends MethodFamily {
  readonly methods: M13<this["Body"], this["Plugins"]>;
}
const p13: Extension<F13> = {
  name: "p13",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M13<B, P> => ({ op13: () => host.keep(() => true) }),
};
type M14<B, P extends readonly Extension[]> = { op14(): Chain<B, P> };
interface F14 extends MethodFamily {
  readonly methods: M14<this["Body"], this["Plugins"]>;
}
const p14: Extension<F14> = {
  name: "p14",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M14<B, P> => ({ op14: () => host.keep(() => true) }),
};
type M15<B, P extends readonly Extension[]> = { op15(): Chain<B, P> };
interface F15 extends MethodFamily {
  readonly methods: M15<this["Body"], this["Plugins"]>;
}
const p15: Extension<F15> = {
  name: "p15",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M15<B, P> => ({ op15: () => host.keep(() => true) }),
};
type M16<B, P extends readonly Extension[]> = { op16(): Chain<B, P> };
interface F16 extends MethodFamily {
  readonly methods: M16<this["Body"], this["Plugins"]>;
}
const p16: Extension<F16> = {
  name: "p16",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M16<B, P> => ({ op16: () => host.keep(() => true) }),
};
type M17<B, P extends readonly Extension[]> = { op17(): Chain<B, P> };
interface F17 extends MethodFamily {
  readonly methods: M17<this["Body"], this["Plugins"]>;
}
const p17: Extension<F17> = {
  name: "p17",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M17<B, P> => ({ op17: () => host.keep(() => true) }),
};
type M18<B, P extends readonly Extension[]> = { op18(): Chain<B, P> };
interface F18 extends MethodFamily {
  readonly methods: M18<this["Body"], this["Plugins"]>;
}
const p18: Extension<F18> = {
  name: "p18",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M18<B, P> => ({ op18: () => host.keep(() => true) }),
};
type M19<B, P extends readonly Extension[]> = { op19(): Chain<B, P> };
interface F19 extends MethodFamily {
  readonly methods: M19<this["Body"], this["Plugins"]>;
}
const p19: Extension<F19> = {
  name: "p19",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M19<B, P> => ({ op19: () => host.keep(() => true) }),
};
type M20<B, P extends readonly Extension[]> = { op20(): Chain<B, P> };
interface F20 extends MethodFamily {
  readonly methods: M20<this["Body"], this["Plugins"]>;
}
const p20: Extension<F20> = {
  name: "p20",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M20<B, P> => ({ op20: () => host.keep(() => true) }),
};
type M21<B, P extends readonly Extension[]> = { op21(): Chain<B, P> };
interface F21 extends MethodFamily {
  readonly methods: M21<this["Body"], this["Plugins"]>;
}
const p21: Extension<F21> = {
  name: "p21",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M21<B, P> => ({ op21: () => host.keep(() => true) }),
};
type M22<B, P extends readonly Extension[]> = { op22(): Chain<B, P> };
interface F22 extends MethodFamily {
  readonly methods: M22<this["Body"], this["Plugins"]>;
}
const p22: Extension<F22> = {
  name: "p22",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M22<B, P> => ({ op22: () => host.keep(() => true) }),
};
type M23<B, P extends readonly Extension[]> = { op23(): Chain<B, P> };
interface F23 extends MethodFamily {
  readonly methods: M23<this["Body"], this["Plugins"]>;
}
const p23: Extension<F23> = {
  name: "p23",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M23<B, P> => ({ op23: () => host.keep(() => true) }),
};
type M24<B, P extends readonly Extension[]> = { op24(): Chain<B, P> };
interface F24 extends MethodFamily {
  readonly methods: M24<this["Body"], this["Plugins"]>;
}
const p24: Extension<F24> = {
  name: "p24",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M24<B, P> => ({ op24: () => host.keep(() => true) }),
};
type M25<B, P extends readonly Extension[]> = { op25(): Chain<B, P> };
interface F25 extends MethodFamily {
  readonly methods: M25<this["Body"], this["Plugins"]>;
}
const p25: Extension<F25> = {
  name: "p25",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M25<B, P> => ({ op25: () => host.keep(() => true) }),
};
type M26<B, P extends readonly Extension[]> = { op26(): Chain<B, P> };
interface F26 extends MethodFamily {
  readonly methods: M26<this["Body"], this["Plugins"]>;
}
const p26: Extension<F26> = {
  name: "p26",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M26<B, P> => ({ op26: () => host.keep(() => true) }),
};
type M27<B, P extends readonly Extension[]> = { op27(): Chain<B, P> };
interface F27 extends MethodFamily {
  readonly methods: M27<this["Body"], this["Plugins"]>;
}
const p27: Extension<F27> = {
  name: "p27",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M27<B, P> => ({ op27: () => host.keep(() => true) }),
};
type M28<B, P extends readonly Extension[]> = { op28(): Chain<B, P> };
interface F28 extends MethodFamily {
  readonly methods: M28<this["Body"], this["Plugins"]>;
}
const p28: Extension<F28> = {
  name: "p28",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M28<B, P> => ({ op28: () => host.keep(() => true) }),
};
type M29<B, P extends readonly Extension[]> = { op29(): Chain<B, P> };
interface F29 extends MethodFamily {
  readonly methods: M29<this["Body"], this["Plugins"]>;
}
const p29: Extension<F29> = {
  name: "p29",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M29<B, P> => ({ op29: () => host.keep(() => true) }),
};
type M30<B, P extends readonly Extension[]> = { op30(): Chain<B, P> };
interface F30 extends MethodFamily {
  readonly methods: M30<this["Body"], this["Plugins"]>;
}
const p30: Extension<F30> = {
  name: "p30",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M30<B, P> => ({ op30: () => host.keep(() => true) }),
};
type M31<B, P extends readonly Extension[]> = { op31(): Chain<B, P> };
interface F31 extends MethodFamily {
  readonly methods: M31<this["Body"], this["Plugins"]>;
}
const p31: Extension<F31> = {
  name: "p31",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M31<B, P> => ({ op31: () => host.keep(() => true) }),
};
type M32<B, P extends readonly Extension[]> = { op32(): Chain<B, P> };
interface F32 extends MethodFamily {
  readonly methods: M32<this["Body"], this["Plugins"]>;
}
const p32: Extension<F32> = {
  name: "p32",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M32<B, P> => ({ op32: () => host.keep(() => true) }),
};
type M33<B, P extends readonly Extension[]> = { op33(): Chain<B, P> };
interface F33 extends MethodFamily {
  readonly methods: M33<this["Body"], this["Plugins"]>;
}
const p33: Extension<F33> = {
  name: "p33",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M33<B, P> => ({ op33: () => host.keep(() => true) }),
};
type M34<B, P extends readonly Extension[]> = { op34(): Chain<B, P> };
interface F34 extends MethodFamily {
  readonly methods: M34<this["Body"], this["Plugins"]>;
}
const p34: Extension<F34> = {
  name: "p34",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M34<B, P> => ({ op34: () => host.keep(() => true) }),
};
type M35<B, P extends readonly Extension[]> = { op35(): Chain<B, P> };
interface F35 extends MethodFamily {
  readonly methods: M35<this["Body"], this["Plugins"]>;
}
const p35: Extension<F35> = {
  name: "p35",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M35<B, P> => ({ op35: () => host.keep(() => true) }),
};
type M36<B, P extends readonly Extension[]> = { op36(): Chain<B, P> };
interface F36 extends MethodFamily {
  readonly methods: M36<this["Body"], this["Plugins"]>;
}
const p36: Extension<F36> = {
  name: "p36",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M36<B, P> => ({ op36: () => host.keep(() => true) }),
};
type M37<B, P extends readonly Extension[]> = { op37(): Chain<B, P> };
interface F37 extends MethodFamily {
  readonly methods: M37<this["Body"], this["Plugins"]>;
}
const p37: Extension<F37> = {
  name: "p37",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M37<B, P> => ({ op37: () => host.keep(() => true) }),
};
type M38<B, P extends readonly Extension[]> = { op38(): Chain<B, P> };
interface F38 extends MethodFamily {
  readonly methods: M38<this["Body"], this["Plugins"]>;
}
const p38: Extension<F38> = {
  name: "p38",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M38<B, P> => ({ op38: () => host.keep(() => true) }),
};
type M39<B, P extends readonly Extension[]> = { op39(): Chain<B, P> };
interface F39 extends MethodFamily {
  readonly methods: M39<this["Body"], this["Plugins"]>;
}
const p39: Extension<F39> = {
  name: "p39",
  create: <B, P extends readonly Extension[]>(
    host: Cursor<B, P>,
  ): M39<B, P> => ({ op39: () => host.keep(() => true) }),
};
export const scaled = from({ subject: "hello" }, [
  operations,
  p0,
  p1,
  p2,
  p3,
  p4,
  p5,
  p6,
  p7,
  p8,
  p9,
  p10,
  p11,
  p12,
  p13,
  p14,
  p15,
  p16,
  p17,
  p18,
  p19,
  p20,
  p21,
  p22,
  p23,
  p24,
  p25,
  p26,
  p27,
  p28,
  p29,
  p30,
  p31,
  p32,
  p33,
  p34,
  p35,
  p36,
  p37,
  p38,
  p39,
])
  .transform((x) => x.subject)
  .op0()
  .op1()
  .op2()
  .op3()
  .op4()
  .op5()
  .op6()
  .op7()
  .op8()
  .op9()
  .op10()
  .op11()
  .op12()
  .op13()
  .op14()
  .op15()
  .op16()
  .op17()
  .op18()
  .op19()
  .op20()
  .op21()
  .op22()
  .op23()
  .op24()
  .op25()
  .op26()
  .op27()
  .op28()
  .op29()
  .op30()
  .op31()
  .op32()
  .op33()
  .op34()
  .op35()
  .op36()
  .op37()
  .op38()
  .op39()
  .transform((x) => x.length);
export const check: Promise<number> = scaled.run();
