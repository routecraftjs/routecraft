import type { IsolationName } from "../types.ts";
import type { IsolationRequest } from "./types.ts";

/**
 * Memoise an availability probe, caching only a success.
 *
 * A probe can fail for reasons that are not properties of the host (fork
 * pressure, a transient EAGAIN, a daemon that was down when first asked,
 * the probe's own timeout), and caching those would tell every later call
 * that the tier is unavailable when it is not. So a rejection clears the
 * memo and the next call probes again, while a success stands for the
 * process. See {@link IsolationTier.ensureAvailable}.
 *
 * @internal
 */
export function cacheSuccess(run: () => Promise<void>): () => Promise<void> {
  let pending: Promise<void> | undefined;
  return () =>
    (pending ??= run().catch((cause: unknown) => {
      pending = undefined;
      throw cause;
    }));
}

/**
 * The refusal every host tier gives a container option.
 *
 * `image`, `mounts` and `name` describe a container. Under a tier that
 * runs a plain process they would be dropped, and a dropped `image` is the
 * worst kind of silence: the author wrote the name of a filesystem the
 * command was to be confined to, and the command ran on the host's. So the
 * option is refused, naming the tier the call ran under and the one that
 * takes it.
 *
 * @internal
 */
export function refuseContainerOptions(
  tier: IsolationName,
  request: IsolationRequest,
): string | undefined {
  const set = (["image", "mounts", "name"] as const).filter(
    (option) => request[option] !== undefined,
  );
  if (set.length === 0) return undefined;
  return (
    `${set.map((o) => `"${o}"`).join(", ")} ${set.length === 1 ? "is a docker tier option" : "are docker tier options"}, and this call runs under the "${tier}" tier, which has no container to apply ${set.length === 1 ? "it" : "them"} to. ` +
    `Write isolation: "docker" beside ${set.length === 1 ? "it" : "them"}, or drop ${set.length === 1 ? "it" : "them"}.`
  );
}
