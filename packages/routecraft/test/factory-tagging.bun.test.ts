import { describe, expect, test } from "bun:test";
import {
  cron,
  csv,
  debug,
  direct,
  event,
  file,
  group,
  html,
  http,
  json,
  jsonl,
  log,
  mail,
  noop,
  simple,
  timer,
} from "../src/index.ts";
import {
  getAdapterArgs,
  getAdapterFactory,
} from "../src/adapters/shared/factory-tag.ts";

/**
 * Conformance suite: every public adapter factory must stamp the instances
 * it returns with `tagAdapter(instance, factory, factoryArgs(...))` so the
 * testing override API (`mockAdapter(factory, ...)`) can resolve mocks by
 * factory reference. An ESLint rule cannot soundly verify this (factories
 * may construct through helpers or multiple branches), so this test calls
 * each factory and asserts the tag round-trips.
 */

/** One representative invocation per factory return path. */
const cases: Array<{
  name: string;
  factory: unknown;
  make: () => unknown;
  args: unknown[];
}> = [
  { name: "simple", factory: simple, make: () => simple("x"), args: ["x"] },
  {
    name: "simple.value",
    factory: simple.value,
    make: () => simple.value(42),
    args: [42],
  },
  { name: "timer", factory: timer, make: () => timer(), args: [] },
  {
    name: "cron",
    factory: cron,
    make: () => cron("@daily"),
    args: ["@daily"],
  },
  { name: "log", factory: log, make: () => log(), args: [] },
  { name: "debug", factory: debug, make: () => debug(), args: [] },
  { name: "noop", factory: noop, make: () => noop(), args: [] },
  {
    name: "direct (source)",
    factory: direct,
    make: () => direct(),
    args: [],
  },
  {
    name: "direct (destination)",
    factory: direct,
    make: () => direct("target"),
    args: ["target"],
  },
  {
    name: "event",
    factory: event,
    make: () => event("route:started"),
    args: ["route:started"],
  },
  {
    name: "group",
    factory: group,
    make: () => group({ comparator: { compare: () => true } }),
    args: [{ comparator: expect.anything() }],
  },
  {
    name: "http (source)",
    factory: http,
    make: () => http({ path: "/x", method: "GET" }),
    args: [{ path: "/x", method: "GET" }],
  },
  {
    name: "http (destination)",
    factory: http,
    make: () => http({ url: "https://example.com", method: "GET" }),
    args: [{ url: "https://example.com", method: "GET" }],
  },
  // json/csv/jsonl default `options = {}` before factoryArgs, so a
  // zero-arg call records the defaulted empty object (existing behavior).
  { name: "json", factory: json, make: () => json(), args: [{}] },
  { name: "csv", factory: csv, make: () => csv(), args: [{}] },
  { name: "jsonl", factory: jsonl, make: () => jsonl(), args: [{}] },
  {
    name: "html",
    factory: html,
    make: () => html({ selector: "a" }),
    args: [{ selector: "a" }],
  },
  {
    name: "file",
    factory: file,
    make: () => file({ path: "/tmp/x" }),
    args: [{ path: "/tmp/x" }],
  },
  {
    name: "mail (source)",
    factory: mail,
    make: () => mail("INBOX", {}),
    args: ["INBOX", {}],
  },
];

describe("adapter factory tagging conformance", () => {
  for (const c of cases) {
    /**
     * @case Factory `${c.name}` tags its instances with itself
     * @preconditions Factory invoked with representative args
     * @expectedResult getAdapterFactory(instance) returns the factory and
     *   getAdapterArgs(instance) returns the trimmed call args
     */
    test(`${c.name} tags instances with the factory reference`, () => {
      const instance = c.make();
      expect(getAdapterFactory(instance)).toBe(c.factory as never);
      expect(getAdapterArgs(instance)).toEqual(c.args);
    });
  }
});
