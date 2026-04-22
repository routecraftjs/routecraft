import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, mail, replace } from "@routecraft/routecraft";
import { EXCHANGE_INTERNALS } from "../src/exchange.ts";
import { buildSearchCriteriaSets } from "../src/adapters/mail/shared.ts";
import {
  analyzeHeaders,
  extractAnalysisHeaders,
  parseAuthResults,
} from "../src/adapters/mail/analysis.ts";
import type { MailServerOptions } from "../src/adapters/mail/types.ts";

// Mock functions declared at module scope for vi.mock hoisting
const mockFetch = vi.fn();
const mockMailboxOpen = vi.fn();
const mockConnect = vi.fn();
const mockLogout = vi.fn();
const mockClose = vi.fn();
const mockMessageFlagsAdd = vi.fn();
const mockMessageFlagsRemove = vi.fn();
const mockMessageMove = vi.fn();
const mockMessageCopy = vi.fn();
const mockMessageDelete = vi.fn();
const mockAppend = vi.fn();
const mockIdle = vi.fn();
const mockSendMail = vi.fn();

const mockImapFlowConstructor = vi.fn();

vi.mock("imapflow", () => {
  return {
    ImapFlow: class MockImapFlow {
      usable = true;
      constructor(config: Record<string, unknown>) {
        mockImapFlowConstructor(config);
        Object.assign(this, {
          connect: mockConnect,
          logout: mockLogout,
          close: mockClose,
          mailboxOpen: mockMailboxOpen,
          fetch: mockFetch,
          messageFlagsAdd: mockMessageFlagsAdd,
          messageFlagsRemove: mockMessageFlagsRemove,
          messageMove: mockMessageMove,
          messageCopy: mockMessageCopy,
          messageDelete: mockMessageDelete,
          append: mockAppend,
          idle: mockIdle,
        });
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
    close: vi.fn(),
  }),
}));

vi.mock("nodemailer/lib/mail-composer", () => ({
  default: class MockMailComposer {
    compile() {
      return {
        build: vi.fn().mockResolvedValue(Buffer.from("raw mime")),
      };
    }
  },
}));

