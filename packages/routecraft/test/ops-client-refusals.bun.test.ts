import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OpsClientError,
  createOpsHttpClient,
} from "../src/plugins/ops/client.ts";

/**
 * How the ops client reads the caller-refusal answers a door gives a
 * dispatch: the 400 an `.input()` schema produces and the 403s a route's
 * own `.authorize()` produces. Each is served by a stand-in answering one
 * fixed body, so what is asserted is the client's reading, not a door's.
 */
describe("ops client caller refusals", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const closing = server;
    server = undefined;
    if (closing)
      await new Promise<void>((resolve) => closing.close(() => resolve()));
  });

  async function dispatchAgainst(
    status: number,
    body: unknown,
  ): Promise<OpsClientError> {
    const stand = createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server = stand;
    await new Promise<void>((resolve) => stand.listen(0, "127.0.0.1", resolve));
    const port = (stand.address() as AddressInfo).port;
    const client = createOpsHttpClient({
      url: `http://127.0.0.1:${String(port)}`,
    });
    const outcome = await client.dispatch("greet", {}).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(OpsClientError);
    return outcome as OpsClientError;
  }

  /**
   * @case A 400 with more issues than the message renders says how many were left out
   * @preconditions The door answers 400 RC5065 with seven issues and truncated: 3, meaning ten more existed than it sent
   * @expectedResult An "error" failure whose message names the first five issues as path: message and ends "and 5 more", counting the two the client did not render plus the three the door did not send; the detail keeps the issues as a structured array
   */
  test("renders the first issues and counts the rest", async () => {
    const issues = Array.from({ length: 7 }, (_, i) => ({
      path: `items.${String(i)}`,
      message: "Expected number",
    }));
    const error = await dispatchAgainst(400, {
      error: "bad request",
      code: "RC5065",
      in: "body",
      issues,
      truncated: 3,
    });

    expect(error.kind).toBe("error");
    expect(error.status).toBe(400);
    expect(error.message).toContain("items.0: Expected number");
    expect(error.message).toContain("items.4: Expected number");
    expect(error.message).not.toContain("items.5");
    expect(error.message).toMatch(/and 5 more\.$/);
    const detail = error.detail as {
      issues: { path?: string; message: string }[];
      truncated: number;
    };
    expect(detail.issues).toHaveLength(7);
    expect(detail.truncated).toBe(3);
  });

  /**
   * @case A route's role refusal reads as a policy decision, not a bad credential
   * @preconditions The door answers 403 insufficient_permissions with no challenge
   * @expectedResult A "refused" failure saying the identity's current claims do not satisfy the route's policy, that a retry with the same credential will not help, and that a refreshed token carrying newly granted claims can
   */
  test("explains insufficient_permissions", async () => {
    const error = await dispatchAgainst(403, {
      error: "forbidden",
      reason: "insufficient_permissions",
    });

    expect(error.kind).toBe("refused");
    expect(error.message).toMatch(
      /route's policy does not admit this identity/,
    );
    expect(error.message).toMatch(/claims its credential carries/);
    expect(error.message).toMatch(/refreshed token carrying the new claims/);
    expect(error.message).not.toMatch(/new token for the same identity/);
  });

  /**
   * @case An anyScope refusal says one of the scopes suffices
   * @preconditions The door answers 403 insufficient_scope naming two scopes with scope_mode "any"
   * @expectedResult A "refused" failure naming both scopes and saying any one of them would do, rather than that the token needs all of them
   */
  test("explains an any-of scope refusal", async () => {
    const error = await dispatchAgainst(403, {
      error: "forbidden",
      reason: "insufficient_scope",
      scope: "leave:read leave:read:self",
      scope_mode: "any",
    });

    expect(error.kind).toBe("refused");
    expect(error.message).toContain("leave:read leave:read:self");
    expect(error.message).toMatch(/any one of which would do/);
  });
});
