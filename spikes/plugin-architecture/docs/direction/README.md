# The plugin architecture, end to end

This folder is the user-facing account of where Routecraft is going: one
kernel, and every feature a plugin that reaches it through the same sockets,
ours and yours alike. It is written for someone who builds capabilities today
and wants to know what changes, what stays, and what they will be able to do
that they cannot do now.

It is a draft of the pages we would publish with the release that ships this
architecture. Nothing here is generated from code. Where a page describes
behaviour, it says which of three things it is describing:

| Label | Meaning |
|---|---|
| **Demonstrated** | Exercised by the proof of concept under `src/v2/`, with a test and a mutation behind it |
| **Intended** | A design decision the proof of concept does not yet demonstrate, with the known gap named |
| **Migration decision** | Open, and settled by the feature-fit ledger when the shipped framework is moved onto these contracts |

Unlabelled prose describes the design. The proof of concept is a reference for
the contracts, not the code that ships: the shipped execution machinery stays,
and the contracts are extracted around it.

## Reading order

| Page | What it answers |
|---|---|
| [What changes](01-what-changes.md) | The one move, in two pictures, and what it buys |
| [Anatomy](02-anatomy.md) | Kernel, plugins, ports, points, contributions, steps, facets, execution, namespaces, installation, and the inside at runtime |
| [One exchange through a route](03-exchange-through-a-route.md) | Rings, wrappers, the step loop and its six outcomes, refusals and failures, run kinds |
| [Waiting and resuming](04-waiting-and-resuming.md) | Parking, the record, the store, the door, the resume protocol, expiry, the sweep, what is not promised |
| [Identity](05-identity.md) | Principals, the gate, grants, what a continuation runs as, lending at the door |
| [Writing a plugin](06-writing-a-plugin.md) | The descriptor, bind, start and stop, replacing a provider, packaging |
| [Differences from today](07-differences-from-today.md) | Capability by capability: what changes functionally, what stays, what is still open |

## The figures

The figures under `figures/` are drawn in the docs site's own figure system
(`apps/routecraft.dev/app/components/figures/`): the same primitives, palette
and fonts, exported light and dark at 2x. All nine share one visual identity,
taken from the "every way in" figure that opens page 01 and kept in
`figures/harness.tsx`: bands with a serif title, a mono label on the left of
each row, chips joined by arrows where order matters, and one inverted panel
for the thing that matters. The first figure is the harness as a consumer
meets it; the second, `inside-the-harness`, opens its middle band. `bun docs/direction/figures/render.tsx`
re-renders them. They are drawn by hand from the code and checked by eye; the
only mechanically checked diagram in this spike is the module graph in
`../../DIAGRAMS-MECHANISM.md`, which `bun run verify:diagram` derives from the
source.

## What this folder is not

It is not the design record. `../../ARCHITECTURE.md` holds the decisions, the
rulings, every review and what each one changed. It is not reference
documentation either: option by option belongs to the reference pages that
will be generated from the code once the contracts are settled.
