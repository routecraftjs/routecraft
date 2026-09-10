import { describe, expect, test } from "bun:test";
import { runtimeReplaysDroppedRequests } from "../src/plugins/ops/client.ts";

/**
 * Which runtimes need a dispatch taken out of the connection pool.
 *
 * `POST /ops/routes/{id}/exchanges` is not idempotent, and below Bun
 * 1.3.14 the runtime's own `fetch` re-sent a request on a fresh connection
 * when a reused keep-alive socket closed before any response byte arrived.
 * That happens beneath the layer this client classifies on, so the caller
 * saw one attempt and one `interrupted` failure while the route had run
 * twice. The client answers it by giving a dispatch its own connection,
 * leaving nothing for the runtime to re-send on.
 *
 * The policy itself is not observable on the wire and a connection count
 * is shared state in a single-process suite, so what is asserted here is
 * the decision. That the policy works end to end is the dropped-socket
 * case in the remotes suite, which counts executions on a stand-in that
 * serves its inventory over keep-alive.
 */
describe("runtimeReplaysDroppedRequests", () => {
  /**
   * @case Node is never affected
   * @preconditions `null`, the contract for "not running on Bun". Not `undefined`, which the default parameter would replace with this suite's own Bun version
   * @expectedResult False. Node's `fetch` never re-sent a dropped non-idempotent request, so the embedding path pays nothing
   */
  test("says no when the runtime is not Bun", () => {
    expect(runtimeReplaysDroppedRequests(null)).toBe(false);
  });

  /**
   * @case Every Bun below the fix replays
   * @preconditions Versions on both sides of the 1.3.14 boundary, including the patch immediately below it and an older major line
   * @expectedResult True below, false at and above. The boundary is the release that refused the retry for non-idempotent methods
   */
  test("says yes below 1.3.14 and no from it on", () => {
    for (const version of ["1.0.0", "1.1.0", "1.2.20", "1.3.11", "1.3.13"]) {
      expect(runtimeReplaysDroppedRequests(version)).toBe(true);
    }
    for (const version of ["1.3.14", "1.3.20", "1.4.2", "2.0.0"]) {
      expect(runtimeReplaysDroppedRequests(version)).toBe(false);
    }
  });

  /**
   * @case A prerelease or build suffix is stripped before comparing
   * @preconditions Canary and build-metadata renderings on both sides of the boundary
   * @expectedResult The numeric version decides. A canary of a fixed line must not be charged a handshake, and a canary of an affected one must not escape the guard
   */
  test("compares the numeric version, not the suffix", () => {
    expect(runtimeReplaysDroppedRequests("1.3.14-canary.1")).toBe(false);
    expect(runtimeReplaysDroppedRequests("1.4.2+build.9")).toBe(false);
    expect(runtimeReplaysDroppedRequests("1.3.13-canary.1")).toBe(true);
  });

  /**
   * @case A version that cannot be read fails towards correctness
   * @preconditions Strings the parse cannot make three numbers of
   * @expectedResult True. Being wrong here costs a handshake per dispatch; being wrong the other way runs somebody's payout route twice
   */
  test("treats an unreadable version as affected", () => {
    for (const version of ["", "not-a-version", "1", "1.x.0"]) {
      expect(runtimeReplaysDroppedRequests(version)).toBe(true);
    }
  });
});
