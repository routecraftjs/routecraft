import "./env-placeholders";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer, type Server } from "node:http";
import { testContext, type TestContext } from "@routecraft/testing";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import {
  judgeRoute,
  judgementFrom,
  screen,
  type JudgeEvidence,
  type Judgement,
} from "../src/jev-judge";

const evidence: JudgeEvidence = {
  request: { subject: "Archive last month's invoices" },
  account: "I archived all 14 invoices from August.",
  toolCalls: [{ toolName: "archive-invoice", failed: false, error: null }],
};

const answer = (probability: number) =>
  JSON.stringify({
    model: "jev-1.13.0",
    answers: { met: { type: "noul", noul: probability } },
    usage: { input_tokens: 120, output_tokens: 4 },
  });

/**
 * A client whose transport answers with a fixed probability and records the
 * request body, so the screening stage runs end to end with no key and no
 * network.
 */
const stubbedClient = (probability: number) => {
  const sent: unknown[] = [];
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(answer(probability), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  return { client, sent };
};

describe("screen()", () => {
  /**
   * @case Screen evidence against a transport that answers 0.94.
   * @preconditions Stubbed client; no API key in the environment
   * @expectedResult The probability comes back untouched, with no decision
   *   attached: the threshold belongs to the route, not to the screen
   */
  test("returns the probability and nothing else", async () => {
    const { client } = stubbedClient(0.94);

    expect(await screen(evidence, client)).toEqual({ met: 0.94 });
  });

  /**
   * @case Inspect the request the screening stage actually sends.
   * @preconditions Stubbed transport capturing the serialised request body
   * @expectedResult One noul question named `met` carrying the evidence as
   *   state, which is what keeps the answer map typed as a single probability
   */
  test("sends the evidence as state and one named noul question", async () => {
    const { client, sent } = stubbedClient(0.9);

    await screen(evidence, client);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      model: "jev-latest",
      state: evidence,
      questions: { met: { type: "noul" } },
    });
  });
});

describe("judgementFrom()", () => {
  const verdict: Judgement = {
    met: false,
    reason: "Two invoices were skipped.",
  };

  /**
   * @case The reasoning judge produced a verdict.
   * @preconditions Body carries both a screen probability and a verdict
   * @expectedResult The verdict wins regardless of the probability
   */
  test("returns the reasoning verdict when there is one", () => {
    expect(judgementFrom({ screen: { met: 0.1 }, verdict })).toEqual(verdict);
  });

  /**
   * @case The screen was confident (0.94) and nobody asked the reasoning judge.
   * @preconditions No verdict on the body
   * @expectedResult A synthetic pass whose reason records the probability and
   *   that no reasoning call was made
   */
  test("synthesises a pass only above the threshold", () => {
    expect(judgementFrom({ screen: { met: 0.94 } })).toEqual({
      met: true,
      reason: "Screened as met with probability 0.94; no reasoning call made.",
    });
  });

  /**
   * @case The screen was not confident (0.02), so the reasoning judge was
   *   asked, and it returned nothing the schema accepted.
   * @preconditions No verdict on the body; probability below the threshold
   * @expectedResult An error, never a pass: a missing verdict after an
   *   escalation must fail closed
   */
  test("fails closed when an escalation produced no verdict", () => {
    expect(() => judgementFrom({ screen: { met: 0.02 } })).toThrow(
      "Reasoning judge returned no usable verdict",
    );
  });

  /**
   * @case The screen could not answer at all (NaN) and the escalation produced
   *   no verdict.
   * @preconditions No verdict on the body; probability is NaN
   * @expectedResult An error, since NaN never satisfies the threshold
   */
  test("treats an unanswered screen as below the threshold", () => {
    expect(() => judgementFrom({ screen: { met: Number.NaN } })).toThrow();
  });
});

describe("judge-agent-result capability", () => {
  let server: Server;
  let probability = 0.94;
  let t: TestContext;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(answer(probability));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    // The client is built lazily on first use, so the stub's address has to be
    // in the environment before the first dispatch reaches it.
    process.env["TYPESAFE_API_KEY"] ??= "test-key";
    process.env["TYPESAFE_BASE_URL"] = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    if (t) await t.stop();
  });

  /**
   * @case Dispatch evidence the screen scores 0.94 through the whole
   *   capability: input validation, the screen enrich, the choice, and the
   *   final transform.
   * @preconditions Stub server answering as Jev; no LLM provider reachable,
   *   so an escalation would fail rather than pass
   * @expectedResult The synthetic pass verdict, which proves the reasoning
   *   judge was never called
   */
  test("a confident screen short-circuits the reasoning judge", async () => {
    probability = 0.94;
    t = await testContext().routes([judgeRoute]).build();
    await t.startAndWaitReady();

    const result = await t.client.sendDirect<JudgeEvidence, Judgement>(
      "judge-agent-result",
      evidence,
    );

    expect(result).toEqual({
      met: true,
      reason: "Screened as met with probability 0.94; no reasoning call made.",
    });
  });
});