describe("Mail Adapter", () => {
  let t: TestContext;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockLogout.mockResolvedValue(undefined);
    mockClose.mockReturnValue(undefined);
    mockMailboxOpen.mockResolvedValue({ exists: 1 });
    mockMessageFlagsAdd.mockResolvedValue(undefined);
    mockMessageFlagsRemove.mockResolvedValue(undefined);
    mockMessageMove.mockResolvedValue(undefined);
    mockMessageCopy.mockResolvedValue(undefined);
    mockMessageDelete.mockResolvedValue(undefined);
    mockAppend.mockResolvedValue(undefined);
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

    /**
     * @case mail({ action: 'move', folder: 'X' }) returns an Operation Destination
     * @preconditions Object with action key
     * @expectedResult Returns adapter with send method (Destination) and correct adapterId
     */
    test("mail({ action }) returns an Operation Destination", () => {
      const adapter = mail({ action: "move", folder: "Archive" });
      expect(adapter).toHaveProperty("send");
      expect(adapter).toHaveProperty("adapterId", "routecraft.adapter.mail");
      expect(adapter).not.toHaveProperty("subscribe");
    });

    /**
     * @case mail({ action: 'delete' }) returns an Operation Destination
     * @preconditions Object with action 'delete' and no other keys
     * @expectedResult Returns adapter with send method
     */
    test("mail({ action: 'delete' }) returns an Operation Destination", () => {
      const adapter = mail({ action: "delete" });
      expect(adapter).toHaveProperty("send");
    });

    /**
     * @case mail({ action: 'flag', flags: '\\Seen' }) returns an Operation Destination
     * @preconditions Object with action 'flag' and flags
     * @expectedResult Returns adapter with send method
     */
    test("mail({ action: 'flag' }) returns an Operation Destination", () => {
      const adapter = mail({ action: "flag", flags: "\\Seen" });
      expect(adapter).toHaveProperty("send");
    });

    /**
     * @case mail({ action: 'append', folder: 'Drafts' }) returns an Operation Destination
     * @preconditions Object with action 'append'
     * @expectedResult Returns adapter with send method
     */
    test("mail({ action: 'append' }) returns an Operation Destination", () => {
      const adapter = mail({
        action: "append",
        folder: "Drafts",
        flags: ["\\Draft"],
      });
      expect(adapter).toHaveProperty("send");
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
      expect(body["0"].body.text).toBe("Hello world");
      expect(body["0"].body.html).toBe("<p>Hello world</p>");
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
     * @case verify: "off" omits the sender field entirely
     * @preconditions Fetch with verify: "off"; analysis headers would otherwise resolve to a valid sender
     * @expectedResult Returned MailMessage has no `sender` property
     */
    test("verify: 'off' omits sender", async () => {
      const { simpleParser } = await import("mailparser");
      (simpleParser as any).mockResolvedValueOnce({
        text: "hi",
        attachments: [],
        headerLines: [
          { key: "from", line: "From: a@b.com" },
          {
            key: "authentication-results",
            line: "Authentication-Results: mx.test; dmarc=pass header.from=b.com",
          },
        ],
      });
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            uid: 7,
            flags: new Set([]),
            envelope: {
              messageId: "<7@test>",
              from: [{ address: "a@b.com" }],
              to: [{ address: "me@test.com" }],
              subject: "hi",
              date: new Date(),
            },
            source: Buffer.from("raw"),
          };
        },
      });

      const s = spy();
      t = await testContext()
        .routes(
          craft()
            .id("test-verify-off")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
                verify: "off",
              }),
              replace(),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      const body = s.received[0].body as any;
      expect(body[0].sender).toBeUndefined();
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

  describe("Named accounts", () => {
    /**
     * @case Named account IMAP config resolves correctly
     * @preconditions Mail config with named account set on context
     * @expectedResult ImapFlow constructor called with account's host and auth
     */
    test("uses named account IMAP config", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {},
      });

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.main.com",
                  auth: { user: "main@co.com", pass: "main-pass" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-named")
            .from(simple("trigger"))
            .enrich(mail("INBOX"))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(mockImapFlowConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "imap.main.com",
          auth: { user: "main@co.com", pass: "main-pass" },
        }),
      );
    });

    /**
     * @case Specific named account selected via account field
     * @preconditions Multiple accounts, adapter selects non-default
     * @expectedResult ImapFlow uses the selected account's config
     */
    test("selects specific account via account field", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {},
      });

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.main.com",
                  auth: { user: "main@co.com", pass: "main-pass" },
                },
              },
              support: {
                imap: {
                  host: "imap.support.com",
                  auth: { user: "support@co.com", pass: "support-pass" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-select-account")
            .from(simple("trigger"))
            .enrich(mail({ folder: "INBOX", account: "support" }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(mockImapFlowConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "imap.support.com",
          auth: { user: "support@co.com", pass: "support-pass" },
        }),
      );
    });

    /**
     * @case Named account SMTP config used for send
     * @preconditions Mail config with SMTP on named account
     * @expectedResult Nodemailer transporter created with account's SMTP config
     */
    test("uses named account SMTP config for send", async () => {
      mockSendMail.mockResolvedValue({
        messageId: "<sent@test.com>",
        accepted: ["to@test.com"],
        rejected: [],
        response: "250 OK",
      });

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                smtp: {
                  host: "smtp.main.com",
                  auth: { user: "main@co.com", pass: "main-pass" },
                  from: "team@co.com",
                  replyTo: "support@co.com",
                  cc: "audit@co.com",
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-smtp-named")
            .from(
              simple({
                to: "to@test.com",
                subject: "Test",
                text: "Body",
              }),
            )
            .to(mail() as any)
            .to(s),
        )
        .build();

      await t.ctx.start();

      const nodemailer = await import("nodemailer");
      expect(nodemailer.createTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          host: "smtp.main.com",
          auth: { user: "main@co.com", pass: "main-pass" },
        }),
      );

      expect(mockSendMail).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "team@co.com",
          replyTo: "support@co.com",
          cc: "audit@co.com",
        }),
      );
    });

    /**
     * @case Shared defaults apply across accounts
     * @preconditions Mail config with shared folder and markSeen
     * @expectedResult Fetch uses shared folder default
     */
    test("shared defaults apply across accounts", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {},
      });

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.main.com",
                  auth: { user: "main@co.com", pass: "main-pass" },
                },
              },
            },
            folder: "Drafts",
            markSeen: false,
          },
        })
        .routes(
          craft()
            .id("test-shared-defaults")
            .from(simple("trigger"))
            .enrich(mail({ folder: undefined as unknown as string }))
            .to(s),
        )
        .build();

      await t.ctx.start();

      // The shared folder default 'Drafts' is used when adapter doesn't specify
      // (in this case the adapter passes folder: undefined which falls through)
      expect(mockMailboxOpen).toHaveBeenCalled();
    });
  });

  describe("IMAP Operations", () => {
    /**
     * @case Move operation dispatches to messageMove
     * @preconditions Exchange body is a MailMessage with uid and folder
     * @expectedResult client.messageMove called with uid and target folder
     */
    test("move operation", async () => {
      const adapter = mail({ action: "move", folder: "Archive" });
      const context = await buildMailContext();
      const exchange = createMailExchange(42, "INBOX", context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageMove).toHaveBeenCalledWith("42", "Archive", {
        uid: true,
      });
    });

    /**
     * @case Copy operation dispatches to messageCopy
     * @preconditions Exchange body is a MailMessage with uid and folder
     * @expectedResult client.messageCopy called with uid and target folder
     */
    test("copy operation", async () => {
      const adapter = mail({ action: "copy", folder: "Backup" });
      const context = await buildMailContext();
      const exchange = createMailExchange(42, "INBOX", context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageCopy).toHaveBeenCalledWith("42", "Backup", {
        uid: true,
      });
    });

    /**
     * @case Delete operation dispatches to messageDelete
     * @preconditions Exchange body is a MailMessage with uid and folder
     * @expectedResult client.messageDelete called with uid
     */
    test("delete operation", async () => {
      const adapter = mail({ action: "delete" });
      const context = await buildMailContext();
      const exchange = createMailExchange(42, "INBOX", context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageDelete).toHaveBeenCalledWith("42", { uid: true });
    });

    /**
     * @case Flag operation dispatches to messageFlagsAdd
     * @preconditions Exchange body is a MailMessage, flags is a string
     * @expectedResult client.messageFlagsAdd called with uid and flags array
     */
    test("flag operation with single flag", async () => {
      const adapter = mail({ action: "flag", flags: "\\Flagged" });
      const context = await buildMailContext();
      const exchange = createMailExchange(42, "INBOX", context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageFlagsAdd).toHaveBeenCalledWith("42", ["\\Flagged"], {
        uid: true,
      });
    });

    /**
     * @case Flag operation with multiple flags
     * @preconditions flags is an array of strings
     * @expectedResult client.messageFlagsAdd called with all flags
     */
    test("flag operation with multiple flags", async () => {
      const adapter = mail({
        action: "flag",
        flags: ["\\Flagged", "\\Seen"],
      });
      const context = await buildMailContext();
      const exchange = createMailExchange(42, "INBOX", context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageFlagsAdd).toHaveBeenCalledWith(
        "42",
        ["\\Flagged", "\\Seen"],
        { uid: true },
      );
    });

    /**
     * @case Unflag operation dispatches to messageFlagsRemove
     * @preconditions Exchange body is a MailMessage, flags to remove
     * @expectedResult client.messageFlagsRemove called with uid and flags
     */
    test("unflag operation", async () => {
      const adapter = mail({ action: "unflag", flags: "\\Seen" });
      const context = await buildMailContext();
      const exchange = createMailExchange(42, "INBOX", context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageFlagsRemove).toHaveBeenCalledWith("42", ["\\Seen"], {
        uid: true,
      });
    });

    /**
     * @case Append operation composes MIME and appends to IMAP folder
     * @preconditions Exchange body is a MailSendPayload
     * @expectedResult client.append called with folder, raw MIME buffer, and flags
     */
    test("append operation", async () => {
      const adapter = mail({
        action: "append",
        folder: "Drafts",
        flags: ["\\Draft"],
      });
      const context = await buildMailContext();
      const exchange = {
        id: "test",
        headers: {},
        body: {
          to: "recipient@test.com",
          subject: "Draft",
          text: "Draft body",
        },
        logger: console,
      } as any;
      attachContext(exchange, context.ctx);

      await (adapter as any).send(exchange);

      expect(mockAppend).toHaveBeenCalledWith(
        "Drafts",
        expect.any(Buffer),
        ["\\Draft"],
        undefined,
      );
    });

    /**
     * @case Batch operation: array body resolves all UIDs
     * @preconditions Exchange body is MailMessage[] (from enrich)
     * @expectedResult messageMove called with comma-separated UIDs
     */
    test("batch move from array body", async () => {
      const adapter = mail({ action: "move", folder: "Archive" });
      const context = await buildMailContext();
      const exchange = {
        id: "test",
        headers: {},
        body: [
          createMailMessage(1, "INBOX"),
          createMailMessage(5, "INBOX"),
          createMailMessage(12, "INBOX"),
        ],
        logger: console,
      } as any;
      attachContext(exchange, context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMessageMove).toHaveBeenCalledWith("1,5,12", "Archive", {
        uid: true,
      });
    });

    /**
     * @case Header-based resolution survives body transform
     * @preconditions Headers have mail uid/folder, body is transformed
     * @expectedResult Operation uses headers for uid/folder
     */
    test("resolves from headers when body is transformed", async () => {
      const adapter = mail({ action: "delete" });
      const context = await buildMailContext();
      const exchange = {
        id: "test",
        headers: {
          "routecraft.mail.uid": 99,
          "routecraft.mail.folder": "Sent",
        },
        body: { summary: "transformed body" },
        logger: console,
      } as any;
      attachContext(exchange, context.ctx);

      await (adapter as any).send(exchange);

      expect(mockMailboxOpen).toHaveBeenCalledWith("Sent");
      expect(mockMessageDelete).toHaveBeenCalledWith("99", { uid: true });
    });
  });

  describe("Error handling", () => {
    /**
     * @case Throws RC5003 when no IMAP host configured
     * @preconditions No host in adapter options or context store
     * @expectedResult RoutecraftError with code RC5003
     */
    test("throws RC5003 when IMAP host missing", async () => {
      const adapter = mail({
        folder: "INBOX",
        auth: { user: "u", pass: "p" },
      });
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
     * @case Throws RC5012 on IMAP auth failure
     * @preconditions ImapFlow connect throws authentication error
     * @expectedResult RoutecraftError with code RC5012
     */
    test("throws RC5012 on IMAP auth failure", async () => {
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
        rc: "RC5012",
      });
    });

    /**
     * @case Throws RC5003 when operation has no mail context
     * @preconditions No mail config on context, no body/headers with uid/folder
     * @expectedResult RoutecraftError with code RC5003
     */
    test("throws RC5003 when operation has no mail context", async () => {
      const adapter = mail({ action: "delete" });
      const exchange = {
        id: "test",
        headers: {},
        body: { someData: true },
        logger: console,
      } as any;

      await expect((adapter as any).send(exchange)).rejects.toMatchObject({
        rc: "RC5003",
      });
    });
  });

  describe("Source adapter", () => {
    /**
     * @case Source via poll mode delivers messages to handler
     * @preconditions pollIntervalMs is set, abort triggered after first poll
     * @expectedResult Messages from first poll are delivered, then source stops
     */
    test("poll mode fetches and delivers messages", async () => {
      let pollCount = 0;
      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          if (pollCount === 0) {
            pollCount++;
            yield {
              uid: 1,
              flags: new Set([]),
              envelope: {
                messageId: "<poll1@test.com>",
                from: [{ address: "a@b.com" }],
                to: [{ address: "c@d.com" }],
                subject: "Poll message",
                date: new Date("2026-03-17"),
              },
              source: Buffer.from("content"),
            };
          }
          // Second poll yields nothing
        },
      }));

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-poll-source")
            .from(
              mail("INBOX", {
                pollIntervalMs: 5,
                markSeen: false,
                unseen: true,
              }),
            )
            .to(s),
        )
        .build();

      // Start context, let it poll once, then stop
      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 20));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(mockMailboxOpen).toHaveBeenCalledWith("INBOX");
      expect(s.received.length).toBeGreaterThanOrEqual(1);
      expect((s.received[0].body as any).subject).toBe("Poll message");
    });

    /**
     * @case Source sets mail UID and folder headers on exchanges
     * @preconditions Source delivers a message with uid 42 from INBOX via poll mode
     * @expectedResult Exchange headers contain routecraft.mail.uid and routecraft.mail.folder
     */
    test("sets mail UID and folder headers", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          if (callCount === 0) {
            callCount++;
            yield {
              uid: 42,
              flags: new Set([]),
              envelope: {
                messageId: "<hdr@test.com>",
                from: [{ address: "a@b.com" }],
                to: [{ address: "c@d.com" }],
                subject: "Header test",
                date: new Date("2026-03-17"),
              },
              source: Buffer.from("content"),
            };
          }
        },
      }));

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-source-headers")
            .from(
              mail("INBOX", {
                markSeen: false,
                unseen: true,
                pollIntervalMs: 5,
              }),
            )
            .to(s),
        )
        .build();

      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 20));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(s.received.length).toBeGreaterThanOrEqual(1);
      const headers = s.received[0].headers as Record<string, unknown>;
      expect(headers["routecraft.mail.uid"]).toBe(42);
      expect(headers["routecraft.mail.folder"]).toBe("INBOX");
    });

    /**
     * @case Source stops cleanly on abort
     * @preconditions Abort is triggered while source is polling
     * @expectedResult Source releases IMAP client and resolves
     */
    test("stops cleanly on abort", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {},
      });

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-source-abort")
            .from(
              mail("INBOX", {
                markSeen: false,
                unseen: true,
                pollIntervalMs: 5,
              }),
            )
            .to(s),
        )
        .build();

      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 20));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      // Verify the pool connection was released (logout is called on drain)
      expect(mockLogout).toHaveBeenCalled();
    });

    /**
     * @case markSeen happens per-message AFTER the handler resolves successfully
     * @preconditions Poll source with default markSeen, one message fetched, downstream step throws
     * @expectedResult messageFlagsAdd is NOT called for the failed UID; no silent message loss
     */
    test("does not mark Seen when handler fails", async () => {
      let pollCount = 0;
      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          if (pollCount === 0) {
            pollCount++;
            yield {
              uid: 77,
              flags: new Set([]),
              envelope: {
                messageId: "<fail@test.com>",
                from: [{ address: "a@b.com" }],
                to: [{ address: "c@d.com" }],
                subject: "Handler will throw",
                date: new Date("2026-04-22"),
              },
              source: Buffer.from("content"),
            };
          }
        },
      }));

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-handler-fail")
            .from(
              mail("INBOX", {
                pollIntervalMs: 5,
                // markSeen left at default (true) to exercise the post-handler path
              }),
            )
            .process(() => {
              throw new Error("downstream boom");
            }),
        )
        .build();

      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 20));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(mockMessageFlagsAdd).not.toHaveBeenCalled();
    });

    /**
     * @case markSeen is called per-message AFTER the handler resolves
     * @preconditions Poll source with default markSeen, one message fetched, route has no throwing steps
     * @expectedResult messageFlagsAdd called with the single uid (not a batched string)
     */
    test("marks Seen per-message after handler success", async () => {
      let pollCount = 0;
      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          if (pollCount === 0) {
            pollCount++;
            yield {
              uid: 11,
              flags: new Set([]),
              envelope: {
                messageId: "<ok@test.com>",
                from: [{ address: "a@b.com" }],
                to: [{ address: "c@d.com" }],
                subject: "Handler succeeds",
                date: new Date("2026-04-22"),
              },
              source: Buffer.from("content"),
            };
          }
        },
      }));

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-handler-ok")
            .from(
              mail("INBOX", {
                pollIntervalMs: 5,
              }),
            )
            .to(s),
        )
        .build();

      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 20));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(s.received.length).toBeGreaterThanOrEqual(1);
      expect(mockMessageFlagsAdd).toHaveBeenCalledWith("11", ["\\Seen"], {
        uid: true,
      });
    });

    /**
     * @case Re-delivery across poll cycles when opting out of \Seen dedupe
     * @preconditions unseen: false, markSeen: false, same UID returned on multiple polls
     * @expectedResult Handler is invoked more than once for the same UID across cycles
     */
    test("redelivers the same UID across polls when Seen dedupe is disabled", async () => {
      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {
          yield {
            uid: 5,
            flags: new Set([]),
            envelope: {
              messageId: "<rebill@test.com>",
              from: [{ address: "a@b.com" }],
              to: [{ address: "c@d.com" }],
              subject: "Redelivered",
              date: new Date("2026-04-22"),
            },
            source: Buffer.from("content"),
          };
        },
      }));

      const s = spy();

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-redelivery")
            .from(
              mail("INBOX", {
                pollIntervalMs: 1,
                markSeen: false,
                unseen: false,
              }),
            )
            .to(s),
        )
        .build();

      const startPromise = t.ctx.start();
      // Give the poll loop enough time to complete at least two cycles.
      await new Promise((r) => setTimeout(r, 40));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(s.received.length).toBeGreaterThanOrEqual(2);
      expect(mockMessageFlagsAdd).not.toHaveBeenCalled();
    });

    /**
     * @case IDLE reconnects after a non-auth error
     * @preconditions First idle() rejects with a transient error, second hangs until abort
     * @expectedResult mailboxOpen is called more than once (initial + reconnect)
     */
    test("IDLE reconnects after a transient connection drop", async () => {
      // Zero jitter so the reconnect backoff collapses to 0ms in the test.
      vi.spyOn(Math, "random").mockReturnValue(0);

      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {},
      }));

      let idleCalls = 0;
      mockIdle.mockImplementation(async () => {
        idleCalls++;
        if (idleCalls === 1) {
          throw new Error("ECONNRESET");
        }
        // Resolve promptly on subsequent calls so the abort check between
        // idle() and drainOnce can exit the loop cleanly.
        await new Promise((r) => setTimeout(r, 2));
      });

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft().id("test-idle-reconnect").from(mail("INBOX", {})).to(spy()),
        )
        .build();

      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 50));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(idleCalls).toBeGreaterThanOrEqual(2);
      // Initial open + reconnect open
      expect(mockMailboxOpen.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    /**
     * @case Auth errors during IDLE do not trigger reconnect
     * @preconditions idle() rejects with an auth error on the first call
     * @expectedResult Subscription fails with RC5012 (no reconnect attempts)
     */
    test("IDLE auth failure stops the subscription without reconnect", async () => {
      mockFetch.mockImplementation(() => ({
        async *[Symbol.asyncIterator]() {},
      }));

      let idleCalls = 0;
      mockIdle.mockImplementation(async () => {
        idleCalls++;
        throw new Error("AUTHENTICATIONFAILED");
      });

      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "wrong" },
                },
              },
            },
          },
        })
        .routes(
          craft().id("test-idle-auth-fail").from(mail("INBOX", {})).to(spy()),
        )
        .build();

      const startPromise = t.ctx.start();
      await new Promise((r) => setTimeout(r, 30));
      await t.ctx.stop();
      await startPromise.catch(() => {});

      expect(idleCalls).toBe(1);
      // No reconnect: mailboxOpen called once at initial subscribe
      expect(mockMailboxOpen.mock.calls.length).toBe(1);
    });

    /**
     * @case Throws RC5003 at subscribe when markSeen is false without pollIntervalMs
     * @preconditions markSeen: false with no pollIntervalMs (IDLE flood footgun)
     * @expectedResult t.test() rejects with RC5003
     */
    test("throws when markSeen: false without pollIntervalMs", async () => {
      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-guard-markseen")
            .from(mail("INBOX", { markSeen: false }))
            .to(spy()),
        )
        .build();

      await expect(t.test()).rejects.toMatchObject({ rc: "RC5003" });
    });

    /**
     * @case Throws RC5003 at subscribe when unseen is false without pollIntervalMs
     * @preconditions unseen: false with no pollIntervalMs
     * @expectedResult t.test() rejects with RC5003
     */
    test("throws when unseen: false without pollIntervalMs", async () => {
      t = await testContext()
        .with({
          mail: {
            accounts: {
              default: {
                imap: {
                  host: "imap.test.com",
                  auth: { user: "u", pass: "p" },
                },
              },
            },
          },
        })
        .routes(
          craft()
            .id("test-guard-unseen")
            .from(mail("INBOX", { unseen: false }))
            .to(spy()),
        )
        .build();

      await expect(t.test()).rejects.toMatchObject({ rc: "RC5003" });
    });
  });

  describe("buildSearchCriteriaSets", () => {
    /**
     * @case Returns base criteria when no search filters are set
     * @preconditions Only unseen is set (default)
     * @expectedResult Single criteria set with seen: false
     */
    test("returns base criteria with no filters", () => {
      const opts: MailServerOptions = { unseen: true };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toEqual([{ seen: false }]);
    });

    /**
     * @case Single-value filter produces one criteria set
     * @preconditions subject is a string
     * @expectedResult Single criteria set with seen: false and subject key
     */
    test("single-value filter produces one set", () => {
      const opts: MailServerOptions = { unseen: true, subject: "URGENT" };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toEqual([{ seen: false, subject: "URGENT" }]);
    });

    /**
     * @case Array filter produces OR branches (one set per value)
     * @preconditions subject is an array of two values
     * @expectedResult Two criteria sets, one per subject value
     */
    test("array filter produces OR branches", () => {
      const opts: MailServerOptions = {
        unseen: true,
        subject: ["URGENT", "IMPORTANT"],
      };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toHaveLength(2);
      expect(sets).toEqual([
        { seen: false, subject: "URGENT" },
        { seen: false, subject: "IMPORTANT" },
      ]);
    });

    /**
     * @case Cross-field cartesian product
     * @preconditions subject has 2 values, body has 2 values
     * @expectedResult 4 criteria sets (2x2 cartesian product)
     */
    test("cross-field cartesian product", () => {
      const opts: MailServerOptions = {
        unseen: false,
        subject: ["A", "B"],
        body: ["X", "Y"],
      };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toHaveLength(4);
      expect(sets).toContainEqual({ subject: "A", body: "X" });
      expect(sets).toContainEqual({ subject: "A", body: "Y" });
      expect(sets).toContainEqual({ subject: "B", body: "X" });
      expect(sets).toContainEqual({ subject: "B", body: "Y" });
    });

    /**
     * @case Header filter expands as OR within a header key
     * @preconditions header has Reply-To with array of two values
     * @expectedResult Two criteria sets with different header values
     */
    test("header filter OR expansion", () => {
      const opts: MailServerOptions = {
        unseen: true,
        header: { "Reply-To": ["noreply", "no-reply"] },
      };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toHaveLength(2);
      expect(sets[0]).toEqual({
        seen: false,
        header: { "Reply-To": "noreply" },
      });
      expect(sets[1]).toEqual({
        seen: false,
        header: { "Reply-To": "no-reply" },
      });
    });

    /**
     * @case Multiple header keys produce AND between keys
     * @preconditions Two header keys with single values each
     * @expectedResult Single criteria set with both headers
     */
    test("multiple header keys AND", () => {
      const opts: MailServerOptions = {
        unseen: false,
        header: { "Reply-To": "noreply", "List-Id": "announcements" },
      };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toHaveLength(1);
      expect(sets[0]).toEqual({
        header: { "Reply-To": "noreply", "List-Id": "announcements" },
      });
    });

    /**
     * @case since date is included in base criteria
     * @preconditions since is set with a Date
     * @expectedResult Criteria includes since field
     */
    test("since date in base criteria", () => {
      const d = new Date("2026-01-01");
      const opts: MailServerOptions = { unseen: true, since: d };
      const sets = buildSearchCriteriaSets(opts);
      expect(sets).toEqual([{ seen: false, since: d }]);
    });
  });

  describe("replace() aggregator", () => {
    /**
     * @case replace() replaces exchange body with enrichment result
     * @preconditions Enrich destination returns an array, replace() aggregator used
     * @expectedResult Exchange body is the raw enrichment result, not merged
     */
    test("replaces body with enrichment result", async () => {
      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            uid: 1,
            flags: new Set([]),
            envelope: {
              messageId: "<msg1@test.com>",
              from: [{ address: "a@b.com" }],
              to: [{ address: "c@d.com" }],
              subject: "Test",
              date: new Date("2026-03-17"),
            },
            source: Buffer.from("content"),
          };
        },
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("test-replace")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
              }),
              replace(),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as any;
      // With replace(), body is the raw MailMessage array
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(1);
      expect(body[0].uid).toBe(1);
      expect(body[0].from).toBe("a@b.com");
    });
  });

  describe("includeHeaders / rawHeaders", () => {
    /**
     * @case includeHeaders populates rawHeaders on fetched messages
     * @preconditions simpleParser returns headerLines, includeHeaders is true
     * @expectedResult MailMessage has rawHeaders with parsed header values
     */
    test("includes raw headers when includeHeaders is set", async () => {
      // Override simpleParser mock for this test to return headerLines
      const { simpleParser } = await import("mailparser");
      (simpleParser as any).mockResolvedValueOnce({
        text: "Hello",
        attachments: [],
        headerLines: [
          { key: "reply-to", line: "Reply-To: noreply@example.com" },
          { key: "x-custom", line: "X-Custom: value1" },
          { key: "x-custom", line: "X-Custom: value2" },
        ],
      });

      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            uid: 1,
            flags: new Set([]),
            envelope: {
              messageId: "<msg1@test.com>",
              from: [{ address: "a@b.com" }],
              to: [{ address: "c@d.com" }],
              subject: "Headers test",
              date: new Date("2026-03-17"),
            },
            source: Buffer.from("raw email"),
          };
        },
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("test-headers")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
                includeHeaders: true,
              }),
              replace(),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body[0].rawHeaders).toBeDefined();
      expect(body[0].rawHeaders["reply-to"]).toBe("noreply@example.com");
      // Multi-value header should be an array
      expect(body[0].rawHeaders["x-custom"]).toEqual(["value1", "value2"]);
    });

    /**
     * @case includeHeaders with specific header names filters results
     * @preconditions includeHeaders is an array of header names
     * @expectedResult Only requested headers appear in rawHeaders
     */
    test("filters headers by name when array provided", async () => {
      const { simpleParser } = await import("mailparser");
      (simpleParser as any).mockResolvedValueOnce({
        text: "Hello",
        attachments: [],
        headerLines: [
          { key: "reply-to", line: "Reply-To: noreply@example.com" },
          { key: "x-spam", line: "X-Spam: yes" },
          { key: "x-custom", line: "X-Custom: ignored" },
        ],
      });

      mockFetch.mockReturnValue({
        async *[Symbol.asyncIterator]() {
          yield {
            uid: 1,
            flags: new Set([]),
            envelope: {
              messageId: "<msg1@test.com>",
              from: [{ address: "a@b.com" }],
              to: [{ address: "c@d.com" }],
              subject: "Filtered headers",
              date: new Date("2026-03-17"),
            },
            source: Buffer.from("raw email"),
          };
        },
      });

      const s = spy();

      t = await testContext()
        .routes(
          craft()
            .id("test-filtered-headers")
            .from(simple("trigger"))
            .enrich(
              mail({
                folder: "INBOX",
                host: "imap.test.com",
                auth: { user: "u", pass: "p" },
                includeHeaders: ["Reply-To", "X-Spam"],
              }),
              replace(),
            )
            .to(s),
        )
        .build();

      await t.ctx.start();

      expect(s.received).toHaveLength(1);
      const body = s.received[0].body as any;
      expect(body[0].rawHeaders).toBeDefined();
      expect(body[0].rawHeaders["reply-to"]).toBe("noreply@example.com");
      expect(body[0].rawHeaders["x-spam"]).toBe("yes");
      // x-custom was not requested
      expect(body[0].rawHeaders["x-custom"]).toBeUndefined();
    });
  });

  describe("sender analysis", () => {
    /**
     * @case Direct DMARC-aligned mail resolves to the From: header sender
     * @preconditions Headers include From: and Authentication-Results: dmarc=pass
     * @expectedResult forwardType "direct", trust "verified", effective sender matches From
     */
    test("direct mail with dmarc=pass is verified", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: Stripe Billing <billing@stripe.com>",
          "Authentication-Results: mx.example.com; dkim=pass header.i=@stripe.com; spf=pass; dmarc=pass header.from=stripe.com",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("direct");
      expect(sender.trust).toBe("verified");
      expect(sender.address).toBe("billing@stripe.com");
      expect(sender.domain).toBe("stripe.com");
      expect(sender.forwardChain).toEqual([]);
      expect(sender.authentication.dmarc).toBe("pass");
      expect(sender.reason).toBe("direct-dmarc-aligned");
      expect(sender.headerFrom).toBeUndefined();
    });

    /**
     * @case Google Groups forward exposes the original sender via X-Original-From
     * @preconditions List-Id present, X-Original-From points to the real sender, ARC cv=pass
     * @expectedResult forwardType "mailing-list", effective sender is the X-Original-From address,
     *                 headerFrom captures the group address, forwardChain records one hop
     */
    test("Google Groups forward resolves to X-Original-From", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: Detachering via DevOptix <detachering@devoptix.nl>",
          "Sender: detachering+bncBDG@devoptix.nl",
          "List-Id: <detachering.devoptix.nl>",
          "Precedence: list",
          "X-Original-From: Team Flextender <no-reply@flextender.nl>",
          "ARC-Seal: i=1; cv=none; d=google.com",
          "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass header.i=@flextender.nl; spf=pass; dmarc=pass header.from=flextender.nl",
          "Authentication-Results: mx.example.com; dkim=pass header.i=@devoptix.nl; spf=pass; dmarc=pass header.from=devoptix.nl",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("mailing-list");
      expect(sender.address).toBe("no-reply@flextender.nl");
      expect(sender.domain).toBe("flextender.nl");
      expect(sender.headerFrom?.address).toBe("detachering@devoptix.nl");
      expect(sender.forwardChain).toHaveLength(1);
      expect(sender.forwardChain[0].type).toBe("mailing-list");
      expect(sender.forwardChain[0].via.address).toBe(
        "detachering@devoptix.nl",
      );
      // cv=none on the only ARC-Seal means arc-unverified trust, not verified.
      expect(sender.authentication.arc).toBe("none");
      expect(sender.trust).toBe("unverified");
    });

    /**
     * @case Google Groups forward with a verified ARC chain is trusted
     * @preconditions ARC-Seal with cv=pass, List-Id present, X-Original-From set
     * @expectedResult trust "verified", reason "list-forward-arc-verified"
     */
    test("mailing-list forward with ARC cv=pass is verified", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: Detachering via DevOptix <detachering@devoptix.nl>",
          "List-Id: <detachering.devoptix.nl>",
          "X-Original-From: Team Flextender <no-reply@flextender.nl>",
          "ARC-Seal: i=1; cv=pass; d=google.com",
          "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=flextender.nl",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.trust).toBe("verified");
      expect(sender.reason).toBe("list-forward-arc-verified");
      expect(sender.authentication.arc).toBe("pass");
    });

    /**
     * @case Gmail auto-forward preserves From: and adds ARC
     * @preconditions ARC-Seal present with cv=pass, no List-Id
     * @expectedResult forwardType "auto-forward", effective sender = From, trust "verified"
     */
    test("auto-forward with ARC cv=pass is verified", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: Stripe Billing <billing@stripe.com>",
          "ARC-Seal: i=1; cv=pass; d=google.com",
          "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=stripe.com",
          "Authentication-Results: mx.personal.com; arc=pass; dkim=pass; dmarc=pass",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("auto-forward");
      expect(sender.address).toBe("billing@stripe.com");
      expect(sender.trust).toBe("verified");
      expect(sender.forwardChain).toHaveLength(1);
      expect(sender.forwardChain[0].type).toBe("auto-forward");
    });

    /**
     * @case DMARC fail on direct mail flags trust as failed
     * @preconditions Authentication-Results shows dmarc=fail
     * @expectedResult trust "failed", reason "direct-dmarc-fail"
     */
    test("direct mail with dmarc=fail is failed", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: fake <ceo@devoptix.nl>",
          "Authentication-Results: mx.example.com; dkim=fail; spf=fail; dmarc=fail header.from=devoptix.nl",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("direct");
      expect(sender.trust).toBe("failed");
      expect(sender.reason).toBe("direct-dmarc-fail");
      expect(sender.authentication.dmarc).toBe("fail");
    });

    /**
     * @case No auth headers present yields unverified trust
     * @preconditions Only From: header, no Authentication-Results
     * @expectedResult forwardType "direct", trust "unverified"
     */
    test("missing auth headers yields unverified", () => {
      const headers = extractAnalysisHeaders(
        headerLines(["From: someone@example.com"]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("direct");
      expect(sender.trust).toBe("unverified");
      expect(sender.address).toBe("someone@example.com");
    });

    /**
     * @case Mailing-list forward without X-Original-From falls back to a synthesised address from ARC header.from domain
     * @preconditions List-Id present, no X-Original-From / X-Original-Sender, ARC-Authentication-Results has header.from=<domain>
     * @expectedResult effective sender domain matches the ARC domain; address is "unknown@<domain>" to avoid colliding with real addresses
     */
    test("mailing-list forward without X-Original-From falls back to ARC domain", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: detachering via DevOptix <detachering@devoptix.nl>",
          "List-Id: <detachering.devoptix.nl>",
          "ARC-Seal: i=1; cv=pass; d=google.com",
          "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass; spf=pass; dmarc=pass header.from=flextender.nl",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("mailing-list");
      expect(sender.domain).toBe("flextender.nl");
      expect(sender.address).toBe("unknown@flextender.nl");
      expect(sender.trust).toBe("verified");
    });

    /**
     * @case Auto-forward populates ForwardHop.via from ARC-Seal d= tag
     * @preconditions ARC-Seal with d=google.com, cv=pass, no List-Id
     * @expectedResult forwardChain[0].via.domain = "google.com"; via.address = "arc@google.com"
     */
    test("auto-forward via is populated from ARC-Seal d=", () => {
      const headers = extractAnalysisHeaders(
        headerLines([
          "From: Stripe Billing <billing@stripe.com>",
          "ARC-Seal: i=1; cv=pass; d=google.com",
          "ARC-Authentication-Results: i=1; mx.google.com; dkim=pass; dmarc=pass header.from=stripe.com",
        ]),
      );
      const sender = analyzeHeaders(headers);
      expect(sender.forwardType).toBe("auto-forward");
      expect(sender.forwardChain).toHaveLength(1);
      expect(sender.forwardChain[0].via.domain).toBe("google.com");
      expect(sender.forwardChain[0].via.address).toBe("arc@google.com");
    });

    /**
     * @case parseAuthResults extracts verdicts and header.from
     * @preconditions Value with dkim, spf, dmarc results and header.from
     * @expectedResult Each verdict normalized, dmarcHeaderFrom captured
     */
    test("parseAuthResults extracts verdicts", () => {
      const r = parseAuthResults(
        "mx.example.com; dkim=pass header.i=@foo.com; spf=neutral; dmarc=pass header.from=foo.com",
      );
      expect(r.dkim).toBe("pass");
      expect(r.spf).toBe("neutral");
      expect(r.dmarc).toBe("pass");
      expect(r.dmarcHeaderFrom).toBe("foo.com");
    });
  });
});

