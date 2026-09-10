import { afterEach, describe, expect, test } from "bun:test";
import { testContext, type TestContext } from "@routecraft/testing";
import { HttpMountRegistry } from "../src/plugins/server/registry.ts";
import {
  requestValidationFailure,
  resolveAllowedHostnames,
  resolveRequestValidation,
} from "../src/plugins/server/request-validation.ts";
import { serversPlugin } from "../src/plugins/server/plugin.ts";

const policy = resolveRequestValidation({});
const trusted = resolveAllowedHostnames(["public.example"]);
/** Check an authority against a fixed policy without browser admission. */
function check(host: string | undefined, bound = "127.0.0.1") {
  return requestValidationFailure(
    new Request("http://public.example/mcp", {
      headers: host === undefined ? {} : { Host: host },
    }),
    bound,
    trusted,
    policy,
  );
}

describe("protocol request validation", () => {
  /**
   * @case Host must be an unambiguous HTTP authority and cannot be replaced by request URL
   * @preconditions Trusted request URL and missing, malformed or foreign Host headers
   * @expectedResult Every invalid authority fails closed, including URL and forwarding-shaped inputs
   */
  test("rejects missing and malformed Host", () => {
    for (const host of [
      undefined,
      "",
      "evil.example",
      "public.example,evil.example",
      "evil.example@public.example",
      "public.example/path",
      "public.example?x",
      "public.example#x",
      "public.example\\evil",
      "%70ublic.example",
      "public.example:65536",
      "public.example:",
      "public.example:abc",
    ]) {
      expect(check(host)).toBe("host");
    }
  });

  /**
   * @case Loopback aliases, IPv6 and exact configured hosts work without Origin
   * @preconditions Loopback or wildcard binds and explicit public hostnames
   * @expectedResult Local aliases work on local binds; unrelated binds gain no loopback trust
   */
  test("accepts trusted hosts and bounded loopback aliases", () => {
    for (const bound of [
      "127.0.0.1",
      "localhost",
      "::1",
      "[::1]",
      "0.0.0.0",
      "::",
      "[::]",
    ]) {
      for (const host of [
        "localhost:8080",
        "127.0.0.1:80",
        "[::1]:8080",
        "PUBLIC.EXAMPLE:443",
        "public.example.",
      ]) {
        expect(check(host, bound)).toBeUndefined();
      }
      expect(check("evil.example", bound)).toBe("host");
    }
    expect(check("192.168.1.10:8080", "192.168.1.10")).toBeUndefined();
    expect(check("localhost", "192.168.1.10")).toBe("host");
    expect(check("[2001:db8::1]:8080", "2001:db8::1")).toBeUndefined();
  });

  /**
   * @case Trusted hostnames cannot be configured as URLs, wildcards or authorities with ports
   * @preconditions Invalid values in the server configuration
   * @expectedResult Construction fails with RC5003 naming the server configuration path before a listener can start
   */
  test("rejects malformed hostname configuration eagerly", () => {
    for (const host of [
      "",
      "*",
      "*.example",
      "https://public.example",
      "public.example/path",
      "public.example:443",
      "[::1]:8080",
      "user@public.example",
    ]) {
      let failure: unknown;
      try {
        serversPlugin({ public: { port: 0, allowedHostnames: [host] } });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({
        rc: "RC5003",
        message: expect.stringContaining("servers.public.allowedHostnames"),
      });
    }
    expect([
      ...resolveAllowedHostnames(["PUBLIC.EXAMPLE", "::1", "[::1]"]),
    ]).toEqual(["public.example", "[::1]"]);
  });

  /**
   * @case Browser permission is an exact serialized HTTP(S) origin
   * @preconditions Valid configured browser origin and malformed or nonmatching request origins
   * @expectedResult Only exact scheme, host and port match is admitted; wildcards and null are refused at configuration
   */
  test("validates and matches browser origins exactly", () => {
    for (const origin of [
      "*",
      "null",
      "",
      "https://browser.example/",
      "https://user@browser.example",
      "https://browser.example/path",
      "file://local",
      "https://browser.example:443",
    ]) {
      expect(() =>
        resolveRequestValidation({ browserOrigins: [origin] }),
      ).toThrow(/browserOrigins/);
    }
    const browser = resolveRequestValidation({
      browserOrigins: ["https://browser.example:8443"],
    });
    for (const origin of [
      "https://browser.example",
      "http://browser.example:8443",
      "null",
      "https://browser.example:8443/path",
    ]) {
      expect(
        requestValidationFailure(
          new Request("http://localhost/mcp", {
            headers: { Host: "localhost", Origin: origin },
          }),
          "127.0.0.1",
          trusted,
          browser,
        ),
      ).toBe("origin");
    }
    expect(
      requestValidationFailure(
        new Request("http://localhost/mcp", {
          headers: {
            Host: "localhost",
            Origin: "https://browser.example:8443",
          },
        }),
        "127.0.0.1",
        trusted,
        browser,
      ),
    ).toBeUndefined();
  });
});

describe("request validation in the registry", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    await t?.stop();
    t = undefined;
  });

  /**
   * @case Policy is snapshotted and an unregistered mount stops dispatching
   * @preconditions A protected mount with mutable input arrays and a later unmount
   * @expectedResult Mutating the original config grants nothing; unmount stops dispatch; rejection emits bounded event data
   */
  test("snapshots policies and clears them on unmount", async () => {
    const events: unknown[] = [];
    t = await testContext()
      .on("server:request:rejected", ({ details }) => {
        events.push(details);
      })
      .build();
    const registry = new HttpMountRegistry("default", t.ctx);
    const browserOrigins = ["https://browser.example"];
    const allowedHostnames = ["public.example"];
    const unmount = registry.mountHttp({
      id: "protocol",
      requestValidation: { browserOrigins, allowedHostnames },
      claims: () => [{ kind: "exact", path: "/protocol" }],
      handler: () => new Response("ok"),
    });
    registry.setBoundAddress("127.0.0.1", 8080);
    browserOrigins.push("https://evil.example");
    allowedHostnames.push("evil.example");
    registry.validate();
    const denied = await registry.dispatch(
      new Request("http://localhost/protocol", {
        headers: { Host: "evil.example" },
      }),
    );
    expect(denied.status).toBe(403);
    expect(events).toEqual([
      { server: "default", mount: "protocol", reason: "host" },
    ]);
    expect(
      (
        await registry.dispatch(
          new Request("http://localhost/protocol", {
            headers: { Host: "public.example", Origin: "https://evil.example" },
          }),
        )
      ).status,
    ).toBe(403);
    unmount();
    expect(
      (await registry.dispatch(new Request("http://localhost/protocol")))
        .status,
    ).toBe(404);
  });
});
