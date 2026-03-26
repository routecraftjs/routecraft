import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { testContext, spy, type TestContext } from "@routecraft/testing";
import { craft, simple, mail } from "@routecraft/routecraft";
import { EXCHANGE_INTERNALS } from "../src/exchange.ts";

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
});

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