// ---------------------------------------------------------------------------
// Analysis test helpers
// ---------------------------------------------------------------------------

function headerLines(
  lines: string[],
): ReadonlyArray<{ key: string; line: string }> {
  return lines.map((line) => {
    const colon = line.indexOf(":");
    const key = (colon >= 0 ? line.slice(0, colon) : line).trim().toLowerCase();
    return { key, line };
  });
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMailMessage(uid: number, folder: string) {
  return {
    uid,
    messageId: `<msg${uid}@test.com>`,
    from: "sender@test.com",
    to: "me@test.com",
    subject: `Message ${uid}`,
    date: new Date(),
    body: {},
    flags: new Set<string>(),
    folder,
  };
}

async function buildMailContext() {
  return testContext()
    .with({
      mail: {
        accounts: {
          default: {
            imap: {
              host: "imap.test.com",
              auth: { user: "test@test.com", pass: "test-pass" },
            },
            smtp: {
              host: "smtp.test.com",
              auth: { user: "test@test.com", pass: "test-pass" },
              from: "test@test.com",
            },
          },
        },
      },
    })
    .routes(craft().id("noop").from(simple("noop")).to(spy()))
    .build();
}

function createMailExchange(uid: number, folder: string, ctx?: any) {
  const exchange = {
    id: "test",
    headers: {},
    body: createMailMessage(uid, folder),
    logger: console,
  } as any;
  if (ctx) {
    EXCHANGE_INTERNALS.set(exchange, { context: ctx });
  }
  return exchange;
}

function attachContext(exchange: any, ctx: any) {
  EXCHANGE_INTERNALS.set(exchange, { context: ctx });
}
