import { registerErrorCodes, type RCMeta } from "@routecraft/routecraft";

/**
 * Error codes owned by `@routecraft/os` under the `OS` namespace.
 *
 * The declaration merge makes the codes valid `rcError()` arguments at
 * compile time; the `registerErrorCodes` call below provides the runtime
 * metadata. Loaded as a side-effect import from this package's index so
 * the codes are registered before any adapter can throw them.
 *
 * The `RC` namespace is reserved for core and `registerErrorCodes` refuses
 * it outright, so host capabilities carrying their own failure modes claim
 * their own namespace rather than extending core's registry.
 *
 * Numbering: OS1xxx = subprocess execution and isolation. Ranges are
 * claimed in the range-allocation table on the error reference page before
 * use, so two lanes landing in parallel cannot mint the same code.
 */
declare module "@routecraft/routecraft" {
  interface ErrorCodeRegistry {
    /** The requested isolation tier is not available on this host */
    OS1001: RCMeta;
    /** A command failed to run, or ran and reported failure */
    OS1002: RCMeta;
    /** A command exceeded its timeout and was killed */
    OS1003: RCMeta;
  }
}

const DOCS_BASE = "https://routecraft.dev/docs/reference/errors";

registerErrorCodes(
  "OS",
  {
    OS1001: {
      category: "Adapter",
      message: "Isolation tier unavailable",
      suggestion:
        '`shell()` runs isolated by default and never silently downgrades to a weaker tier, because a route that believes it is contained and is not is worse than one that fails. The usual causes are a non-Linux host (the `unshare` tier is Linux-only; macOS support is tracked separately), a kernel with unprivileged user namespaces restricted, or a container whose seccomp profile blocks namespace creation. The ways out, in order of preference: grant the privilege (allow unprivileged user namespaces, or relax the container\'s seccomp profile), or write `isolation: "none"` at the call site to run without isolation deliberately and visibly.',
      docs: `${DOCS_BASE}#os-1001`,
      retryable: false,
    },
    OS1002: {
      category: "Adapter",
      message: "Command execution failed",
      suggestion:
        "The command failed to run, or ran and reported failure. Where it ran, its `stderr` and `exitCode` are on the error's cause so the route can log what the command actually said; a command that never started has neither, and the cause is whatever the spawn itself raised. For commands whose exit code is data rather than failure (`grep` with no match, `diff` with differences), pass `failOnNonZero: false` and read `exitCode` off the result instead.",
      docs: `${DOCS_BASE}#os-1002`,
      retryable: false,
    },
    OS1003: {
      category: "Adapter",
      message: "Command timed out",
      suggestion:
        "The command exceeded the `timeout` given to `shell()` and was killed, along with anything it had spawned. Raise the timeout if the work is genuinely long, or narrow what the command does. A command that reliably times out inside an isolation tier but not outside it is usually waiting on something the tier denies: network egress is denied unless the call sets `network: true`.",
      docs: `${DOCS_BASE}#os-1003`,
      retryable: true,
    },
  },
  "@routecraft/os",
);
