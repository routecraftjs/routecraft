import { describe, expect, test } from "bun:test";
import { TypeSafeClient } from "@typesafe-ai/sdk";
// The example re-exports `craftConfig`, which imports `../src/env.ts` and
// validates required env vars with Zod at module load. Set placeholders
// BEFORE the dynamic import; the values are unused here, because the
// screening client is stubbed and the reasoning judge is never reached.
process.env["JWT_SECRET"] ??= "test-jwt-secret";
process.env["MAIL_USER"] ??= "test@example.test";
process.env["MAIL_APP_PASSWORD"] ??= "test-pw";
process.env["GEMINI_API_KEY"] ??= "test-gemini";

const { screen } = await import("../src/jev-judge");
type JudgeEvidence = import("../src/jev-judge").JudgeEvidence;

const evidence: JudgeEvidence = {
  request: { subject: "Archive last month's invoices" },
  account: "I archived all 14 invoices from August.",
  toolCalls: [{ toolName: "archive-invoice", failed: false }],
};

/**
 * Build a client whose transport answers with a fixed noul probability and
 * records the request body, so the screening stage runs end to end without
 * an API key or a network call.
 */
const stubbedClient = (probability: number) => {
  const sent: unknown[] = [];
  const client = new TypeSafeClient({
    apiKey: "test-key",
    retry: { maxRetries: 0 },
    fetch: async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: { met: { type: "noul", noul: probability } },
          usage: { input_tokens: 120, output_tokens: 4 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  });
  return { client, sent };
};

describe("Jev judge screening", () => {
  /**
   * @case Screen evidence the model is confident about (0.94, above the 0.85
   *   confident-pass threshold).
   * @preconditions Stubbed transport returning a single noul answer; no API key set
   * @expectedResult The probability is passed through and escalate is false, so the
   *   route skips the reasoning judge
   */
  test("a confident yes does not escalate", async () => {
    const { client } = stubbedClient(0.94);

    expect(await screen(evidence, client)).toEqual({
      met: 0.94,
      escalate: false,
    });
  });

  /**
   * @case Screen evidence the model is unsure about (0.6, below the threshold).
   * @preconditions Stubbed transport returning a single noul answer
   * @expectedResult escalate is true, so the route falls through to the reasoning
   *   judge that can produce a reason
   */
  test("an uncertain answer escalates", async () => {
    const { client } = stubbedClient(0.6);

    expect(await screen(evidence, client)).toEqual({
      met: 0.6,
      escalate: true,
    });
  });

  /**
   * @case Screen evidence the model confidently rejects (0.02).
   * @preconditions Stubbed transport returning a single noul answer
   * @expectedResult escalate is still true: a confident fail needs prose the
   *   System One model cannot generate, so certainty alone never short-circuits
   */
  test("a confident no still escalates, because the verdict needs a reason", async () => {
    const { client } = stubbedClient(0.02);

    expect(await screen(evidence, client)).toEqual({
      met: 0.02,
      escalate: true,
    });
  });

  /**
   * @case Inspect the request the screening stage actually sends.
   * @preconditions Stubbed transport capturing the serialised request body
   * @expectedResult One noul question named `met` carrying the evidence as state,
   *   which is what keeps the answer map typed as a single probability
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
