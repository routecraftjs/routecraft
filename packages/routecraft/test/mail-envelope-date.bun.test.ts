import { describe, expect, test } from "bun:test";
import { toMailMessage } from "../src/adapters/mail/shared.ts";

describe("mail envelope date", () => {
  /**
   * @case An unparseable Date header does not reach the route as a string
   * @preconditions An envelope whose date is the raw header text, which is what imapflow hands back when it cannot parse it
   * @expectedResult MailMessage.date is a valid Date
   */
  test("falls back to now when the envelope date is not a Date", () => {
    const before = Date.now();
    const message = toMailMessage(
      { uid: 1, flags: [], envelope: { date: "not a date at all" } },
      "INBOX",
    );
    expect(message.date).toBeInstanceOf(Date);
    expect(message.date.getTime()).toBeGreaterThanOrEqual(before);
  });

  /**
   * @case An Invalid Date object does not reach the route
   * @preconditions An envelope whose date is a Date that holds NaN, which imapflow 1 can hand back
   * @expectedResult MailMessage.date is a valid Date
   */
  test("falls back to now when the envelope date is an Invalid Date", () => {
    const message = toMailMessage(
      { uid: 1, flags: [], envelope: { date: new Date("nope") } },
      "INBOX",
    );
    expect(Number.isNaN(message.date.getTime())).toBe(false);
  });

  /**
   * @case A parsed Date header is kept
   * @preconditions An envelope whose date is a Date
   * @expectedResult MailMessage.date is that same instant
   */
  test("keeps a parsed envelope date", () => {
    const date = new Date("2026-03-17T10:00:00Z");
    const message = toMailMessage(
      { uid: 1, flags: [], envelope: { date } },
      "INBOX",
    );
    expect(message.date.getTime()).toBe(date.getTime());
  });
});
