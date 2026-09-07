---
"@routecraft/routecraft": patch
"@routecraft/ai": patch
---

A SQLite store now knows its own file, and two stores pointed at one path are refused where a person can act on it.

Every store in `.routecraft/` versions its schema through `PRAGMA user_version`, which is one integer per database. Two stores sharing a path therefore cannot both be satisfied: whichever opens first stamps its own version and the other refuses. Until now the loser only knew that the number it found was not its own, so a suspension database given the session store's path was reported as an agent session store "on schema version 4, newer than this build understands (2)", advising the reader to run a newer Routecraft build. No build will ever understand that file, because the file belongs to another store. Reported from JetBrains against a project that had configured `suspension: { store }` and `sessions: { store }` onto one path, where the failure surfaced inside the ACP authentication loop rather than at boot, because the session store opens lazily on the first conversation.

Two changes, at the two moments the mistake is visible.

**Configuration refuses the collision at boot.** `sessions: { store }` and `suspension: { store }` resolving to the same file now fails while a person is still reading startup output, naming both settings and the shared path. Claims are held per context, and `":memory:"` is exempt because each in-memory database is private to the connection that opened it. A setting holds one path: claiming a second releases the first, so the path an unconfigured default gives up when a `sessions` block replaces it does not go on blocking a store that legitimately wants it. A store that degrades to memory because no sqlite driver is available releases its path too, since it never opened the file and a claim left behind would turn that deliberate degradation into a boot error.

**A file carries the identity of the store that owns it.** Each store stamps `PRAGMA application_id` and refuses a file stamped by another, saying which store it belongs to rather than reporting a version. Files written before stamping existed are adopted rather than stranded: a file with no schema at all, or one already carrying the store's own table, is claimed and stamped on open, so every database the published canary wrote still migrates. Anything else is refused, and the message lists the tables it actually holds, which is what an operator sees running `sqlite3` against it. Emptiness is decided over every schema object rather than over tables alone, so a file holding only a view, an index or a trigger is not mistaken for an unused one.

The version message now only appears when it is true, which is a file written by a genuinely newer build of the same store.

No migration is required and no data is touched. `migrateSqlite` takes `applicationId` and `identityTable`, and `SqliteMigrationFailure` gained a `foreign` kind alongside `tables` and `applicationId`, which matters only to code calling the shared runner directly.
