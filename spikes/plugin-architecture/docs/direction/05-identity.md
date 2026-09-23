# Identity

The kernel carries no identity. Who the work is for is a header, and what
that header means is the business of two plugins.

## Two plugins

**`principals`** owns the header and the brand. It mints a principal
(`subject`, permanent `grants`, `lent` grants for this run only), freezes it,
and remembers it in a private set that is the only proof of authenticity. A
principal that came back from a store is readable but never in that set: it
is **restored**, not **authentic**. `principals` provides the **authority**
port, and a vendor can replace it under its own brand, so a JWT verifier is a
provider, not a fork.

**`auth`** owns the gate. It requires the authority port, provides the
**enforcement** port, contributes the admission handler that enforces a
route's grants, contributes the facet `ex.auth`, and contributes two route
methods: `.authorize(...grants)` and `.resumable({ authorize, elevate })`.

The split is what makes replacement honest. A provider of authority with no
gate would let a protected route run unprotected, so the route's ask names the
gate's own port as what it requires, and refuses to compile without it.
`.authorize()` with no grants still demands an authentic principal. The ask
cannot fail open by absence. **Demonstrated.**

## What travels, and what is derived

The principal travels as one header. Everything else is derived from it each
time it is read: `ex.auth.principal` is the header decoded, `ex.auth.resumedBy`
is read from the header the resume wrote. Nothing about identity is stored on
its own, so nothing about it can disagree with the headers after a park.

## What a continuation runs as

A continuation runs as whoever parked it, restored. Restored is readable and
is not a credential: the gate refuses it, so a resumed exchange cannot pass a
gate on the strength of an identity that was authentic three days ago.

A park raised at the gate (the requester lacked a grant, and an error handler
parked the refusal for a human) is re-admitted when it resumes, so the gate
is asked again of what the continuation carries. Without a lend, the restored
requester is refused again, the failure reaches the error ring, the record
ends failed. With a lend, the door has re-minted the requester with exactly
the grants the gate recorded as refused, live, for this resume alone, and the
run passes the gate that refused it. The record says who lent.
**Demonstrated.**

Neither the approver's authority nor the requester's lack of it is hidden:
the approver is in the record as who resumed, the requester is the exchange's
own principal, and the lend is visible on it as `lent`.

## What the gate does not do

It does not verify tokens, bind a credential to a call, validate a payload
against a schema, or count grants per delegation ring. The shipped framework
does all four, and they are **migration decisions**: the contracts here have
to carry them before the door is published as the consumer model.
