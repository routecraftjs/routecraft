import { connect as connectTcp, type Socket } from "node:net";
import { Writable } from "node:stream";
import { connect as connectTls } from "node:tls";
import { rcError } from "@routecraft/routecraft";
import { loadDockerode } from "../peers.ts";
import { BoundedOutput } from "../shared.ts";
import type {
  ExecutionIo,
  ExecutionOutcome,
  Invocation,
  IsolationRequest,
  IsolationTier,
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
 * `stdin`, which reaches only the command.
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
  };
}

/** Grace between the timeout's SIGTERM and the SIGKILL, as on the host tiers. */
const FORCE_KILL_AFTER_MS = 5_000;

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
): IsolationTier {
  let probe: Promise<void> | undefined;
  return {
    name: "docker",

    ensureAvailable(): Promise<void> {
      // Only a success is cached, as on the unshare tier: a daemon that was
      // down when first asked may be up on the next call.
      probe ??= runProbe(client).catch((cause: unknown) => {
        probe = undefined;
        throw cause;
      });
      return probe;
    },

    refuse(): undefined {
      // Egress maps onto the network mode, identity onto the container
      // user, and the container options are this tier's own. Nothing to
      // refuse.
      return undefined;
    },

    async execute(
      target: Invocation,
      request: IsolationRequest,
      io: ExecutionIo,
    ): Promise<ExecutionOutcome> {
      const image = request.image;
      // Checked by the adapter before the tier is asked; this is the tier
      // refusing to run with no image rather than guessing one.
      if (image === undefined || image === "") {
        throw rcError("RC5003", undefined, {
          message: `shell(): the "docker" tier needs an image and the call resolved none. Set image to the image the command runs in; there is no default.`,
        });
      }
      const docker = await client();
      const spec = containerSpec(target, request, io, image);
      let container: DockerContainer;
      try {
        container = await docker.createContainer(spec);
      } catch (cause: unknown) {
        throw createFailure(cause, image);
      }
      const stdout = new BoundedOutput(io.maxOutputBytes);
      const stderr = new BoundedOutput(io.maxOutputBytes);
      let exited: Promise<{ StatusCode: number }>;
      try {
        const output = await container.attach({
          stream: true,
          stdout: true,
          stderr: true,
        });
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
        await container.start();
        await fed;
      } catch (cause: unknown) {
        // `--rm` only applies to a container that ran. One that failed to
        // attach or start stays in the created state, holding its name,
        // so it is removed here rather than left for an operator.
        await container.remove({ force: true }).catch(() => undefined);
        throw cause;
      }

      let signal: string | undefined;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let forceTimer: ReturnType<typeof setTimeout> | undefined;
      const kill = async (sig: "SIGTERM" | "SIGKILL"): Promise<void> => {
        signal ??= sig;
        // A container that already exited answers 409 or 404; either way the
        // wait below reports the real outcome, so the refusal is not news.
        await container.kill({ signal: sig }).catch(() => undefined);
      };
      const onAbort = (): void => {
        void kill("SIGKILL");
      };
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
        const { StatusCode } = await exited;
        return {
          stdout: stdout.result(),
          stderr: stderr.result(),
          exitCode: StatusCode,
          ...(signal !== undefined ? { signal } : {}),
          timedOut,
        };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (forceTimer !== undefined) clearTimeout(forceTimer);
        io.signal?.removeEventListener("abort", onAbort);
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
    socket.on("data", (chunk: Buffer) => {
      if (upgraded) return;
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      upgraded = true;
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
  const host = connection.host ?? "127.0.0.1";
  const port = Number(connection.port ?? 2375);
  if (connection.protocol === "https") {
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
export const dockerTier: IsolationTier = createDockerTier(async () => {
  const { default: Dockerode } = await loadDockerode();
  // No options: dockerode reads DOCKER_HOST and the default socket itself,
  // which is the same resolution the docker CLI performs.
  return new Dockerode() as unknown as DockerClient;
});

/**
 * The container the call asks for. Every value the call resolved is one
 * field here, and the command is `Cmd` as an argument vector: the image's
 * entrypoint is bypassed rather than composed with, so the program named
 * at the call site is the program that runs. `image` is one field too,
 * never interpolated, so a value from data cannot carry flags.
 *
 * @internal
 */
export function containerSpec(
  target: Invocation,
  request: IsolationRequest,
  io: ExecutionIo,
  image: string,
): ContainerCreateOptions {
  return {
    Image: image,
    Cmd: [target.file, ...target.args],
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
    },
  };
}

/**
 * Who the command runs as. Root inside the container is opt-in, as root
 * inside the user namespace is on the host tiers; the default is the
 * caller's own uid and gid, so files the command writes on a mount are the
 * caller's. On a platform without POSIX ids (Windows, where the daemon is
 * remote anyway) the image's own user applies.
 */
function containerUser(mapRootUser: boolean): { User?: string } {
  if (mapRootUser) return { User: "0:0" };
  if (
    typeof process.getuid !== "function" ||
    typeof process.getgid !== "function"
  ) {
    return {};
  }
  return { User: `${process.getuid()}:${process.getgid()}` };
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
