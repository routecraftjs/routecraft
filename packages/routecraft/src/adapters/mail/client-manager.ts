/**
 * Mail client manager with per-account IMAP connection pools and SMTP transporter reuse.
 *
 * Created by the ContextBuilder when `mail` config is present.
 * Adapters access it via the context store to acquire/release connections.
 *
 * @experimental
 */

import { rcError } from "../../error.ts";
import type {
  MailContextConfig,
  MailServerOptions,
  MailClientOptions,
  MailAuth,
} from "./types.ts";

// ---------------------------------------------------------------------------
// ImapPool: fixed-size, mailbox-aware IMAP connection pool for one account
// ---------------------------------------------------------------------------

/**
 * Fixed-size IMAP connection pool for a single account.
 * Tracks which mailbox each connection has open to avoid unnecessary switches.
 * @internal
 */
export class ImapPool {
  private readonly entries: Array<{
    client: InstanceType<typeof import("imapflow").ImapFlow>;
    inUse: boolean;
    currentMailbox: string | null;
  }> = [];
  private readonly waitQueue: Array<
    (client: InstanceType<typeof import("imapflow").ImapFlow>) => void
  > = [];
  private readonly poolSize: number;
  private readonly imapConfig: {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: MailAuth;
  };

  constructor(imapConfig: {
    host?: string;
    port?: number;
    secure?: boolean;
    auth?: MailAuth;
    poolSize?: number;
  }) {
    this.imapConfig = imapConfig;
    this.poolSize = imapConfig.poolSize ?? 3;
  }

  /**
   * Acquire an IMAP client from the pool.
   * Prefers connections that already have the target mailbox open.
   */
  async acquire(
    mailbox?: string,
  ): Promise<InstanceType<typeof import("imapflow").ImapFlow>> {
    // 1. Prefer idle connection with same mailbox already open
    if (mailbox) {
      const sameMailbox = this.entries.find(
        (c) => !c.inUse && c.currentMailbox === mailbox,
      );
      if (sameMailbox) {
        sameMailbox.inUse = true;
        if (sameMailbox.client.usable) return sameMailbox.client;
        // Dead connection, remove and fall through
        this.entries.splice(this.entries.indexOf(sameMailbox), 1);
      }
    }

    // 2. Any idle connection
    const idle = this.entries.find((c) => !c.inUse);
    if (idle) {
      idle.inUse = true;
      if (idle.client.usable) return idle.client;
      // Dead connection, remove and fall through
      this.entries.splice(this.entries.indexOf(idle), 1);
    }

    // 3. Create new if under limit
    if (this.entries.length < this.poolSize) {
      const client = await this.createClient();
      this.entries.push({ client, inUse: true, currentMailbox: null });
      return client;
    }

    // 4. Queue and wait for release
    return new Promise((resolve) => this.waitQueue.push(resolve));
  }

  /**
   * Release an IMAP client back to the pool.
   */
  release(client: InstanceType<typeof import("imapflow").ImapFlow>): void {
    const entry = this.entries.find((c) => c.client === client);
    if (!entry) return;

    // If someone is waiting, hand directly
    const waiter = this.waitQueue.shift();
    if (waiter) {
      waiter(client);
      return;
    }

    entry.inUse = false;
  }

  /**
   * Update the tracked mailbox for a client after mailboxOpen().
   */
  trackMailbox(
    client: InstanceType<typeof import("imapflow").ImapFlow>,
    mailbox: string,
  ): void {
    const entry = this.entries.find((c) => c.client === client);
    if (entry) entry.currentMailbox = mailbox;
  }

  /**
   * Drain all connections. Called during context teardown.
   */
  async drain(): Promise<void> {
    this.waitQueue.length = 0;
    for (const entry of this.entries) {
      await entry.client.logout().catch(() => {});
    }
    this.entries.length = 0;
  }

  private async createClient(): Promise<
    InstanceType<typeof import("imapflow").ImapFlow>
  > {
    if (!this.imapConfig.host) {
      throw rcError("RC5003", undefined, {
        message:
          "Mail adapter IMAP host is required. Set host in account config or adapter options.",
      });
    }
    if (!this.imapConfig.auth) {
      throw rcError("RC5003", undefined, {
        message:
          "Mail adapter IMAP auth is required. Set auth in account config or adapter options.",
      });
    }

    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: this.imapConfig.host,
      port: this.imapConfig.port ?? 993,
      secure: this.imapConfig.secure ?? true,
      auth: this.imapConfig.auth,
      logger: false,
    });
    await client.connect();
    return client;
  }
}

// ---------------------------------------------------------------------------
// MailClientManager: per-account pools + SMTP transporters
// ---------------------------------------------------------------------------

/**
 * Manages per-account IMAP connection pools and SMTP transporters.
 * Created by the ContextBuilder when `mail` config is present.
 *
 * @experimental
 */
export class MailClientManager {
  private readonly pools = new Map<string, ImapPool>();
  private readonly transports = new Map<
    string,
    ReturnType<typeof import("nodemailer").createTransport>
  >();
  readonly config: MailContextConfig;
  readonly defaultAccount: string;

  constructor(config: MailContextConfig) {
    this.config = config;

    // Determine default account: key named "default", or first defined
    const accounts = config.accounts ?? {};
    this.defaultAccount =
      "default" in accounts ? "default" : (Object.keys(accounts)[0] ?? "");
  }

