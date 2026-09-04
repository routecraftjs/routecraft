import { afterEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import type { Exchange } from "@routecraft/routecraft";
import { DefaultExchange, ContextBuilder } from "@routecraft/routecraft";
import { shell } from "@routecraft/os";
import {
  containerSpec,
  createDockerTier,
  type ContainerCreateOptions,
  type DockerClient,
  type DockerContainer,
  type StdinWriter,
} from "../src/adapters/shell/isolation/docker.ts";
import { resolveIsolation } from "../src/adapters/shell/isolation/index.ts";
import type {
  ExecutionIo,
  IsolationRequest,
} from "../src/adapters/shell/isolation/types.ts";

/**
 * The docker tier without a daemon: what it asks the daemon for, and how
 * it drives a container, proven against a fake client that records every
 * call. What the daemon then does with the specification is the smoke
 * suite's business (`shell-docker.integration.test.ts`).
 */

const exchange = {} as Exchange<unknown>;
const target = { file: "sh", args: ["-lc", "echo hi"] };
const request: IsolationRequest = { network: false, mapRootUser: false };
const io: ExecutionIo = {
  env: { PATH: "/usr/bin", HOME: "/tmp/h" },
  maxOutputBytes: 1024,
  defaultName: "rc-route-ex1",
};

/** A container whose every call is recorded, with scripted exit behaviour. */
function fakeContainer(options: {
  exitCode?: number;
  /** Resolve `wait` only when the test says so. */
  hold?: boolean;
  stdout?: string;
}): {
  container: DockerContainer;
  calls: string[];
  stdoutText: string | undefined;
  exit: (code: number) => void;
} {
  const calls: string[] = [];
  let exit!: (code: number) => void;
  const exited = new Promise<{ StatusCode: number }>((resolve) => {
    exit = (code) => resolve({ StatusCode: code });
  });
  const container: DockerContainer = {
    id: "c1",
    async attach(opts) {
      calls.push(
        `attach:${opts.stdout ? "out" : ""}${opts.stderr ? "err" : ""}`,
      );
      return new PassThrough();
    },
    async start() {
      calls.push("start");
      if (!options.hold) exit(options.exitCode ?? 0);
    },
    async wait(opts) {
      calls.push(`wait:${opts.condition}`);
      return exited;
    },
    async kill(opts) {
      calls.push(`kill:${opts?.signal ?? "default"}`);
      exit(137);
    },
    async remove() {
      calls.push("remove");
    },
  };
  return { container, calls, stdoutText: options.stdout, exit };
}

function fakeClient(
  fake: ReturnType<typeof fakeContainer>,
  behaviour: {
    ping?: () => Promise<unknown>;
    create?: (o: ContainerCreateOptions) => Promise<DockerContainer>;
  } = {},
): { client: DockerClient; created: ContainerCreateOptions[] } {
  const created: ContainerCreateOptions[] = [];
  return {
    created,
    client: {
      ping: behaviour.ping ?? (async () => "OK"),
      createContainer: async (opts) => {
        created.push(opts);
        return behaviour.create ? behaviour.create(opts) : fake.container;
      },
      modem: {
        socketPath: "/var/run/docker.sock",
        demuxStream(_stream, stdout) {
          if (fake.stdoutText !== undefined) stdout.write(fake.stdoutText);
        },
      },
    },
  };
}

/** A stdin writer that records what it was asked to deliver. */
function recordingStdin(): {
  writer: StdinWriter;
  fed: Array<{ id: string; bytes: string }>;
} {
  const fed: Array<{ id: string; bytes: string }> = [];
  return {
    fed,
    writer: async (_connection, id, bytes) => {
      fed.push({ id, bytes: Buffer.from(bytes).toString() });
    },
  };
}

afterEach(() => {
  delete process.env["ROUTECRAFT_SHELL_ISOLATION"];
});

describe("the container specification", () => {
  /**
   * @case The command is an argument vector and the image is one field
   * @preconditions A target with arguments and an image reference that looks like a flag
   * @expectedResult Cmd is the file followed by its arguments unchanged, Image is the value verbatim, and no field carries it anywhere else, so an image from data cannot smuggle an option
   */
  test("passes the command as argv and the image as one field", () => {
    const spec = containerSpec(target, request, io, "alpine:3.20 --privileged");
    expect(spec.Cmd).toEqual(["sh", "-lc", "echo hi"]);
    expect(spec.Image).toBe("alpine:3.20 --privileged");
    expect(JSON.stringify(spec.HostConfig)).not.toContain("privileged");
  });

  /**
   * @case Egress is denied unless granted, as on every tier
   * @preconditions The same spec with network false and with network true
   * @expectedResult NetworkMode is none by default and bridge when granted
   */
  test("denies the network by default", () => {
    expect(
      containerSpec(target, request, io, "img").HostConfig.NetworkMode,
    ).toBe("none");
    expect(
      containerSpec(target, { ...request, network: true }, io, "img").HostConfig
        .NetworkMode,
    ).toBe("bridge");
  });

  /**
   * @case Mounts are the declared list and nothing else, read-only when asked
   * @preconditions Two mounts, one read-only
   * @expectedResult Binds carries exactly the two, with :ro on the read-only one, and the container removes itself on exit
   */
  test("binds exactly the declared mounts", () => {
    const spec = containerSpec(
      target,
      {
        ...request,
        mounts: [
          { host: "/work/s1", container: "/workspace" },
          { host: "/opt/cache", container: "/cache", readonly: true },
        ],
      },
      io,
      "img",
    );
    expect(spec.HostConfig.Binds).toEqual([
      "/work/s1:/workspace",
      "/opt/cache:/cache:ro",
    ]);
    expect(spec.HostConfig.AutoRemove).toBe(true);
    expect(spec.HostConfig.Init).toBe(true);
  });

  /**
   * @case Identity is the caller's unless root is asked for
   * @preconditions The default mapping and mapRootUser true, on a POSIX host
   * @expectedResult User is the process's uid:gid by default and 0:0 when root is asked for
   */
  test("runs as the caller unless root is asked for", () => {
    if (typeof process.getuid !== "function") return;
    expect(containerSpec(target, request, io, "img").User).toBe(
      `${process.getuid()}:${process.getgid!()}`,
    );
    expect(
      containerSpec(target, { ...request, mapRootUser: true }, io, "img").User,
    ).toBe("0:0");
  });

  /**
   * @case The environment, the working directory, the name and stdin land where the daemon reads them
   * @preconditions io with env, cwd and stdin; a request with and without a name
   * @expectedResult Env is KEY=VALUE pairs, WorkingDir is cwd, the name is the request's or the default, and stdin opens the input only when bytes were given
   */
  test("maps env, cwd, name and stdin onto the specification", () => {
    const withStdin = containerSpec(
      target,
      { ...request, name: "build-7" },
      { ...io, cwd: "/workspace", stdin: Buffer.from("token") },
      "img",
    );
    expect(withStdin.Env).toEqual(["PATH=/usr/bin", "HOME=/tmp/h"]);
    expect(withStdin.WorkingDir).toBe("/workspace");
    expect(withStdin.name).toBe("build-7");
    expect(withStdin.OpenStdin).toBe(true);
    expect(withStdin.StdinOnce).toBe(true);
    expect(withStdin.AttachStdin).toBe(true);
    const without = containerSpec(target, request, io, "img");
    expect(without.name).toBe("rc-route-ex1");
    expect(without.OpenStdin).toBe(false);
    expect(without.WorkingDir).toBeUndefined();
    expect(without.Tty).toBe(false);
  });
});

describe("driving a container", () => {
  /**
   * @case A run attaches output, feeds stdin to the created container, waits before starting, and reports the exit code and output
   * @preconditions A fake container that exits 0 on start and writes "hi" to stdout; a recording stdin writer
   * @expectedResult The output attach and wait(next-exit) precede start, the stdin bytes are delivered to the container by id, and the outcome carries exit 0, the output and no signal
   */
  test("runs a command to completion", async () => {
    const fake = fakeContainer({ stdout: "hi\n" });
    const { client, created } = fakeClient(fake);
    const stdin = recordingStdin();
    const tier = createDockerTier(async () => client, stdin.writer);
    const outcome = await tier.execute!(
      target,
      { ...request, image: "alpine:3.20" },
      { ...io, stdin: Buffer.from("secret") },
    );
    expect(created).toHaveLength(1);
    expect(fake.calls).toEqual(["attach:outerr", "wait:next-exit", "start"]);
    expect(stdin.fed).toEqual([{ id: "c1", bytes: "secret" }]);
    expect(outcome).toMatchObject({
      exitCode: 0,
      timedOut: false,
      stdout: { text: "hi\n", truncated: false },
    });
    expect(outcome.signal).toBeUndefined();
  });

  /**
   * @case A container that fails to start is removed rather than left holding its name
   * @preconditions A fake container whose start rejects
   * @expectedResult execute rejects with the start failure and remove(force) was called
   */
  test("removes a container that failed to start", async () => {
    const fake = fakeContainer({});
    fake.container.start = async () => {
      throw new Error("start refused");
    };
    const tier = createDockerTier(async () => fakeClient(fake).client);
    await expect(
      tier.execute!(target, { ...request, image: "img" }, io),
    ).rejects.toThrow(/start refused/);
    expect(fake.calls).toContain("remove");
  });

  /**
   * @case Without stdin nothing is attached to the container's input
   * @preconditions The same run with no stdin
   * @expectedResult The stdin writer is never called
   */
  test("does not touch stdin when none was given", async () => {
    const fake = fakeContainer({});
    const stdin = recordingStdin();
    const tier = createDockerTier(
      async () => fakeClient(fake).client,
      stdin.writer,
    );
    await tier.execute!(target, { ...request, image: "img" }, io);
    expect(stdin.fed).toEqual([]);
  });

  /**
   * @case A timeout stops the container and is reported the way the host tiers report one
   * @preconditions A fake container that never exits on its own and a 20ms timeout
   * @expectedResult kill(SIGTERM) is sent when the timeout elapses and the outcome says timedOut with signal SIGTERM and the killed exit code
   */
  test("kills the container on timeout", async () => {
    const fake = fakeContainer({ hold: true });
    const tier = createDockerTier(async () => fakeClient(fake).client);
    const outcome = await tier.execute!(
      target,
      { ...request, image: "img" },
      { ...io, timeoutMs: 20 },
    );
    expect(fake.calls).toContain("kill:SIGTERM");
    expect(outcome.timedOut).toBe(true);
    expect(outcome.signal).toBe("SIGTERM");
    expect(outcome.exitCode).toBe(137);
  });

  /**
   * @case Cancellation from the route kills the container at once
   * @preconditions A held container and an abort signal fired after the start
   * @expectedResult kill(SIGKILL) is sent and the outcome is not a timeout
   */
  test("kills the container when the route cancels", async () => {
    const fake = fakeContainer({ hold: true });
    const tier = createDockerTier(async () => fakeClient(fake).client);
    const controller = new AbortController();
    const run = tier.execute!(
      target,
      { ...request, image: "img" },
      { ...io, signal: controller.signal },
    );
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const outcome = await run;
    expect(fake.calls).toContain("kill:SIGKILL");
    expect(outcome.timedOut).toBe(false);
    expect(outcome.signal).toBe("SIGKILL");
  });

  /**
   * @case No daemon is a loud OS1001 naming the tier and the ways out
   * @preconditions A client whose ping is refused
   * @expectedResult ensureAvailable rejects with OS1001 mentioning docker, DOCKER_HOST and the unshare alternative; a later probe retries rather than caching the failure
   */
  test("an absent daemon is OS1001", async () => {
    let pings = 0;
    const { client } = fakeClient(fakeContainer({}), {
      ping: async () => {
        pings += 1;
        throw new Error("connect ENOENT /var/run/docker.sock");
      },
    });
    const tier = createDockerTier(async () => client);
    await expect(tier.ensureAvailable()).rejects.toMatchObject({
      rc: "OS1001",
    });
    await expect(tier.ensureAvailable()).rejects.toThrow(
      /DOCKER_HOST.*unshare/,
    );
    expect(pings).toBe(2);
  });

  /**
   * @case A missing image is OS1002 naming the image and the pull, never a pull
   * @preconditions createContainer answers 404
   * @expectedResult execute rejects with OS1002 whose message names the image and `docker pull`
   */
  test("a missing image is named, not pulled", async () => {
    const { client } = fakeClient(fakeContainer({}), {
      create: async () => {
        const err = new Error("(HTTP code 404) no such image") as Error & {
          statusCode: number;
        };
        err.statusCode = 404;
        throw err;
      },
    });
    const tier = createDockerTier(async () => client);
    await expect(
      tier.execute!(target, { ...request, image: "ghcr.io/x/y:1" }, io),
    ).rejects.toMatchObject({ rc: "OS1002" });
    await expect(
      tier.execute!(target, { ...request, image: "ghcr.io/x/y:1" }, io),
    ).rejects.toThrow(/docker pull ghcr\.io\/x\/y:1/);
  });

  /**
   * @case The tier refuses to run with no image rather than guess one
   * @preconditions A request without image
   * @expectedResult execute rejects with RC5003 naming image and saying there is no default
   */
  test("no image is a configuration error", async () => {
    const tier = createDockerTier(
      async () => fakeClient(fakeContainer({})).client,
    );
    await expect(tier.execute!(target, request, io)).rejects.toThrow(
      /needs an image.*no default/,
    );
  });
});

describe("the docker tier in the precedence chain", () => {
  /**
   * @case docker is a tier the chain resolves at every layer
   * @preconditions Named per call, by the environment override, and by plugin default
   * @expectedResult Each resolves to the docker tier, and a per-call unshare still beats an environment docker
   */
  test("resolves at every layer", () => {
    expect(resolveIsolation("docker", undefined).name).toBe("docker");
    expect(resolveIsolation(undefined, "docker").name).toBe("docker");
    process.env["ROUTECRAFT_SHELL_ISOLATION"] = "docker";
    expect(resolveIsolation(undefined, "none").name).toBe("docker");
    expect(resolveIsolation("unshare", undefined).name).toBe("unshare");
  });
});

describe("container options on a host tier", () => {
  /**
   * @case A host tier refuses image, mounts and name rather than dropping them
   * @preconditions The none tier with egress accepted and each container option set in turn
   * @expectedResult OS1004 naming the option, the tier the call ran under and the docker remedy
   */
  test("the none tier refuses container options", async () => {
    for (const option of [
      { image: "alpine" },
      { mounts: [{ host: "/a", container: "/b" }] },
      { name: "x" },
    ]) {
      await expect(
        shell("true", [], {
          isolation: "none",
          network: true,
          ...option,
        }).fetch(exchange),
      ).rejects.toMatchObject({ rc: "OS1004" });
      await expect(
        shell("true", [], {
          isolation: "none",
          network: true,
          ...option,
        }).fetch(exchange),
      ).rejects.toThrow(/docker tier option.*"none" tier/);
    }
  });

  /**
   * @case A malformed container option is refused before any tier sees it
   * @preconditions A relative mount path, an empty image, and a name outside the daemon's charset
   * @expectedResult Each rejects with RC5003 naming the option
   */
  test("malformed container options are RC5003", async () => {
    const run = (options: Record<string, unknown>) =>
      shell("true", [], { isolation: "none", network: true, ...options }).fetch(
        exchange,
      );
    await expect(
      run({ mounts: [{ host: "work", container: "/w" }] }),
    ).rejects.toThrow(/absolute paths/);
    await expect(run({ image: "" })).rejects.toThrow(/"image" must resolve/);
    await expect(run({ name: "-bad name" })).rejects.toThrow(
      /"name" must match/,
    );
  });
});

describe("options resolved per exchange on a host tier", () => {
  let built: Awaited<ReturnType<ContextBuilder["build"]>> | undefined;
  afterEach(async () => {
    await built?.context.stop();
    built = undefined;
  });

  async function exchangeWith<T>(body: T): Promise<Exchange<T>> {
    built ??= await new ContextBuilder().routes([]).build();
    return new DefaultExchange<T>(built.context, { body });
  }

  /**
   * @case stdin reaches the command and only the command
   * @preconditions cat with a secret on stdin, static and then resolved from the exchange
   * @expectedResult stdout is the secret, the argument vector never carried it, and a Uint8Array is written as bytes
   */
  test("stdin is written and closed before the command reads", async () => {
    const fixed = await shell("cat", [], {
      isolation: "none",
      network: true,
      stdin: "s3cret\n",
    }).fetch(exchange);
    expect(fixed.stdout).toBe("s3cret\n");
    const ex = await exchangeWith({ token: "from-body" });
    const resolved = await shell<{ token: string }>("cat", [], {
      isolation: "none",
      network: true,
      stdin: (e) => Buffer.from(e.body.token),
    }).fetch(ex);
    expect(resolved.stdout).toBe("from-body");
  });

  /**
   * @case Two exchanges through one step get different deadlines
   * @preconditions One shell step whose timeout resolves from the body; one exchange asks for 50ms around a 2s sleep, the other for 5s
   * @expectedResult The first fails with OS1003 and the second completes, from the same adapter instance
   */
  test("timeout resolves per exchange", async () => {
    const step = shell<{ ms: string }>("sleep", ["0.3"], {
      isolation: "none",
      network: true,
      failOnNonZero: false,
      timeout: (e) => e.body.ms as `${number}ms`,
    });
    await expect(
      step.fetch(await exchangeWith({ ms: "50ms" })),
    ).rejects.toMatchObject({
      rc: "OS1003",
    });
    const ok = await step.fetch(await exchangeWith({ ms: "5s" }));
    expect(ok.exitCode).toBe(0);
  });

  /**
   * @case env resolves per exchange and still sits on top of the baseline
   * @preconditions env derived from the body, printing the variable and PATH
   * @expectedResult The command sees the resolved value and the fixed baseline PATH
   */
  test("env resolves per exchange", async () => {
    const ex = await exchangeWith({ region: "eu-west-1" });
    const result = await shell<{ region: string }>(
      "sh",
      ["-c", "echo $REGION:$PATH"],
      {
        isolation: "none",
        network: true,
        env: (e) => ({ REGION: e.body.region }),
      },
    ).fetch(ex);
    expect(result.stdout.trim()).toBe("eu-west-1:/usr/local/bin:/usr/bin:/bin");
  });
});
