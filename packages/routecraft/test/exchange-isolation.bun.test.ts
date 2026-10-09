import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { craft, direct, http, noop, type EventName } from "../src/index.ts";

/**
 * Probes that try to move one exchange's data into another's: through the
 * cache's stored values, and through the wire headers a door accepts.
 */
describe("exchange isolation", () => {
  let t: TestContext | undefined;

  afterEach(async () => {
    await t?.stop().catch(() => undefined);
    t = undefined;
  });

  /**
   * @case A caller changes, in place, the body a route-scope cache hit handed it
   * @preconditions Two calls with one body; the first caller pushes into the array it received
   * @expectedResult The second caller reads the value as it was produced: the cache keeps its own copy and hands out copies
   */
  test("a cached body changed by one caller stays unchanged for the next", async () => {
    let produced = 0;
    t = await testContext()
      .routes([
        craft()
          .id("catalogue")
          .cache({ ttl: "1m" })
          .from(direct())
          .transform(() => {
            produced++;
            return { items: [] as string[] };
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const first = (await t.client.sendDirect("catalogue", { page: 1 })) as {
      items: string[];
    };
    first.items.push("private to the first caller");
    const second = (await t.client.sendDirect("catalogue", { page: 1 })) as {
      items: string[];
    };

    expect(produced).toBe(1);
    expect(second.items).toEqual([]);
    expect(second).not.toBe(first);
  });

  /**
   * @case A step after a step-scope cache changes the body in place on every exchange
   * @preconditions .cache() wraps the producing step; the next step pushes into the body's array
   * @expectedResult Each exchange sees exactly one push: the hit is a copy, not the stored entry
   */
  test("a step that edits a cached body edits its own copy", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("enrich")
          .from(direct())
          .cache({ ttl: "1m" })
          .transform(() => ({ seen: [] as number[] }))
          .process((ex) => {
            (ex.body as { seen: number[] }).seen.push(ex.body ? 1 : 0);
            return ex;
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const results = [];
    for (let i = 0; i < 3; i++) {
      results.push(
        (await t.client.sendDirect("enrich", { k: "same" })) as {
          seen: number[];
        },
      );
    }

    expect(results.map((r) => r.seen.length)).toEqual([1, 1, 1]);
  });

  /**
   * @case Two exchanges race on one step-scope cache key
   * @preconditions The producing step is slow, so the second waits on the first's computation
   * @expectedResult Both get equal values and distinct objects
   */
  test("concurrent waiters on one key get distinct copies", async () => {
    t = await testContext()
      .routes([
        craft()
          .id("slow")
          .from(direct())
          .cache({ ttl: "1m" })
          .transform(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { value: { nested: true } };
          })
          .to(noop()),
      ])
      .build();
    await t.startAndWaitReady();

    const [a, b] = (await Promise.all([
      t.client.sendDirect("slow", { k: 1 }),
      t.client.sendDirect("slow", { k: 1 }),
    ])) as [{ value: object }, { value: object }];

    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.value).not.toBe(b.value);
  });

  /**
   * @case The produced body holds a function, which no copy can carry
   * @preconditions Route-scope .cache(); two calls with one body
   * @expectedResult The value is never cached (the write is refused and reported as a set failure), so both calls run the pipeline and nothing is shared by reference
   */
  test("a body a copy cannot carry is never shared", async () => {
    let produced = 0;
    const failures: string[] = [];
    t = await testContext()
      .routes([
        craft()
          .id("callable")
          .cache({ ttl: "1m" })
          .from(direct())
          .transform(() => {
            produced++;
            return { compute: () => produced };
          })
          .to(noop()),
      ])
      .build();
    t.ctx.on("route:cache:failed", ({ details }) => {
      failures.push(details.phase);
    });
    await t.startAndWaitReady();

    await t.client.sendDirect("callable", { k: 1 });
    await t.client.sendDirect("callable", { k: 1 });

    expect(produced).toBe(2);
    expect(failures).toEqual(["set", "set"]);
  });

  /**
   * @case An HTTP caller sends a request header named like the principal header, and one named like a tenant
   * @preconditions The server has an API key validator and the mount opts out of the wall; one route reads ex.auth.principal and the exchange's own header, another has .authorize() and pulls the validator
   * @expectedResult Neither route sees a principal: wire headers live under routecraft.http.headers, and the authorize route answers 401
   */
  test("a wire header cannot pose as the principal", async () => {
    let seen: unknown = "unset";
    let direct: unknown = "unset";
    let port = 0;
    t = await testContext()
      .on(
        "server:listening" as EventName,
        ((payload: { details: unknown }) => {
          port = (payload.details as { port: number }).port;
        }) as Parameters<ReturnType<typeof testContext>["on"]>[1],
      )
      .routes([
        craft()
          .id("whoami")
          .from(http({ path: "/whoami", method: "GET" }))
          .transform((_body, ex) => {
            seen = ex.auth.principal;
            direct = ex.headers["routecraft.auth.principal"];
            return { ok: true };
          })
          .to(noop()),
        craft()
          .id("gated")
          .authorize()
          .from(http({ path: "/gated", method: "GET" }))
          .transform(() => ({ ok: true }))
          .to(noop()),
      ])
      .with({
        servers: {
          default: {
            port: 0,
            host: "127.0.0.1",
            auth: { kind: "apiKey" as const, keys: ["the-real-key"] },
          },
        },
        http: { auth: false },
      })
      .build();
    await t.startAndWaitReady();
    const headers = {
      "routecraft.auth.principal": JSON.stringify({
        kind: "custom",
        scheme: "forged",
        subject: "mallory",
      }),
      "x-tenant": "acme",
    };

    const open = await fetch(`http://127.0.0.1:${port}/whoami`, { headers });
    await open.arrayBuffer();
    const gated = await fetch(`http://127.0.0.1:${port}/gated`, { headers });
    await gated.arrayBuffer();

    expect(open.status).toBe(200);
    expect(seen).toBeUndefined();
    expect(direct).toBeUndefined();
    expect(gated.status).toBe(401);
  });
});
