import { connect as connectTcp, type Socket } from "node:net";
import { Writable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { rcError } from "@routecraft/routecraft";
import { loadDockerode } from "../peers.ts";
import { BoundedOutput, exitCodeForSignal } from "../shared.ts";
import { cacheSuccess } from "./host.ts";
import type {
  ContainerIo,
  ContainerTier,
  ExecutionOutcome,
  Invocation,
  IsolationRequest,
} from "./types.ts";

/**
 * A throwaway container per command, through the Docker Engine API.
 *
 * ## What this tier guarantees
 *
 * - **Filesystem**: the command sees the image's filesystem and the mounts
 *   the call declared, nothing else from the host. This is the containment
 *   the `unshare` tier deliberately does not provide.
 * - **Network**: no network unless the call sets `network: true`, so egress
 *   is denied by default.
 * - **Identity**: the caller's own uid and gid inside the container unless
 *   `mapRootUser: true`, which runs as root inside.
 * - **Processes**: the container's own PID namespace.
 * - **Lifetime**: one container per command, removed when it exits
 *   (`--rm`). No pool, no reuse.
 *
 * ## What this tier does NOT guarantee
 *
 * A container shares the host kernel; it is not a virtual machine. The
 * image is chosen by the call and pulled by nobody: an image that is not
 * present fails the call naming it, so what runs inside is only as trusted
 * as the image an author (or an agent) named. Environment variables are
 * visible in `docker inspect`; a value that must not be is passed through
 * `stdin`, which reaches only the command. The image's own `ENV` is
 * present beside the granted baseline: the daemon merges the two and the
 * grant wins only on the names it sets, so an image that bakes in a
 * credential hands it to every command. A mount whose host path does not
 * exist is created by the daemon, as a root-owned directory.
 *
 * ## Why the API and not the `docker` CLI
 *
 * A daemon absent, an image missing and a container killed are distinct
 * answers from the API and text on stderr from the CLI. And a client
 * process holds env values on its argv, where `ps` shows them; the API
 * sends them in a request body.
 *
 * ## How stdin reaches the container
 *
 * Output is read through an ordinary attach, a streamed HTTP response.
 * Stdin needs the attach endpoint's connection upgrade, which the client
 * library drives through `http.request`'s `upgrade` event, and that event
 * is not delivered under Bun, the CLI's runtime: the request hangs. So the
 * tier opens the upgrade itself on the daemon's own socket, with the same
 * connection settings the client resolved, writes the bytes and half
 * closes. One code path, exercised on both runtimes.
 */

/** The slice of the Docker Engine client this tier drives. Structural, so a test can supply one. */
export interface DockerClient {
  ping(): Promise<unknown>;
  createContainer(options: ContainerCreateOptions): Promise<DockerContainer>;
  /** How the client reaches the daemon; the stdin upgrade reuses it. */
  readonly modem: DockerConnection;
}

/**
 * The daemon connection as `docker-modem` resolves it from `DOCKER_HOST`
 * and the default socket, which is the resolution the docker CLI performs.
 */
export interface DockerConnection {
  /** A path, or the client's lazy resolver for the default socket. */
  readonly socketPath?: string | (() => string | Promise<string>);
  readonly host?: string;
  readonly port?: number | string;
  readonly protocol?: string;
  readonly ca?: string | Buffer | Array<string | Buffer>;
  readonly cert?: string | Buffer;
  readonly key?: string | Buffer;
  demuxStream(
    stream: NodeJS.ReadableStream,
    stdout: NodeJS.WritableStream,
    stderr: NodeJS.WritableStream,
  ): void;
}

/** What a container must offer. */
export interface DockerContainer {
  readonly id: string;
  attach(options: {
    stream: boolean;
    stdout: boolean;
    stderr: boolean;
  }): Promise<NodeJS.ReadableStream>;
  start(): Promise<unknown>;
  wait(options: { condition: "next-exit" }): Promise<{ StatusCode: number }>;
  kill(options?: { signal: string }): Promise<unknown>;
  remove(options: { force: boolean }): Promise<unknown>;
}

/**
 * Deliver stdin bytes to a created container and close its input. The
 * shipped implementation is {@link writeStdinOverUpgrade}; a test hands in
 * a recorder.
 *
 * @internal
 */
export type StdinWriter = (
  connection: DockerConnection,
  containerId: string,
  bytes: Uint8Array,
) => Promise<void>;

/** The container specification this tier builds, as the API takes it. */
export interface ContainerCreateOptions {
  Image: string;
  /**
   * The program, set explicitly so the image's own entrypoint is replaced
   * rather than prepended: an image whose entrypoint is a shell would
   * otherwise put a shell in front of the argv `shell()` promises never
   * to hand to one.
   */
  Entrypoint: string[];
  Cmd: string[];
  name: string;
  Env: string[];
  WorkingDir?: string;
  User?: string;
  AttachStdin: boolean;
  AttachStdout: boolean;
  AttachStderr: boolean;
  OpenStdin: boolean;
  StdinOnce: boolean;
  Tty: boolean;
  HostConfig: {
    AutoRemove: boolean;
    /**
     * `docker-init` as PID 1, forwarding signals to the command. Without
     * it the command is PID 1 and ignores the timeout's SIGTERM, so every
     * timeout would wait out the SIGKILL grace.
     */
    Init: boolean;
    NetworkMode: "none" | "bridge";
    Binds: string[];
    /**
     * A private, writable `HOME` for the command, mode 0700 and owned by
     * the container user, so the baseline's promise (a home holding none
     * of the caller's dotfiles and writable by nobody else) holds inside
     * the container as it does on the host.
     */
    Tmpfs: Record<string, string>;
  };
}

/** Grace between the timeout's SIGTERM and the SIGKILL, as on the host tiers. */
const FORCE_KILL_AFTER_MS = 5_000;

/** How long after the exit the attach stream is given to deliver its tail. */
const ATTACH_DRAIN_MS = 5_000;

/** How long the daemon gets to answer the stdin attach upgrade. */
const UPGRADE_TIMEOUT_MS = 10_000;

/** The directory handed to the command as `HOME` inside the container. */
export const CONTAINER_HOME = "/home/routecraft";

/**
 * Build the tier over a client factory. The shipped tier loads `dockerode`
 * as an optional peer; a test hands in a fake and asserts the container
 * specification the tier produces, which is the whole of what the tier
 * decides.
 *
 * @internal
 */
export function createDockerTier(
  client: () => Promise<DockerClient>,
  writeStdin: StdinWriter = writeStdinOverUpgrade,
): ContainerTier {
  return {
    name: "docker",
    kind: "container",
    home: CONTAINER_HOME,

    ensureAvailable: cacheSuccess(() => runProbe(client)),

    refuse(): undefined {
      // Egress maps onto the network mode, identity onto the container
      // user, and the container options are this tier's own. Nothing to
      // refuse.
      return undefined;
    },

    async execute(
      target: Invocation,
      request: IsolationRequest,
      io: ContainerIo,
    ): Promise<ExecutionOutcome> {
      const image = request.image;
      // Checked by the adapter before the tier is asked; this is the tier
      // refusing to run with no image rather than guessing one.
      if (image === undefined || image === "") {
        throw rcError("RC5003", undefined, {
          message: `shell(): the "docker" tier needs an image and the call resolved none. Set image to the image the command runs in; there is no default.`,
        });
      }
      // Built before anything exists on the daemon: a limit the buffer
      // refuses must fail the call, not leave a created container behind.
      const stdout = new BoundedOutput(io.maxOutputBytes);
      const stderr = new BoundedOutput(io.maxOutputBytes);
      const spec = containerSpec(target, request, io, image);

      let container: DockerContainer | undefined;
      let signal: string | undefined;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = async (sig: "SIGTERM" | "SIGKILL"): Promise<void> => {
        signal ??= sig;
        // A container that already exited, or has not started, answers
        // 409 or 404; the wait below reports the real outcome either way.
        await container?.kill({ signal: sig }).catch(() => undefined);
      };
      const onAbort = (): void => {
        void kill("SIGKILL");
      };
      const disarm = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        io.signal?.removeEventListener("abort", onAbort);
      };
      // Armed before the daemon is reached at all, so a deadline or a
      // cancellation covers the whole setup: a daemon that stalls on the
      // create, or accepts the container and then stalls, is bounded like
      // a command.
      if (io.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          timedOut = true;
          void kill("SIGTERM");
          forceTimer = setTimeout(
            () => void kill("SIGKILL"),
            FORCE_KILL_AFTER_MS,
          );
        }, io.timeoutMs);
      }
      if (io.signal?.aborted) onAbort();
      else io.signal?.addEventListener("abort", onAbort, { once: true });

      try {
        const docker = await client();
        try {
          container = await docker.createContainer(spec);
        } catch (cause: unknown) {
          throw createFailure(cause, image);
        }
        // The deadline or the cancellation landed while the daemon was
        // still creating the container. Nothing has run, and nothing will:
        // the outcome is the one a killed command reports.
        if (signal !== undefined) {
          await container.remove({ force: true }).catch(() => undefined);
          return {
            stdout: stdout.result(),
            stderr: stderr.result(),
            exitCode: exitCodeForSignal(signal),
            signal,
            timedOut,
          };
        }

        let exited: Promise<{ StatusCode: number }> | undefined;
        let drained: Promise<void> = Promise.resolve();
        let output: NodeJS.ReadableStream | undefined;
        let started = false;
        try {
          output = await container.attach({
            stream: true,
            stdout: true,
            stderr: true,
          });
          drained = streamEnded(output);
          docker.modem.demuxStream(
            output,
            sink((chunk) => stdout.push(chunk)),
            sink((chunk) => stderr.push(chunk)),
          );
          // Attached and written before the start, as `docker run -i` does,
          // so the command can never read an input nobody has connected yet.
          // The daemon holds the bytes until the process reads them, and the
          // half close is what lets a command that reads to EOF finish.
          const fed =
            io.stdin === undefined
              ? Promise.resolve()
              : writeStdin(docker.modem, container.id, io.stdin);
          // Waited on before the start, with `next-exit`, so an `--rm`
          // container that exits at once is not gone before the wait begins.
          exited = container.wait({ condition: "next-exit" });
          // Both are awaited below; observed here so a rejection that lands
          // while the start is awaited is not an unhandled one.
          fed.catch(() => undefined);
          exited.catch(() => undefined);
          await container.start();
          started = true;
          // A kill requested during the setup found nothing running. Now
          // there is, and it must not outlive the deadline that asked.
          if (signal !== undefined) await kill("SIGKILL");
          await fed;
        } catch (cause: unknown) {
          if (!started) {
            // `--rm` only applies to a container that ran. One that failed
            // to attach or start stays in the created state, holding its
            // name, so it is removed here rather than left for an operator.
            await container.remove({ force: true }).catch(() => undefined);
            throw cause;
          }
          // Started, but its input never arrived: a command must not run on
          // without the input it was promised.
          await kill("SIGKILL");
          if (!timedOut) {
            await exited?.catch(() => undefined);
            throw cause;
          }
        }

        let StatusCode: number;
        try {
          ({ StatusCode } = await exited!);
        } catch (cause: unknown) {
          // The daemon lost track of a container it started; the command
          // in it must not run on unwatched.
          await kill("SIGKILL");
          throw cause;
        }
        // The command is done: a deadline that fires during the drain
        // below would report a finished command as timed out.
        disarm();
        // The exit lands before the last of the output does: the daemon
        // closes the attach stream after the wait answers, and a result
        // read at the exit drops whatever was still in flight. Bounded,
        // because a daemon that never closes the stream must not hold the
        // exchange once the command is known to be gone; a stream still
        // open at the bound is destroyed so it neither leaks nor keeps
        // feeding a buffer nobody reads.
        const drainedInTime = await Promise.race([
          drained.then(() => true),
          delay(ATTACH_DRAIN_MS).then(() => false),
        ]);
        if (!drainedInTime) {
          (output as { destroy?: () => void } | undefined)?.destroy?.();
        }
        return {
          stdout: stdout.result(),
          stderr: stderr.result(),
          exitCode: StatusCode,
          ...(signal !== undefined ? { signal } : {}),
          timedOut,
        };
      } finally {
        disarm();
      }
    },
  };
}

