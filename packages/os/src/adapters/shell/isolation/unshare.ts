import { rcError } from "@routecraft/routecraft";
import { loadExeca } from "../peers.ts";
import type { HostTier, Invocation, IsolationRequest } from "./types.ts";
import { cacheSuccess, refuseContainerOptions } from "./host.ts";

/**
 * Linux kernel namespaces, via util-linux `unshare`. No daemon and
 * near-zero startup, which is what makes it the default.
 *
 * ## What this tier guarantees
 *
 * - **Processes**: a PID namespace, with `/proc` remounted inside it. Host
 *   processes are invisible to the command and cannot be signalled by it.
 * - **Network**: a network namespace with no interfaces unless the call
 *   sets `network: true`, so egress is denied by default.
 * - **Identity**: a user namespace. The command never holds the caller's
 *   host privileges.
 * - **Mounts**: a mount namespace, so anything the command mounts is
 *   contained and does not propagate to the host.
 * - **IPC**: an IPC namespace. Host SysV objects (shared memory, message
 *   queues, semaphores) are invisible, so a command cannot read or
 *   corrupt state another process left in them.
 * - **Hostname**: a UTS namespace. The command sees and can change a
 *   hostname and domainname of its own without touching the host's.
 *
 * ## What this tier does NOT guarantee
 *
 * **The command can still read every file the calling user can read**,
 * including `~/.ssh`, `.env` files, and the rest of the home directory. A
 * mount namespace isolates mount *propagation*, not filesystem
 * *visibility*: `/` inside the namespace is still the host's `/`.
 *
 * This is stated plainly rather than left implied because the word
 * "isolation" invites the opposite assumption. Read containment needs a
 * `pivot_root` into a prepared root filesystem, which needs bind mounts
 * performed by a process already inside the namespace, which `unshare`
 * alone cannot sequence. A tier that delivers it is tracked separately;
 * until then, a command that must not read the caller's secrets needs
 * either a host whose files it may all read, or a tier that contains them.
 *
 * Note the interaction with `network: true`: granting egress to a command
 * that can read the caller's files is what turns readable-but-local into
 * exfiltratable. Agent workloads that need the network belong on a tier
 * with filesystem containment.
 */
export const unshareTier: HostTier = {
  name: "unshare",
  kind: "host",

  ensureAvailable: cacheSuccess(runProbe),

  refuse(request: IsolationRequest): string | undefined {
    // Every host option maps onto a namespace this tier takes: egress onto
    // `--net`, identity onto the user namespace's mapping. The container
    // options do not: there is no image and no mount here, and an author
    // who wrote one believes in a containment this tier does not give.
    return refuseContainerOptions("unshare", request);
  },

  wrap(target: Invocation, request: IsolationRequest): Invocation {
    return {
      file: UNSHARE,
      args: [
        ...namespaceFlags(request),
        // Terminates `unshare`'s own option parsing. Without it a target
        // carrying its own flags (`git log --oneline`) has them read as
        // flags to `unshare`, which either errors or, worse, silently
        // changes what was unshared.
        "--",
        target.file,
        ...target.args,
      ],
    };
  },
};

const UNSHARE = "unshare";

/**
 * Cached availability answer. Namespace creation is a property of the
 * kernel and its policy, so probing once per process is enough, and
 * repeating it would put a subprocess spawn in front of every command.
 */
/**
 * Flags for the namespaces this tier promises.
 *
 * `--fork` is what makes the PID namespace real: without it `unshare`
 * itself would have to become PID 1, which it cannot, so the target would
 * keep the host's PID view. `--mount-proc` remounts `/proc` inside the new
 * namespace, which is what makes host processes actually invisible rather
 * than merely unmapped.
 *
 * `--kill-child` is kept but carries no promise here, because no probe
 * was found where it changes the outcome: on a normal exit the PID
 * namespace already reaps everything inside it when its init leaves, and
 * with the wrapper killed a survivor persisted with the flag and without
 * it alike. It is retained as belt-and-braces rather than removed on one
 * round of measurement, and it is deliberately absent from the tier's
 * documented guarantees until something demonstrates it.
 */
function namespaceFlags(request: IsolationRequest): string[] {
  const flags = [
    "--user",
    request.mapRootUser ? "--map-root-user" : "--map-current-user",
    "--mount",
    "--pid",
    "--fork",
    "--mount-proc",
    "--kill-child",
    "--ipc",
    "--uts",
    // Taken as hardening, deliberately absent from the promises above.
    // It does create a cgroup namespace, but what that hides is the
    // host's cgroup path, and a process already at the root cgroup has
    // no path to hide. On such a host, which includes the CI runner,
    // a two-sided test of it would pass while proving nothing, and a
    // guarantee nobody can check is what this suite exists to refuse.
    // It sets no controller, so it is not a resource limit of any kind.
    "--cgroup",
  ];
  // `--propagation private` is deliberately absent: util-linux already
  // applies it under `--mount`, so passing it would restate a default.
  if (!request.network) flags.push("--net");
  return flags;
}

/**
 * Run the real flag set against a trivial command. Probing with the flags
 * the tier actually uses is the point: a probe of a weaker set can pass on
 * a host where the real invocation fails, which would turn a loud failure
 * into a confusing one.
 */
async function runProbe(): Promise<void> {
  if (process.platform !== "linux") {
    throw rcError("OS1001", undefined, {
      message:
        `The "unshare" isolation tier needs Linux kernel namespaces and this host is ${process.platform}. ` +
        `Run the route on Linux, or write isolation: "none" at the call site to run without isolation deliberately.`,
    });
  }

  const { execa } = await loadExeca();
  const result = await execa(
    UNSHARE,
    [...namespaceFlags({ network: false, mapRootUser: false }), "--", "true"],
    { reject: false, timeout: PROBE_TIMEOUT_MS },
  );
  if (result.exitCode === 0) return;

  const detail = String(result.stderr || result.shortMessage || "").trim();
  throw rcError("OS1001", detail === "" ? undefined : new Error(detail), {
    message:
      `The "unshare" isolation tier is unavailable on this host${detail === "" ? "" : `: ${detail}`}. ` +
      `The usual causes are a kernel with unprivileged user namespaces restricted ` +
      `(kernel.unprivileged_userns_clone=0, or apparmor_restrict_unprivileged_userns=1), ` +
      `a container whose seccomp profile blocks namespace creation, or util-linux "unshare" not being installed. ` +
      `Grant the privilege, or write isolation: "none" at the call site to run without isolation deliberately. ` +
      `shell() never falls back to a weaker tier on its own.`,
  });
}

/** A namespace either can be created immediately or cannot be at all. */
const PROBE_TIMEOUT_MS = 10_000;
