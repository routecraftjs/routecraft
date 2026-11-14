import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testContext } from "@routecraft/testing";
import {
  defaultLogger,
  DefaultExchange,
  craft,
  simple,
} from "@routecraft/routecraft";
import {
  childBindings,
  createLogger,
  flushLogger,
  logFileDiversion,
  serializeError,
  type Logger,
} from "../src/logger.ts";
import { loadOptionalPeerSync } from "../src/adapters/shared/optional-peer.ts";
import { ContextBuilder, direct, noop } from "../src/index.ts";

describe("logger", () => {
  const logger = defaultLogger();

  /**
   * @case Logger exports a pino-like instance with level methods and child
   * @preconditions None
   * @expectedResult logger has info, debug, warn, error, trace, fatal, child as functions
   */
  test("logger is a pino-like instance with level methods and child", () => {
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.debug).toBe("function");
    expect(typeof logger.warn).toBe("function");
    expect(typeof logger.error).toBe("function");
    expect(typeof logger.trace).toBe("function");
    expect(typeof logger.fatal).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  /**
   * @case logger.child returns a child logger with the same API
   * @preconditions None
   * @expectedResult child has info and child as functions
   */
  test("child returns a logger with the same API", () => {
    const child = logger.child({ contextId: "test-ctx" });
    expect(typeof child.info).toBe("function");
    expect(typeof child.child).toBe("function");
  });

  /**
   * @case childBindings for CraftContext returns contextId
   * @preconditions testContext with a route is built
   * @expectedResult bindings contain contextId matching ctx.contextId
   */
  test("childBindings for CraftContext returns contextId", async () => {
    const t = await testContext()
      .routes(craft().id("r").from(simple("x")))
      .build();
    const bindings = childBindings(t.ctx);
    expect(bindings).toHaveProperty("contextId", t.ctx.contextId);
  });

  /**
   * @case childBindings for Route returns contextId and routeId
   * @preconditions testContext with a named route is built
   * @expectedResult bindings contain contextId and routeId
   */
  test("childBindings for Route returns contextId and route", async () => {
    const t = await testContext()
      .routes(craft().id("my-route").from(simple("x")))
      .build();
    const route = t.ctx.getRoutes()[0];
    const bindings = childBindings(route);
    expect(bindings).toHaveProperty("contextId", t.ctx.contextId);
    expect(bindings).toHaveProperty("route", "my-route");
  });

  /**
   * @case childBindings for Exchange returns contextId, route, exchangeId, correlationId when exchange has internals
   * @preconditions DefaultExchange created with a context
   * @expectedResult bindings contain contextId, route, exchangeId, correlationId
   */
  test("childBindings for Exchange returns contextId, route, exchangeId, correlationId when exchange has internals", async () => {
    const t = await testContext()
      .routes(craft().id("r").from(simple("x")))
      .build();
    const ctx = t.ctx;
    const exchange = new DefaultExchange(ctx, { body: "test" });
    const bindings = childBindings(exchange);
    expect(bindings).toHaveProperty("contextId");
    expect(bindings).toHaveProperty("route");
    expect(bindings).toHaveProperty("exchangeId", exchange.id);
    expect(bindings).toHaveProperty("correlationId");
  });

  /**
   * @case childBindings omits service.name when no context name is configured
   * @preconditions testContext built without a `name`
   * @expectedResult bindings do not contain a service.name key
   */
  test("childBindings omits service.name when context has no name", async () => {
    const t = await testContext()
      .routes(craft().id("r").from(simple("x")))
      .build();
    // Array path form so the literal dotted key is not treated as a nested path.
    expect(childBindings(t.ctx)).not.toHaveProperty(["service.name"]);
  });

  /**
   * @case childBindings emits service.name for CraftContext, Route, and Exchange when a name is configured
   * @preconditions testContext built with `name: "eywa"` and a named route
   * @expectedResult context, route, and exchange bindings all contain service.name === "eywa"
   */
  test("childBindings emits configured name as service.name across context, route, and exchange", async () => {
    const t = await testContext()
      .with({ name: "eywa" })
      .routes(craft().id("zoe-mail").from(simple("x")))
      .build();
    const ctx = t.ctx;

    // Array path form so the literal dotted key is not treated as a nested path.
    expect(childBindings(ctx)).toHaveProperty(["service.name"], "eywa");

    const route = ctx.getRoutes()[0]!;
    expect(childBindings(route)).toHaveProperty(["service.name"], "eywa");

    const exchange = new DefaultExchange(ctx, { body: "test" });
    expect(childBindings(exchange)).toHaveProperty(["service.name"], "eywa");
  });
});

/**
 * What a reader sees in the log when an error carries a cause.
 *
 * `processError` wraps an arbitrary throw as `RC5001` and adopts the thrown
 * message as its own, keeping the original as the cause for its stack. pino
 * then appends the cause's message to a message that already is the cause,
 * so every adapter failure printed the same sentence twice.
 */
describe("serializeError", () => {
  /**
   * @case An error whose cause repeats its own message
   * @preconditions An Error whose message equals its cause's message, the
   *   shape `processError` produces when it wraps an arbitrary throw
   * @expectedResult The message is the sentence once, not twice
   */
  test("collapses a cause that only repeats the message", () => {
    const cause = new Error("upstream said no");
    const wrapped = new Error("upstream said no", { cause });
    const serialized = serializeError(wrapped) as { message: string };
    expect(serialized.message).toBe("upstream said no");
  });

  /**
   * @case An error whose cause says something the error does not
   * @preconditions An Error with a different message from its cause
   * @expectedResult Both halves survive, because together they say more
   */
  test("keeps a cause that adds something", () => {
    const cause = new Error("port 8080 in use");
    const wrapped = new Error("server bind failed", { cause });
    const serialized = serializeError(wrapped) as { message: string };
    expect(serialized.message).toBe("server bind failed: port 8080 in use");
  });

  /**
   * @case An error with no cause at all
   * @preconditions A plain Error
   * @expectedResult Its message is untouched
   */
  test("leaves an uncaused error alone", () => {
    const serialized = serializeError(new Error("plain")) as {
      message: string;
    };
    expect(serialized.message).toBe("plain");
  });

  /**
   * @case A cause that is not an Error
   * @preconditions An Error whose cause is a string
   * @expectedResult The serializer returns without touching the message,
   *   since there is no cause message to compare against
   */
  test("leaves a non-Error cause alone", () => {
    const wrapped = new Error("thrown", { cause: "a string" });
    const serialized = serializeError(wrapped) as { message: string };
    expect(serialized.message).toBe("thrown");
  });
});

describe("log file diversion", () => {
  /**
   * @case A log file whose basename is too long for the requested path and for the temp-dir fallback alike
   * @preconditions A fresh process building the default logger with LOG_FILE naming a 300-character basename and TMPDIR pointing at an empty directory
   * @expectedResult The process starts (the logs divert to stderr) and the temp directory is still empty: the private craft-log directory made for the fallback file is removed when that file cannot be opened either
   */
  test("a fallback that fails leaves no directory behind", () => {
    const temp = mkdtempSync(join(tmpdir(), "craft-log-test-"));
    mkdirSync(join(temp, "tmp"));
    try {
      const outcome = spawnSync(
        process.execPath,
        [
          "-e",
          `const { defaultLogger } = await import(${JSON.stringify(join(import.meta.dir, "../src/logger.ts"))}); defaultLogger();`,
        ],
        {
          cwd: temp,
          env: {
            ...process.env,
            TMPDIR: join(temp, "tmp"),
            LOG_FILE: join(temp, "logs", `${"a".repeat(300)}.log`),
          },
          encoding: "utf8",
        },
      );
      expect(outcome.status).toBe(0);
      expect(readdirSync(join(temp, "tmp"))).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

describe("createLogger", () => {
  const inTemp = async (run: (dir: string) => Promise<void> | void) => {
    const dir = mkdtempSync(join(tmpdir(), "craft-logger-test-"));
    try {
      await run(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const linesOf = (file: string) =>
    readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  /**
   * @case A logger built from options alone
   * @preconditions `createLogger({ level: "info", file })`, one line below the level and one at it
   * @expectedResult The file holds the one line at info as NDJSON with a level label, written by the time the call returns
   */
  test("writes NDJSON to the named file at the named level", () =>
    inTemp((dir) => {
      const file = join(dir, "app.log");
      const logger = createLogger({ level: "info", file });

      logger.debug("hidden");
      logger.info({ n: 1 }, "shown");

      expect(linesOf(file)).toMatchObject([
        { level: "info", msg: "shown", n: 1 },
      ]);
    }));

  /**
   * @case A route logs the headers of an exchange that carries credentials
   * @preconditions `createLogger({ file, redact: ["secret"] })` as the context's root; a `.log()` with the exchange's headers and a `secret` field
   * @expectedResult The four credential headers and the configured path are redacted, an ordinary header is not: a configured path adds to the default list
   */
  test("redacts the credential headers by default, and what it is told to", () =>
    inTemp(async (dir) => {
      const file = join(dir, "app.log");
      const { context, client } = await new ContextBuilder()
        .with({
          logger: createLogger({ level: "info", file, redact: ["secret"] }),
        })
        .routes(
          craft()
            .id("redacted")
            .from(direct())
            .log("info", "Seen", (ex) => ({ headers: ex.headers, secret: "s" }))
            .to(noop()),
        )
        .build();
      const running = context.start();
      try {
        await context.whenStarted();
        await client.sendDirect(
          "redacted",
          {},
          {
            authorization: "Bearer token",
            cookie: "session=1",
            "set-cookie": "session=2",
            "proxy-authorization": "Basic abc",
            "x-request-id": "r-1",
          },
        );
      } finally {
        await context.stop();
        await running;
      }

      const line = linesOf(file).find((entry) => entry["msg"] === "Seen");
      expect(line).toMatchObject({
        secret: "[Redacted]",
        headers: {
          authorization: "[Redacted]",
          cookie: "[Redacted]",
          "set-cookie": "[Redacted]",
          "proxy-authorization": "[Redacted]",
          "x-request-id": "r-1",
        },
      });
    }));
});

describe("defaultLogger", () => {
  const run = (script: string, cwd: string, env: Record<string, string>) =>
    spawnSync(process.execPath, ["-e", script], {
      cwd,
      env: { ...process.env, NODE_ENV: "production", ...env },
      encoding: "utf8",
    });
  const core = JSON.stringify(join(import.meta.dir, "../src/index.ts"));
  const inTemp = (check: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "craft-default-logger-test-"));
    try {
      check(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  /**
   * @case Importing the package builds no logger
   * @preconditions A fresh process with LOG_FILE set that imports core, then calls `defaultLogger()` twice
   * @expectedResult The log file does not exist after the import and does after the first call, and both calls return one logger
   */
  test("is built on first use, once", () =>
    inTemp((dir) => {
      const outcome = run(
        `const { existsSync } = await import("node:fs");
         const core = await import(${core});
         const before = existsSync("app.log");
         const same = core.defaultLogger() === core.defaultLogger();
         console.log(JSON.stringify({ before, same, after: existsSync("app.log") }));`,
        dir,
        { LOG_FILE: "app.log" },
      );

      expect(outcome.stderr).toBe("");
      expect(JSON.parse(outcome.stdout)).toEqual({
        before: false,
        same: true,
        after: true,
      });
    }));

  /**
   * @case An application that configured its own logger
   * @preconditions A fresh process with LOG_FILE set, a context built on a logger of its own, one exchange with a `.log()` line, then a stop
   * @expectedResult The application's logger has the line and the log file was never created: nothing reached the default logger
   */
  test("is never built when a root is configured", () =>
    inTemp((dir) => {
      const outcome = run(
        `const { existsSync } = await import("node:fs");
         const core = await import(${core});
         const messages = [];
         const record = (first, second) => messages.push(second ?? first);
         const root = { child: () => root, isLevelEnabled: () => true, trace: record, debug: record, info: record, warn: record, error: record, fatal: record };
         const { context, client } = await new core.ContextBuilder()
           .with({ logger: root })
           .routes(core.craft().id("own").from(core.direct()).log("info", "Seen").to(core.noop()))
           .build();
         const running = context.start();
         await context.whenStarted();
         await client.sendDirect("own", {});
         await context.stop();
         await running;
         console.log(JSON.stringify({ seen: messages.includes("Seen"), file: existsSync("app.log") }));`,
        dir,
        { LOG_FILE: "app.log" },
      );

      expect(outcome.stderr).toBe("");
      expect(JSON.parse(outcome.stdout)).toEqual({ seen: true, file: false });
    }));

  /**
   * @case What craft.log.cjs may set
   * @preconditions A craft.log.cjs with level, file, redact and two pino options it has no business setting
   * @expectedResult The three settings apply and the rest is ignored: the level label and the message key stay Routecraft's
   */
  test("reads level, file and redact from craft.log and nothing else", () =>
    inTemp((dir) => {
      writeFileSync(
        join(dir, "craft.log.cjs"),
        `module.exports = { level: "debug", file: "from-config.log", redact: ["token"], messageKey: "message", base: null };`,
      );
      const outcome = run(
        `const { defaultLogger } = await import(${core});
         defaultLogger().debug({ token: "t" }, "configured");`,
        dir,
        {},
      );

      expect(outcome.stderr).toBe("");
      const line = JSON.parse(
        readFileSync(join(dir, "from-config.log"), "utf8"),
      ) as Record<string, unknown>;
      expect(line).toMatchObject({
        level: "debug",
        msg: "configured",
        token: "[Redacted]",
      });
      expect(line["pid"]).toBeNumber();
    }));

  /**
   * @case LOG_LEVEL names no level
   * @preconditions A fresh process with LOG_LEVEL=verbose that logs at warn and at info
   * @expectedResult The process says so on stderr and carries on at the default level, warn, instead of failing at its first log line
   */
  test("reports a level that is no level and keeps the default", () =>
    inTemp((dir) => {
      const outcome = run(
        `const { defaultLogger } = await import(${core});
         defaultLogger().info("quiet");
         defaultLogger().warn("loud");`,
        dir,
        { LOG_LEVEL: "verbose" },
      );

      expect(outcome.status).toBe(0);
      expect(outcome.stderr).toContain("LOG_LEVEL must be one of");
      expect(outcome.stdout).toContain('"msg":"loud"');
      expect(outcome.stdout).not.toContain('"msg":"quiet"');
      expect(existsSync(join(dir, "app.log"))).toBe(false);
    }));
});

describe("loadOptionalPeerSync", () => {
  /**
   * @case A peer that is not installed, loaded synchronously
   * @preconditions A thunk that throws what `require` throws for an absent package, and one that throws something else
   * @expectedResult The first becomes RC5017 naming the package and how to install it; the second is rethrown as it is
   */
  test("turns an absent peer into RC5017 and leaves other failures alone", () => {
    const absent = Object.assign(
      new Error("Cannot find module 'pino-pretty'"),
      {
        code: "MODULE_NOT_FOUND",
      },
    );
    const broken = new Error("native binding crashed");
    const load = (cause: Error) => () =>
      loadOptionalPeerSync(
        () => {
          throw cause;
        },
        { consumer: "pretty log output", packageName: "pino-pretty" },
      );

    expect(load(absent)).toThrow(
      expect.objectContaining({
        rc: "RC5017",
        message: expect.stringContaining("bun add pino-pretty") as string,
      }),
    );
    expect(load(broken)).toThrow(broken);
    expect(
      loadOptionalPeerSync(() => 42, { consumer: "x", packageName: "y" }),
    ).toBe(42);
  });
});

describe("a createLogger file that cannot be opened", () => {
  /**
   * @case An application builds a logger on a file under a path that is a regular file
   * @preconditions `createLogger({ file })` where the file's parent is itself a file, so it cannot be created
   * @expectedResult The call returns a working logger, and the default logger's diversion record is left alone: that record is the CLI's, about its own setting
   */
  test("diverts without touching the default logger's record", () => {
    const dir = mkdtempSync(join(tmpdir(), "craft-logger-test-"));
    try {
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "");
      const before = logFileDiversion();

      const logger = createLogger({ file: join(blocker, "app.log") });

      expect(() => logger.info("still writes")).not.toThrow();
      expect(logFileDiversion()).toBe(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("flushLogger", () => {
  const silent = (flush: Logger["flush"]): Logger => {
    const logger: Logger = {
      child: () => logger,
      isLevelEnabled: () => false,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      fatal: () => {},
      ...(flush !== undefined ? { flush } : {}),
    };
    return logger;
  };

  /**
   * @case A logger whose flush takes a callback, as pino's does
   * @preconditions A flush that calls its callback on a later tick and returns nothing
   * @expectedResult The wait ends only after the callback ran
   */
  test("waits for a callback-style flush", async () => {
    let flushed = false;
    const logger = silent((done) => {
      setTimeout(() => {
        flushed = true;
        done?.();
      }, 5);
    });

    await flushLogger(logger);

    expect(flushed).toBe(true);
  });

  /**
   * @case A logger whose flush returns a promise, one whose flush is synchronous, one whose flush throws, and one without a flush
   * @preconditions Four loggers, one of each shape
   * @expectedResult Each wait resolves; the promise one only after it settled, and the throw is swallowed
   */
  test("waits for a promise, and never fails over a flush", async () => {
    let settled = false;
    const promised = silent(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      settled = true;
    });
    let ran = false;

    await flushLogger(promised);
    await flushLogger(
      silent(() => {
        ran = true;
      }),
    );
    await flushLogger(
      silent(() => {
        throw new Error("the sink is gone");
      }),
    );
    await flushLogger(silent(undefined));

    expect(settled).toBe(true);
    expect(ran).toBe(true);
  });
});
