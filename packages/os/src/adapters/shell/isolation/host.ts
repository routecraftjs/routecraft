import type { IsolationName } from "../types.ts";
import type { IsolationRequest } from "./types.ts";

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