/**
 * Open the attach endpoint's connection upgrade on the daemon's own
 * socket, write the bytes, and half close so the container sees EOF.
 *
 * A hand-written HTTP/1.1 request rather than the client library's, for
 * the reason the module doc gives: the upgrade event the library waits on
 * is not delivered under Bun. Unversioned path, which the daemon reads as
 * its current API version.
 *
 * @internal
 */
export async function writeStdinOverUpgrade(
  connection: DockerConnection,
  containerId: string,
  bytes: Uint8Array,
): Promise<void> {
  const socket = await openDaemonSocket(connection);
  const host = connection.host ?? "docker";
  await new Promise<void>((resolve, reject) => {
    let head = Buffer.alloc(0);
    let upgraded = false;
    const fail = (cause: unknown): void => {
      socket.destroy();
      reject(
        rcError("OS1002", cause instanceof Error ? cause : undefined, {
          message: `The "docker" tier could not attach stdin to the container${cause instanceof Error ? `: ${cause.message}` : ""}.`,
        }),
      );
    };
    socket.once("error", fail);
    // A daemon that accepts the connection and drops it, or never answers,
    // would otherwise leave this pending with no deadline to reach. Both
    // `end` and `close` are watched because Bun delivers only the former
    // for a peer that hangs up, and the deadline is a timer rather than
    // the socket's own, which Bun does not fire on a unix socket.
    const dropped = (): void => {
      if (!upgraded) {
        fail(
          new Error(
            "the daemon dropped the connection before answering the attach upgrade",
          ),
        );
      }
    };
    socket.once("end", dropped);
    socket.once("close", dropped);
    const deadline = setTimeout(() => {
      if (!upgraded) {
        fail(
          new Error(
            `the daemon did not answer the attach upgrade within ${String(UPGRADE_TIMEOUT_MS)}ms`,
          ),
        );
      }
    }, UPGRADE_TIMEOUT_MS);
    socket.once("close", () => clearTimeout(deadline));
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      upgraded = true;
      // The upgrade answered; the write below may legitimately wait on a
      // command that is slow to read, so the deadline ends here.
      clearTimeout(deadline);
      const status = head.subarray(0, head.indexOf("\r\n")).toString();
      // 101 is the upgrade; a daemon that answers 200 streams over the
      // same connection and accepts input the same way.
      if (!/^HTTP\/1\.[01] (101|200) /.test(status)) {
        fail(new Error(`the daemon answered "${status}"`));
        return;
      }
      socket.write(bytes, (err) => {
        if (err) {
          fail(err);
          return;
        }
        // Half close: the read side stays open so the daemon can finish
        // the exchange, and the container's stdin sees EOF.
        socket.end();
        resolve();
      });
    });
    socket.once("connect", () => {
      socket.write(
        `POST /containers/${containerId}/attach?stream=1&stdin=1&stdout=0&stderr=0 HTTP/1.1\r\n` +
          `Host: ${host}\r\n` +
          "Connection: Upgrade\r\n" +
          "Upgrade: tcp\r\n" +
          "Content-Type: application/vnd.docker.raw-stream\r\n" +
          "\r\n",
      );
    });
  });
}

