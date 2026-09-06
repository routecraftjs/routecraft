/**
 * The Agent Client Protocol SDK is an optional peer.
 *
 * An instance that mounts the protocol without it has to be told what to
 * install, rather than getting a raw module-not-found from somewhere
 * inside the mount.
 *
 * The property is held by two tests together, because neither can hold it
 * alone in one process. `mock.module` cannot make an `import()` REJECT
 * (bun awaits the factory when it is registered, so a throwing factory
 * fails the registration rather than the import), and the repo-wide
 * optional-peer contract test already proves every `import()` under
 * `packages/ai/src` sits inside a `loadOptionalPeer` thunk. What is left
 * to prove here is the pair of names those thunks carry, which is what
 * decides whether the message a person reads is actionable.
 */

import { describe, expect, test } from "bun:test";
import { loadOptionalPeer } from "@routecraft/routecraft";
import { ACP_PACKAGE, loadAcpSdk, loadAcpServerSdk } from "../src/acp/sdk.ts";

/** A rejection shaped exactly as a runtime's missing-module error. */
function missing(specifier: string): Error {
  return Object.assign(new Error(`Cannot find package '${specifier}'`), {
    code: "ERR_MODULE_NOT_FOUND",
  });
}

describe("the ACP SDK as an optional peer", () => {
  /**
   * @case Both entry points load when the peer is installed
   * @preconditions The real package, as the workspace has it
   * @expectedResult The protocol surface carries the app factory and the transport carries the server class, so the refusal below is about absence rather than about the loaders being broken
   */
  test("both entries load when the peer is there", async () => {
    const sdk = await loadAcpSdk("acp (test)");
    expect(typeof sdk.agent).toBe("function");
    const server = await loadAcpServerSdk("acp (test)");
    expect(typeof server.AcpServer).toBe("function");
  });

  /**
   * @case A missing peer is RC5017 naming one package and the command to install it
   * @preconditions The package name the mount's loaders carry, with an import that rejects as a runtime's missing module does
   * @expectedResult RC5017 rather than a raw ERR_MODULE_NOT_FOUND, naming the subsystem that wanted it and `bun add @agentclientprotocol/sdk`, which is one package even though the transport lives behind a subpath of it
   */
  test("a missing peer is RC5017 with an install hint", async () => {
    await expect(
      loadOptionalPeer(() => Promise.reject(missing(ACP_PACKAGE)), {
        consumer: "acp (mount)",
        packageName: ACP_PACKAGE,
      }),
    ).rejects.toMatchObject({
      rc: "RC5017",
      message: expect.stringContaining(
        `acp (mount) requires the optional peer dependency "${ACP_PACKAGE}"`,
      ),
    });

    await expect(
      loadOptionalPeer(() => Promise.reject(missing(ACP_PACKAGE)), {
        consumer: "acp (mount)",
        packageName: ACP_PACKAGE,
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining(`bun add ${ACP_PACKAGE}`),
    });
  });

  /**
   * @case The transport's subpath is reported as its own package, not as a subpath
   * @preconditions The package name the loaders share
   * @expectedResult It is the bare package, so somebody told to install it types one thing that works, rather than a subpath specifier no registry serves
   */
  test("the install hint names an installable package", () => {
    expect(ACP_PACKAGE).toBe("@agentclientprotocol/sdk");
    expect(ACP_PACKAGE).not.toContain("/experimental");
  });
});
