/**
 * What an app configures about the Agent Client Protocol mount.
 *
 * Nothing here is required. Installing the plugin serves the protocol, on
 * the same server and behind the same wall as everything else the instance
 * exposes.
 */

import type { HttpAuth, HttpCorsOptions } from "@routecraft/routecraft";

export interface AcpPluginOptions {
  /** Mount path. Default `/acp`. */
  path?: string;
  /** Which named server to mount on. Default `"default"`. */
  server?: string;
  /**
   * Mount-level auth override, the same union the MCP mount takes. Unset
   * inherits the server's validator; `false` removes the wall while
   * leaving the inherited validator reachable.
   */
  auth?: HttpAuth | false;
  /**
   * The persona a client gets when it picks none.
   *
   * Unset, a context holding exactly one agent uses it and a context
   * holding several refuses `session/new` with a message naming them all.
   * A person picks a different one from the `agent` config option when the
   * context holds more than one.
   */
  agent?: string;
  /**
   * CORS, the same shape and defaults as `mcpPlugin`'s: omitted applies
   * the loopback-only default, and `false` turns CORS handling off for a
   * mount whose reverse proxy owns it.
   */
  cors?: HttpCorsOptions | false;
  /**
   * What the editor calls this agent.
   *
   * Defaults to `{ name: "routecraft", title: "Routecraft", version }`, so
   * an instance that configures nothing carries the framework's name into
   * the editor. An app that sets this is white-labelling, so `title` is
   * never back-filled from the default: somebody who set a name and a
   * version does not then get "Routecraft" as their display title. `name`
   * and `version` are required by the protocol and cannot be left absent,
   * so those two fall back when unset.
   *
   * The protocol carries no icon, logo or image field anywhere in version
   * 1, so these two strings are the entire branding surface available
   * here. That is the protocol's limit rather than a choice of ours.
   */
  agentInfo?: { name?: string; title?: string; version?: string };
  /**
   * Whether a tool call's arguments and result reach the editor as
   * `rawInput` and `rawOutput`. Default `true`.
   *
   * The call itself is always visible whatever this says: a person
   * watching a turn sees which hands ran and how each ended. This is the
   * expandable detail underneath.
   *
   * An instance serving people other than its operator should consider
   * setting it `false`. A hand's arguments routinely carry a credential, a
   * customer's address or a mail body, and an editor is a third program
   * that renders and logs whatever it is handed.
   */
  toolCallPayloads?: boolean;
}