/** A socket to the daemon over whichever transport the client resolved. */
async function openDaemonSocket(connection: DockerConnection): Promise<Socket> {
  const socketPath =
    typeof connection.socketPath === "function"
      ? await connection.socketPath()
      : connection.socketPath;
  if (socketPath !== undefined) {
    return connectTcp({ path: socketPath });
  }
  const protocol = connection.protocol ?? "http";
  // The client library tunnels `ssh://` through an agent of its own; this
  // hand-written upgrade cannot, and a plain TCP write to port 22 would
  // fail one hop later with a message naming nothing.
  if (protocol !== "http" && protocol !== "https") {
    throw rcError("OS1002", undefined, {
      message: `The "docker" tier cannot attach stdin over a "${protocol}" daemon connection: shell({ stdin }) needs a unix socket or a TCP daemon. Drop stdin, or point DOCKER_HOST at one.`,
    });
  }
  const host = connection.host ?? "127.0.0.1";
  const port = Number(connection.port ?? 2375);
  if (protocol === "https") {
    return connectTls({
      host,
      port,
      ...(connection.ca !== undefined ? { ca: connection.ca } : {}),
      ...(connection.cert !== undefined ? { cert: connection.cert } : {}),
      ...(connection.key !== undefined ? { key: connection.key } : {}),
    });
  }
  return connectTcp({ host, port });
}

