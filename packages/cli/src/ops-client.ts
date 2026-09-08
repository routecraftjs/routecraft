/**
 * The CLI's view of a running instance's ops server.
 *
 * The client itself lives in core (`createOpsHttpClient`), beside the
 * server it speaks to, because the remotes plugin drives the same wire
 * from inside a running context. What stays here is what only the CLI
 * knows: where the address and the token came from, and the remedies a
 * person at a terminal can act on.
 */

import {
  createOpsHttpClient,
  isLoopbackHostname,
  type OpsHttpClient,
} from "@routecraft/routecraft";
import {
  describeSource,
  SettingsError,
  type ResolvedSettings,
} from "./settings.js";

export {
  OpsClientError,
  type OpsFailureKind,
  type OpsHttpClient as OpsClient,
} from "@routecraft/routecraft";

/**
 * A bearer token over plain `http:` is readable by every hop between the
 * terminal and the instance, and the settings ladder makes it easy to pin
 * an `http://` address in a file and add a token from the environment
 * later without seeing the two together. Loopback is the exception: the
 * bytes never leave the machine, and it is the address `craft` defaults
 * to for an instance running here.
 */
export function refuseClearTextBearer(settings: ResolvedSettings): void {
  const url = new URL(settings.url.value);
  if (url.protocol !== "http:" || isLoopbackHostname(url.hostname)) return;
  throw new SettingsError(
    `The instance URL from the ${describeSource(settings.url)} is ${settings.url.value}, which is plain http, and the token from the ${describeSource(settings.token!)} would travel over it as clear text. ` +
      `Use an https URL, or a loopback address (localhost, 127.0.0.1, ::1) for an instance on this machine.`,
  );
}

export function createOpsClient(settings: ResolvedSettings): OpsHttpClient {
  const token = settings.token?.value;
  if (token !== undefined) refuseClearTextBearer(settings);
  const base = settings.url.value.replace(/\/+$/, "");
  return createOpsHttpClient({
    url: settings.url.value,
    ...(token !== undefined ? { token } : {}),
    describeAddress: () => `${base} (from the ${describeSource(settings.url)})`,
    advice: {
      missingCredential:
        "Put a token in .routecraft/settings.yaml, set CRAFT_TOKEN, or pass --token.",
      unreachable:
        "Start one with 'craft start', or point at another instance with --url.",
    },
  });
}
