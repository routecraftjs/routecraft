import { rcError } from "@routecraft/routecraft";
import { loadExeca } from "../peers.ts";
import type { Invocation, IsolationRequest, IsolationTier } from "./types.ts";

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
export const unshareTier: IsolationTier = {
  name: "unshare",

  ensureAvailable(): Promise<void> {
    // Only a success is cached. A probe can fail for reasons that are not
    // properties of the kernel (fork pressure, a transient EAGAIN, the
    // probe's own timeout), and caching those would tell every later call
    // that the host restricts user namespaces when it does not.
    probe ??= runProbe().catch((cause: unknown) => {
      probe = undefined;
      throw cause;
    });
    return probe;
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
let probe: Promise<void> | undefined;

/**
 * Flags for the namespaces this tier promises.
 *
 * `--fork` is what makes the PID namespace real: without it `unshare`
 * itself would have to become PID 1, which it cannot, so the target would
 * keep the host's PID view. `--mount-proc` remounts `/proc` inside the new
 * namespace, which is what makes host processes actually invisible rather
 * than merely unmapped. `--kill-child` ties the target's lifetime to the
 * wrapper, so a timeout kill reaps the command instead of orphaning it.
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
  ];
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
