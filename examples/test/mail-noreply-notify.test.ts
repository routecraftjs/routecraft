import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mail, type MailMessage } from "@routecraft/routecraft";
import {
  mockAdapter,
  testContext,
  type TestContext,
} from "@routecraft/testing";
import route from "../src/mail-noreply-notify";

describe("mail-noreply-notify", () => {
  let t: TestContext;

  beforeEach(() => {
    process.env["NOTIFY_TO"] = "me@personal.test";
  });

  afterEach(async () => {
    if (t) await t.stop();
    delete process.env["NOTIFY_TO"];
  });

  /**
   * @case mail source yields a no-reply email; the route transforms it and "sends" via the mail send destination
   * @preconditions A single mail() factory is used in both from() and to(); one mockAdapter covers both roles and dispatches on args
   * @expectedResult The send handler is invoked exactly once with the expected subject and a text body that includes the original sender
   */
  it("fans an IMAP fixture through to an SMTP send", async () => {
    const incoming: MailMessage = {
      uid: 42,
      messageId: "<msg42@noreply.test>",
      from: "noreply@acme.test",
      to: "me@work.test",
      subject: "Your order has shipped",
      date: new Date("2026-04-15T10:00:00Z"),
      flags: new Set(),
      folder: "INBOX",
      body: { text: "Tracking: ABC123" },
    };

    const mailMock = mockAdapter(mail, {
      // Source role: .from(mail("INBOX", ...)) receives this fixture array.
      source: [incoming],
      // Destination role: .to(mail()) is invoked with the transformed payload.
      // Returning a send result mirrors what the real SMTP send would produce.
      send: async (exchange, { args }) => {
        // args[0] is whatever the route passed to mail(); for the source call
        // this would be "INBOX", so we only expect the send handler to run
        // when mail() was invoked with no args.
        expect(args[0]).toBeUndefined();
        // The SMTP payload is the exchange body at the .to() call site.
        const payload = exchange.body as {
          to: string;
          subject: string;
          text: string;
        };
        return {
          messageId: `<sent-${payload.subject}@test>`,
          accepted: [payload.to],
          rejected: [],
          response: "250 OK",
        };
      },
    });

    t = await testContext().override(mailMock).routes(route).build();
    await t.test();

    // Source was subscribed once and yielded the one fixture.
    expect(mailMock.calls.source).toHaveLength(1);
    expect(mailMock.calls.source[0].yielded).toBe(1);

    // Send was invoked once, with the transformed notification payload.
    expect(mailMock.calls.send).toHaveLength(1);
    const sent = mailMock.calls.send[0].exchange.body as {
      to: string;
      subject: string;
      text: string;
    };
    expect(sent.to).toBe("me@personal.test");
    expect(sent.subject).toBe("Routecraft: processed a no-reply email");
    expect(sent.text).toContain("From: noreply@acme.test");
    expect(sent.text).toContain("Subject: Your order has shipped");
  });

  /**
   * @case Send failures surface as route errors; the send handler can reject to simulate SMTP outage
   * @preconditions Source delivers one message; send handler throws
   * @expectedResult The context records an error via context:error; the send handler was still invoked
   */
  it("surfaces send failures as route errors", async () => {
    const incoming: MailMessage = {
      uid: 1,
      messageId: "<m1@test>",
      from: "noreply@x.test",
      to: "me@work.test",
      subject: "x",
      date: new Date(),
      flags: new Set(),
      folder: "INBOX",
      body: {},
    };

    const mailMock = mockAdapter(mail, {
      source: [incoming],
      send: async () => {
        throw new Error("SMTP 421 Service not available");
      },
    });

    t = await testContext().override(mailMock).routes(route).build();
    await t.test();

    expect(mailMock.calls.send).toHaveLength(1);
    expect(t.errors.length).toBeGreaterThan(0);
    expect(String(t.errors[0])).toContain("SMTP 421");
  });
});
