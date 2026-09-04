import { describe, expect, test } from "bun:test";

const { createOpsClient } = await import("../src/ops-client");
const { SettingsError } = await import("../src/settings");
import type { ResolvedSettings } from "../src/settings";

/**
 * The client every instance-reaching command is built over. What it refuses
 * before the first request is the contract here: a credential must not
 * leave the machine in clear text because two settings sources agreed on
 * it separately.
 */

function settings(url: string, token?: string): ResolvedSettings {
  return {
    url: { value: url, source: "flag" },
    token:
      token === undefined ? undefined : { value: token, source: "environment" },
    format: { value: "json", source: "default" },
  };
}

describe("ops client", () => {
  /**
   * @case A bearer token over plain http to a non-loopback host is refused before any request
   * @preconditions Settings whose URL is http://ops.example:8080 and whose token is set
   * @expectedResult createOpsClient throws a SettingsError naming the URL, its source, the token's source and the https or loopback remedy
   */
  test("refuses a token over plain http to a remote host", () => {
    expect(() =>
      createOpsClient(settings("http://ops.example:8080", "t")),
    ).toThrow(SettingsError);
    expect(() =>
      createOpsClient(settings("http://ops.example:8080", "t")),
    ).toThrow(
      /flag.*http:\/\/ops\.example:8080.*environment.*clear text.*https.*loopback/s,
    );
  });

  /**
   * @case The refusal does not reach loopback addresses, https, or a run without a token
   * @preconditions Settings with a token over http://localhost, http://127.0.0.1, http://127.255.0.1, http://[::1]; over https://ops.example; and over http://ops.example without a token
   * @expectedResult Every one builds a client, the token-bearing ones reporting authenticated
   */
  test("allows loopback, https and anonymous http", () => {
    for (const url of [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://127.255.0.1:8080",
      "http://[::1]:8080",
      "https://ops.example",
    ]) {
      expect(createOpsClient(settings(url, "t")).authenticated).toBe(true);
    }
    expect(createOpsClient(settings("http://ops.example")).authenticated).toBe(
      false,
    );
  });
});