/** The shipped tier, over `dockerode` loaded as an optional peer. */
export const dockerTier: ContainerTier = createDockerTier(async () => {
  const { default: Dockerode } = await loadDockerode();
  // No options: dockerode reads DOCKER_HOST and the default socket itself,
  // which is the same resolution the docker CLI performs.
  return new Dockerode() as unknown as DockerClient;
});

/**
 * The container the call asks for. Every value the call resolved is one
 * field here, and the command is `Entrypoint` plus `Cmd` as an argument
 * vector: the image's own entrypoint is replaced rather than composed
 * with, so the program named at the call site is the program that runs
 * and no shell an image bakes in sits in front of it. `image` is one
 * field too, never interpolated, so a value from data cannot carry flags.
 *
 * @internal
 */
export function containerSpec(
  target: Invocation,
  request: IsolationRequest,
  io: ContainerIo,
  image: string,
): ContainerCreateOptions {
  return {
    Image: image,
    Entrypoint: [target.file],
    Cmd: [...target.args],
    name: request.name ?? io.defaultName,
    Env: Object.entries(io.env).map(([key, value]) => `${key}=${value}`),
    ...(io.cwd !== undefined ? { WorkingDir: io.cwd } : {}),
    ...containerUser(request.mapRootUser),
    AttachStdin: io.stdin !== undefined,
    AttachStdout: true,
    AttachStderr: true,
    OpenStdin: io.stdin !== undefined,
    StdinOnce: io.stdin !== undefined,
    Tty: false,
    HostConfig: {
      AutoRemove: true,
      Init: true,
      NetworkMode: request.network ? "bridge" : "none",
      Binds: (request.mounts ?? []).map(
        (mount) =>
          `${mount.host}:${mount.container}${mount.readonly ? ":ro" : ""}`,
      ),
      Tmpfs: { [CONTAINER_HOME]: homeMountOptions(request.mapRootUser) },
    },
  };
}

