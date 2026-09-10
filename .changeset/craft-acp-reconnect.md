---
"@routecraft/cli": patch
---

`craft acp` reconnects when the instance behind it restarts (#754).

The bridge used to exit the moment the instance went away, and an editor that keeps the process for the life of its window (JetBrains among them) does not start another, so a restarted instance meant a dead window until the editor itself was restarted. The bridge now stays up through the outage and reconnects on its own: it waits for the address to answer again, a quarter of a second at first and then doubling to every five seconds for as long as the editor is open, initializes the new instance with what the editor said the first time, and resumes every conversation the editor had open by its id, so the editor's next message is answered as if nothing happened. Resumed rather than loaded: nothing is replayed onto a screen that already shows it.

What was in flight when the instance went away cannot be recovered, because the protocol does not replay it: a prompt that was waiting is answered `cancelled`, any other request gets an error naming the outage, and a late answer from the editor to a request the dead connection made is dropped rather than posted to a connection that never asked. A conversation the instance came back without (a memory session store) is named on standard error with the advice to start a new one. Each loss and each reconnection is one line on standard error.

The bridge drops a conversation only when the instance answers its resume with the protocol's not-found code (#756). A resume refused for any other reason, an instance whose store is busy among them, keeps the conversation and says so on standard error, and the next reconnection tries it again: the conversation may well still exist, and dropping it would lose the person's work on a false premise.

The first connection is unchanged: an address nothing has ever answered on still exits `3` naming it, because that is configuration to check rather than an outage to wait out. The editor's own side of the pipe breaking, rather than closing normally, is now its own exit code, `1`, rather than being reported as a clean exit.