  /**
   * Acquire an IMAP client for the given account.
   * Creates the account pool lazily on first access.
   */
  async acquireImap(
    account?: string,
    mailbox?: string,
  ): Promise<InstanceType<typeof import("imapflow").ImapFlow>> {
    const name = account ?? this.defaultAccount;
    let pool = this.pools.get(name);
    if (!pool) {
      const accountConfig = this.config.accounts?.[name];
      if (!accountConfig?.imap) {
        throw rcError("RC5003", undefined, {
          message: `Mail account '${name}' has no IMAP configuration.`,
        });
      }
      pool = new ImapPool(accountConfig.imap);
      this.pools.set(name, pool);
    }
    return pool.acquire(mailbox);
  }

  /**
   * Release an IMAP client back to its account pool.
   */
  releaseImap(
    account: string | undefined,
    client: InstanceType<typeof import("imapflow").ImapFlow>,
  ): void {
    const name = account ?? this.defaultAccount;
    this.pools.get(name)?.release(client);
  }

  /**
   * Update the tracked mailbox for a pooled client.
   */
  trackMailbox(
    account: string | undefined,
    client: InstanceType<typeof import("imapflow").ImapFlow>,
    mailbox: string,
  ): void {
    const name = account ?? this.defaultAccount;
    this.pools.get(name)?.trackMailbox(client, mailbox);
  }

  /**
   * Get the SMTP transporter for the given account (lazy init).
   */
  async getSmtp(
    account?: string,
  ): Promise<ReturnType<typeof import("nodemailer").createTransport>> {
    const name = account ?? this.defaultAccount;
    const existing = this.transports.get(name);
    if (existing) return existing;

    const accountConfig = this.config.accounts?.[name];
    if (!accountConfig?.smtp) {
      throw rcError("RC5003", undefined, {
        message: `Mail account '${name}' has no SMTP configuration.`,
      });
    }

    const smtp = accountConfig.smtp;
    if (!smtp.host) {
      throw rcError("RC5003", undefined, {
        message: `Mail account '${name}' SMTP host is required.`,
      });
    }
    if (!smtp.auth) {
      throw rcError("RC5003", undefined, {
        message: `Mail account '${name}' SMTP auth is required.`,
      });
    }

    const nodemailer = await import("nodemailer");
    const transport = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port ?? 465,
      secure: smtp.secure ?? true,
      auth: smtp.auth,
    });
    this.transports.set(name, transport);
    return transport;
  }

  /**
   * Resolve IMAP options: adapter overrides > account config > shared defaults > built-in defaults.
   */
  resolveImapOptions(
    account?: string,
    overrides: Partial<MailServerOptions> = {},
  ): MailServerOptions {
    const acct = this.config.accounts?.[account ?? this.defaultAccount];
    const result: MailServerOptions = {
      port: overrides.port ?? acct?.imap?.port ?? 993,
      secure: overrides.secure ?? acct?.imap?.secure ?? true,
      folder: overrides.folder ?? this.config.folder ?? "INBOX",
      markSeen: overrides.markSeen ?? this.config.markSeen ?? true,
      unseen: overrides.unseen ?? true,
    };

    const host = overrides.host ?? acct?.imap?.host;
    if (host !== undefined) result.host = host;

    const auth = overrides.auth ?? acct?.imap?.auth;
    if (auth !== undefined) result.auth = auth;

    if (overrides.since !== undefined) result.since = overrides.since;
    if (overrides.limit !== undefined) result.limit = overrides.limit;
    if (overrides.pollIntervalMs !== undefined)
      result.pollIntervalMs = overrides.pollIntervalMs;
    if (overrides.includeHeaders !== undefined)
      result.includeHeaders = overrides.includeHeaders;

    // Pass through search filters
    if (overrides.from !== undefined) result.from = overrides.from;
    if (overrides.to !== undefined) result.to = overrides.to;
    if (overrides.subject !== undefined) result.subject = overrides.subject;
    if (overrides.body !== undefined) result.body = overrides.body;
    if (overrides.header !== undefined) result.header = overrides.header;

    return result;
  }

  /**
   * Resolve SMTP options: adapter overrides > account config > shared defaults.
   */
  resolveSmtpOptions(
    account?: string,
    overrides: Partial<MailClientOptions> = {},
  ): MailClientOptions {
    const acct = this.config.accounts?.[account ?? this.defaultAccount];
    const result: MailClientOptions = {
      port: overrides.port ?? acct?.smtp?.port ?? 465,
      secure: overrides.secure ?? acct?.smtp?.secure ?? true,
    };

    const host = overrides.host ?? acct?.smtp?.host;
    if (host !== undefined) result.host = host;

    const auth = overrides.auth ?? acct?.smtp?.auth;
    if (auth !== undefined) result.auth = auth;

    const from = overrides.from ?? acct?.smtp?.from;
    if (from !== undefined) result.from = from;

    const replyTo = overrides.replyTo ?? acct?.smtp?.replyTo;
    if (replyTo !== undefined) result.replyTo = replyTo;

    const cc = overrides.cc ?? acct?.smtp?.cc;
    if (cc !== undefined) result.cc = cc;

    const bcc = overrides.bcc ?? acct?.smtp?.bcc;
    if (bcc !== undefined) result.bcc = bcc;

    return result;
  }

  /**
   * Drain all pools and transports. Called during context teardown.
   */
  async drain(): Promise<void> {
    for (const pool of this.pools.values()) {
      await pool.drain();
    }
    this.pools.clear();
    for (const transport of this.transports.values()) {
      transport.close();
    }
    this.transports.clear();
  }
}