/**
 * Who the command runs as. The default is the caller's own uid and gid,
 * so files the command writes on a mount are the caller's. Root is opt-in
 * and, unlike root inside the `unshare` tier's user namespace, is the
 * host's real uid 0 on a daemon without user-namespace remapping: with a
 * writable mount it writes root-owned files on the host. A runtime without
 * POSIX ids leaves the image's own user in place; the one platform that
 * lacks them is refused at the probe, so this is the type kept honest
 * rather than a path a command takes.
 */
function containerUser(mapRootUser: boolean): { User?: string } {
  const ids = posixIds(mapRootUser);
  return ids === undefined ? {} : { User: `${ids.uid}:${ids.gid}` };
}

/**
 * The tmpfs options that make the container home private to its user.
 * The tmpfs is owned by the user the tier sets, and a runtime without
 * POSIX ids is refused at the probe rather than handed a home it cannot
 * own.
 */
function homeMountOptions(mapRootUser: boolean): string {
  const ids = posixIds(mapRootUser);
  return ids === undefined
    ? "rw,mode=0700"
    : `rw,mode=0700,uid=${ids.uid},gid=${ids.gid}`;
}

function posixIds(
  mapRootUser: boolean,
): { uid: number; gid: number } | undefined {
  if (mapRootUser) return { uid: 0, gid: 0 };
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return undefined;
  }
  return { uid: process.getuid(), gid: process.getgid() };
}

/** Settles when the daemon closes an attach stream, or when it fails. */
function streamEnded(stream: NodeJS.ReadableStream): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => resolve();
    stream.once("end", done);
    stream.once("close", done);
    stream.once("error", done);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A settled race must not keep the process alive for its loser.
    timer.unref?.();
  });
}

/** A writable that hands every chunk to a bounded buffer. */
function sink(push: (chunk: Uint8Array) => void): Writable {
  return new Writable({
    write(chunk: Uint8Array, _encoding, callback) {
      push(chunk);
      callback();
    },
  });
}

async function runProbe(client: () => Promise<DockerClient>): Promise<void> {
  // Mount paths are checked as POSIX paths and handed to the daemon as
  // such; a drive-letter path would pass neither, so the tier refuses the
  // platform outright rather than a mount at a time.
  if (process.platform === "win32") {
    throw rcError("OS1001", undefined, {
      message:
        `The "docker" isolation tier runs on Linux and macOS and this host is win32. ` +
        `Run the route on one of those, or write isolation: "none" at the call site to run without isolation deliberately.`,
    });
  }
  // A missing peer rejects here as RC5017 from the loader, with its own
  // install hint, and is not reworded.
  const docker = await client();
  try {
    await docker.ping();
  } catch (cause: unknown) {
    const detail =
      cause instanceof Error ? cause.message.trim() : String(cause);
    throw rcError("OS1001", cause instanceof Error ? cause : undefined, {
      message:
        `The "docker" isolation tier needs a Docker Engine daemon and none answered${detail === "" ? "" : `: ${detail}`}. ` +
        `Start the daemon, or point DOCKER_HOST at one, or choose a tier this host provides ("unshare" on Linux). ` +
        `shell() never falls back to a weaker tier on its own.`,
    });
  }
}

/**
 * Turn a create failure into the adapter's own vocabulary. A missing image
 * is the one an author or an agent hits first, and the remedy is a pull
 * this tier deliberately does not perform: a pull can take minutes and
 * consume the call's timeout, and which images may run here is a decision
 * for the operator, not for the call that named one.
 */
function createFailure(cause: unknown, image: string): Error {
  const status = (cause as { statusCode?: unknown } | null)?.statusCode;
  const err = cause instanceof Error ? cause : undefined;
  if (status === 404) {
    return rcError("OS1002", err, {
      message: `The "docker" tier could not start a container: image "${image}" is not present on this daemon. Pull it first (docker pull ${image}); shell() never pulls an image on its own.`,
    });
  }
  return rcError("OS1002", err, {
    message: `The "docker" tier could not create a container from image "${image}"${err ? `: ${err.message}` : ""}.`,
  });
}
