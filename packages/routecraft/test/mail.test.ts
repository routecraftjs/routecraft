import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import {
  craft,
  simple,
  mail,
  ADAPTER_MAIL_OPTIONS,
} from "@routecraft/routecraft";

// Mock functions declared at module scope for vi.mock hoisting
const mockFetch = vi.fn();
const mockMailboxOpen = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockIdle = vi.fn();
const mockSendMail = vi.fn();

const mockImapFlowConstructor = vi.fn();

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      constructor(config: Record<string, unknown>) {
        mockImapFlowConstructor(config);
        return {
          connect: mockConnect,
          logout: mockLogout,
          mailboxOpen: mockMailboxOpen,
          fetch: mockFetch,
          messageFlagsAdd: mockMessageFlagsAdd,
          idle: mockIdle,
        };
      }
    },
  };
});

vi.mock("mailparser", () => ({
  simpleParser: vi.fn().mockResolvedValue({
    text: "Hello world",
    html: "<p>Hello world</p>",
    attachments: [],
  }),
}));

vi.mock("nodemailer", () => ({
  createTransport: vi.fn().mockReturnValue({
    sendMail: mockSendMail,
  }),
}));

describe("Mail Adapter", () => {
  let t: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockLogout.mockResolvedValue(undefined);
    mockMailboxOpen.mockResolvedValue({ exists: 1 });
    mockMessageFlagsAdd.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    if (t) {
      await t.stop();
    }
  });

  describe("Factory overloads", () => {
    /**
     * @case mail('INBOX', options) returns a Source
     * @preconditions Two string + object arguments
     * @expectedResult Returns adapter with subscribe method (Source)
     */
    test("mail(folder, options) returns a Source", () => {
      const adapter = mail("INBOX", { markSeen: true });
      expect(adapter).toHaveProperty("subscribe");
      expect(adapter).not.toHaveProperty("send");
    });

    /**
     * @case mail('INBOX') returns a Fetch Destination
     * @preconditions Single string argument
     * @expectedResult Returns adapter with send method (Destination)
     */
    test("mail(folder) returns a Fetch Destination", () => {
      const adapter = mail("INBOX");
      expect(adapter).toHaveProperty("send");
      expect(adapter).not.toHaveProperty("subscribe");
    });

    /**
     * @case mail({ folder: 'INBOX' }) returns a Fetch Destination
     * @preconditions Object with server keys
     * @expectedResult Returns adapter with send method (Destination) and adapterId
     */
    test("mail({ folder }) returns a Fetch Destination", () => {
      const adapter = mail({ folder: "INBOX" });
      expect(adapter).toHaveProperty("send");
      expect(adapter).toHaveProperty("adapterId", "routecraft.adapter.mail");
    });

    /**
     * @case mail() returns a Send Destination
     * @preconditions No arguments
     * @expectedResult Returns adapter with send method (Destination)
     */
    test("mail() returns a Send Destination", () => {
      const adapter = mail();
      expect(adapter).toHaveProperty("send");
      expect(adapter).not.toHaveProperty("subscribe");
    });

    /**
     * @case mail({ from: '...' }) returns a Send Destination
     * @preconditions Object with client-only keys
     * @expectedResult Returns adapter with send method (Destination)
     */
    test("mail({ from }) returns a Send Destination", () => {
      const adapter = mail({ from: "me@example.com" });
      expect(adapter).toHaveProperty("send");
      expect(adapter).not.toHaveProperty("subscribe");
    });
  });

  describe("Fetch Destination (IMAP)", () => {
    /**
     * @case Fetches unseen messages from IMAP and returns them
     * @preconditions ImapFlow mock returns messages
     * @expectedResult Returns MailMessage array with parsed content
     */
    test("fetches messages from IMAP", async () => {
      const messages = [
        {
          uid: 1,
          flags: new Set(["\\Recent"]),
          envelope: {
            messageId: "<msg1@example.com>",
            from: [{ address: "sender@example.com" }],
            to: [{ address: "me@example.com" }],
            subject: "Test Email",
            date: new Date("2026-03-17"),
          },
          source: Buffer.from("raw email content"),
        },
      ];

      // Make fetch return an async iterable
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          for (const msg of messages) {
            yield msg;
          }
        },
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("test-fetch")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(mockConnect).toHaveBeenCalled();
      expect(mockMailboxOpen).toHaveBeenCalledWith("INBOX");
      expect(mockFetch).toHaveBeenCalled();
      expect(mockLogout).toHaveBeenCalled();

      expect(s.received).toHaveLength(1);
      // Default enrich aggregator spreads array onto body with numeric keys
      const body = s.received[0].body as any;
      expect(body["0"]).toBeDefined();
      expect(body["0"].uid).toBe(1);
      expect(body["0"].from).toBe("sender@example.com");
      expect(body["0"].subject).toBe("Test Email");
      expect(body["0"].text).toBe("Hello world");
    });

    /**
     * @case Marks messages as seen after fetch
     * @preconditions markSeen is true (default)
     * @expectedResult messageFlagsAdd called with \\Seen
     */
    test("marks messages as seen", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            uid: 42,
            flags: new Set([]),
            envelope: {
              messageId: "<msg42@example.com>",
              from: [{ address: "a@b.com" }],
              to: [{ address: "c@d.com" }],
              subject: "Seen test",
              date: new Date(),
            },
            source: Buffer.from("content"),
          };
        },
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("test-seen")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(mockMessageFlagsAdd).toHaveBeenCalledWith("42", ["\\Seen"], {
        uid: true,
      });
    });

    /**
     * @case Returns empty array when no messages
     * @preconditions ImapFlow fetch returns no messages
     * @expectedResult Empty MailMessage array
     */
    test("returns empty array when no messages", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          // No messages
        },
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("test-empty")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      // Default enrich aggregator merges empty array into body
      // empty array spread produces no keys, so original body stays
      const body = s.received[0].body as any;
      expect(body).toBeDefined();
    });
  });

  describe("Send Destination (SMTP)", () => {
    /**
     * @case Sends email via SMTP with payload from exchange body
     * @preconditions Nodemailer mock accepts message
     * @expectedResult sendMail called with correct options, returns MailSendResult
     */
    test("sends email via SMTP", async () => {
      mockSendMail.mockResolvedValue({
        messageId: "<sent@example.com>",
        accepted: ["recipient@example.com"],
        rejected: [],
        response: "250 OK",
      });

      const s = spy();
      const sendAdapter = mail({
        host: "smtp.test.com",
        auth: { user: "u", pass: "p" },
        from: "me@test.com",
      });

      t = await testContext()
        .routes(
          craft()
            .id("test-send")
            .from(
              simple({
                to: "recipient@example.com",
                subject: "Hello",
                text: "World",
              }),
            )
            .to(sendAdapter as any)
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "me@test.com",
          to: "recipient@example.com",
          subject: "Hello",
          text: "World",
        }),
      );
    });
  });

  describe("MergedOptions", () => {
    /**
     * @case Context store auth merges with adapter-level folder
     * @preconditions Auth set in context store, folder set on adapter
     * @expectedResult IMAP connects with store auth and adapter folder
     */
    test("context store config merges with adapter options", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          // No messages
        },
      });

      const s = spy();

      t = await testContext()
        .store(ADAPTER_MAIL_OPTIONS, {
          auth: { user: "context@gmail.com", pass: "ctx-pass" },
          imapHost: "imap.gmail.com",
          imapPort: 993,
        })
        .routes(
          craft()
            .id("test-merged")
            .from(simple("trigger"))
            .enrich(mail({ folder: "Drafts" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      // ImapFlow constructor should have been called with context store values
      expect(mockImapFlowConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "imap.gmail.com",
          port: 993,
          auth: { user: "context@gmail.com", pass: "ctx-pass" },
        }),
      );

      // Folder should be the adapter-level override
      expect(mockMailboxOpen).toHaveBeenCalledWith("Drafts");
    });

    /**
     * @case Adapter-level auth overrides context store auth
     * @preconditions Both context store and adapter have auth
     * @expectedResult Adapter auth takes precedence
     */
    test("adapter options override context store", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {},
      });

      const s = spy();

      t = await testContext()
        .store(ADAPTER_MAIL_OPTIONS, {
          auth: { user: "ctx@gmail.com", pass: "ctx-pass" },
          imapHost: "imap.gmail.com",
        })
        .routes(
          craft()
            .id("test-override")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "custom-imap.example.com",
                auth: { user: "override@example.com", pass: "override-pass" },
              }),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(mockImapFlowConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "custom-imap.example.com",
          auth: { user: "override@example.com", pass: "override-pass" },
        }),
      );
    });

    /**
     * @case SMTP merged options use smtpHost from context store
     * @preconditions smtpHost and auth set in context store
     * @expectedResult Nodemailer transporter created with store values
     */
    test("SMTP uses smtpHost from context store", async () => {
      mockSendMail.mockResolvedValue({
        messageId: "<sent@test.com>",
        accepted: ["to@test.com"],
        rejected: [],
        response: "250 OK",
      });

      const s = spy();

      const sendAdapter = mail();

      t = await testContext()
        .store(ADAPTER_MAIL_OPTIONS, {
          auth: { user: "me@gmail.com", pass: "app-pass" },
          smtpHost: "smtp.gmail.com",
          smtpPort: 465,
          from: "me@gmail.com",
          replyTo: "me@gmail.com",
        })
        .routes(
          craft()
            .id("test-smtp-merged")
            .from(
              simple({
                to: "to@test.com",
                subject: "Test",
                text: "Body",
              }),
            )
            .to(sendAdapter as any)
            .to(s),
        )
        .build();

      await t.ctx.start();

      const nodemailer = await import("nodemailer");
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.gmail.com",
          port: 465,
          auth: { user: "me@gmail.com", pass: "app-pass" },
        }),
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "me@gmail.com",
          replyTo: "me@gmail.com",
        }),
      );
    });
  });

  describe("Error handling", () => {
    /**
     * @case Throws RC5003 when no IMAP host configured
     * @preconditions No host in adapter options or context store
     * @expectedResult RoutecraftError with code RC5003
     */
    test("throws RC5003 when IMAP host missing", async () => {
      const adapter = mail({ folder: "INBOX", auth: { user: "u", pass: "p" } });
      const exchange = {
        id: "test",
        headers: {},
        body: {},
        logger: console,
      } as any;

      await expect((adapter as any).send(exchange)).rejects.toMatchObject({
        rc: "RC5003",
      });
    });

    /**
     * @case Throws RC5003 when no SMTP host configured
     * @preconditions No host in adapter options or context store
     * @expectedResult RoutecraftError with code RC5003
     */
    test("throws RC5003 when SMTP host missing", async () => {
      const adapter = mail({ from: "me@test.com" });
      const exchange = {
        id: "test",
        headers: {},
        body: { to: "x@x.com", subject: "s" },
        logger: console,
      } as any;

      await expect((adapter as any).send(exchange)).rejects.toMatchObject({
        rc: "RC5003",
      });
    });

    /**
     * @case Throws RC5010 on IMAP connection failure
     * @preconditions ImapFlow connect throws network error
     * @expectedResult RoutecraftError with code RC5010
     */
    test("throws RC5010 on IMAP connection failure", async () => {
      mockConnect.mockRejectedValue(new Error("ECONNREFUSED"));

      const adapter = mail({
        folder: "INBOX",
        host: "imap.test.com",
        auth: { user: "u", pass: "p" },
      });
      const exchange = {
        id: "test",
        headers: {},
        body: {},
        logger: console,
      } as any;

      await expect((adapter as any).send(exchange)).rejects.toMatchObject({
        rc: "RC5010",
      });
    });

    /**
     * @case Throws RC5011 on IMAP auth failure
     * @preconditions ImapFlow connect throws authentication error
     * @expectedResult RoutecraftError with code RC5011
     */
    test("throws RC5011 on IMAP auth failure", async () => {
      mockConnect.mockRejectedValue(new Error("AUTHENTICATIONFAILED"));

      const adapter = mail({
        folder: "INBOX",
        host: "imap.test.com",
        auth: { user: "u", pass: "wrong" },
      });
      const exchange = {
        id: "test",
        headers: {},
        body: {},
        logger: console,
      } as any;

      await expect((adapter as any).send(exchange)).rejects.toMatchObject({
        rc: "RC5011",
      });
    });
  });
});
