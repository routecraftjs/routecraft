# Anatomy

Routecraft is a kernel and a set of plugins. This page names every part, says
which side of the line it sits on, and shows how a set of plugin descriptors
becomes a running application. The figure is the whole of it: every plugin,
ours and yours in the same rows; the six sockets they reach the kernel
through; the kernel, with what it does for one run, a park, a resume and a
sweep; and the ports it calls out through.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/inside-the-harness-dark.png">
  <img alt="The inside of every harness. Top: every plugin, ours (operations, resilience, deferral, sqlite, principals, auth) and yours (a store, a wrapper, an adapter, a moment) in the same rows, each declaring id, requires, provides, replaces, points, facets, steps and hooks. Below: six sockets, port, contribution, step, facet, point and execution. Then the kernel, an inverted panel: its lifecycle, one run through a fixed chain of positions and slots (error, beforeAuth, authorize, retry, your wrapper, timeout), the step loop and exit with the six outcomes, the run kinds, and the park, resume and sweep sequences. Bottom: the ports it calls out through, each provided by a plugin." src="figures/inside-the-harness.png">
</picture>

## The kernel

The kernel owns five things and implements none of what plugs into them.

| The kernel owns | What that means |
|---|---|
| **Lifecycle** | bind every plugin in dependency order, freeze, compile routes, start, stop in reverse |
| **Resolution** | every port a plugin requires is resolved to exactly one provider before anything binds |
| **Ordering** | contributions land in named slots of a fixed chain, by phase and then by the order plugins are listed |
| **Execution** | one exchange through a route: the chain of positions and slots, the step loop and its outcomes |
| **Continuation** | how a parked exchange is written, claimed, checked and resumed |

The kernel has no opinion about retries, storage, identity, agents or HTTP.
It cannot import a plugin: the module graph is checked against an allowlist
and a new file cannot sit outside it. **Demonstrated.**

The continuation protocol is the one honest exception to "the kernel knows
nothing". It is in the kernel because nothing else could own it: a plugin
that parks and a plugin that stores must agree on what a record means, and
that agreement is a contract, not a feature. You can replace where records
are kept and what parks an exchange; you cannot change the protocol that
resumes one.

## The contracts

Everything a plugin reaches the kernel through is one of five contracts. The
kernel defines them and implements none of them.

**Port.** A named, versioned capability: `port<ContinuationStore>("execution.continuations@2")`.
A plugin **requires** ports and **provides** ports; the kernel resolves each
required port to one provider at start and refuses to start otherwise. A plugin
never names another plugin, which is what lets a stranger replace a first-party
provider under their own name. The first-party ports today are atomic records,
agent sessions, continuations, authority, enforcement and resilience.

**Contribution.** Either a **handler** or a **wrapper**, in a named **slot** of
the route's chain. The chain is fixed: its **positions** (authorize, retry,
timeout, the cache) belong to the framework and can be replaced through their
port but never moved or added to. The slots between them are where plugins
add. A handler receives the exchange and returns a decision: allow (optionally
with a decorated exchange) or refuse. A wrapper surrounds what follows it. A
handler declares a **phase**, observe, mutate or validate, which decides when
it runs within its slot and which decisions it may return; within a phase,
plugins run in the order the application lists them. Neither ever names
another plugin. Both declare **survival**: which kinds of run they apply to.
[One exchange through a route](03-exchange-through-a-route.md) works through
the ordering with an example.

**Step.** An instruction a route can execute. It receives the exchange and a
step context and returns one of six outcomes. Adapters and operations are
steps; a plugin declares them in `steps`, and each becomes a typed method on
the route builder.

**Facet.** A typed, derived view of the exchange under the plugin's namespace:
`ex.auth`, `ex.deferral`. A facet is computed from the exchange's body and
headers each time it is read; it is never stored on its own, so nothing a
facet says can go stale across a park and a resume.

**Point.** A moment at which handlers run. The kernel's own moments are the
slots of the chain. A plugin may declare a point of its own, a moment it
invokes from its steps, and the declaration says which decisions the point
honours, so the compiler and the runtime enforce the same policy. Only the
`error` slot honours parking, because only the executor knows where a park
would resume. **Intended:** the proof of concept's type lets a plugin-declared
point claim `defer: true` and then discards the decision at the call site; the
public type will restrict parking to the `error` slot.

**Execution.** Not a contract you implement but a set of verbs every plugin is
handed in `bind`: `deliver`, `resume`, `sweep` and `errorChannel`. It is how
the deferral plugin's timer drives the sweep and how an ingress hands an
approval to a parked exchange. It is a socket in the same sense as the other
five, with the same reach for ours and yours, which is why the door (see
[Waiting and resuming](04-waiting-and-resuming.md)) is the only thing that
stands between a plugin holding a continuation id and its resume.

The four sockets on the [first page](01-what-changes.md) are the four you
build with. A point is a moment you declare, and execution is a set of verbs
you call; the figure below draws all six, because all six reach the kernel.

## Where the five things you build land

| You build | It is | You deliver it as |
|---|---|---|
| An adapter (a source or destination) | a step | a `steps` entry, used as `.from(yours)` or `.to(yours)` |
| An operation | a step | a `steps` entry, which becomes `.dedupe()` |
| A layer around every route | a wrapper | a hook in a wrapper slot such as `perAttempt` |
| Code at a moment in an exchange's life | a handler | a hook in a slot, with a phase; or a point you declare |
| Something the runtime needs | a port you provide | provided in `bind`, and named in `provides` |

## Namespaces

Every plugin owns exactly one namespace, by default the last segment of its
id (`acme.approvals` owns `approvals`). Everything the plugin names lives
under it: its facet is `ex.approvals`, its route options are
`approvals.something`, its events are `approvals:something`, and what its
handlers record on a continuation is keyed by it. Two plugins cannot collide
on a string.

Some of that the compiler tells you: a method or a facet of a plugin that is
not installed does not exist to call. The rest you learn when the application
is constructed, by name: two plugins claiming one namespace, an option key
under a namespace nobody installed, a handler at a point nobody declared, a
facet not named after its owner. Handler point names and route method names
are shared vocabulary rather than owner-qualified, which is why both are
checked for collision rather than silently merged. **Demonstrated.**

## Installation

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="figures/installation-dark.png">
  <img alt="One band, a row per stage: descriptors, identity, resolution, order, bind, freeze, compile, start and stop, each with what happens there and the fault codes it can refuse with." src="figures/installation.png">
</picture>

An application is an ordinary array of plugin descriptors, in any order.
Everything that can go wrong on the way to running names the plugin
responsible and refuses before any traffic runs.

1. **Identity.** One id per plugin, one namespace per plugin, one token per
   port name. Two copies of a contract module in one process is the classic
   silent failure of plugin systems; here it is a named fault.
2. **Resolution.** Every required port is resolved to one provider. Two
   undeclared providers of one port is a fault that names both. A provider
   that declares it **replaces** a port may be installed alone or alongside
   the default, and is the one selected either way.
3. **Order.** A topological sort over what plugins require and provide. A
   cycle is a fault whose detail is the edges.
4. **Bind.** Each plugin's `bind` runs in that order, and this is where it
   requires, provides and observes. `requires` on the descriptor declares a
   port; `c.require(port)` in `bind` fetches the provider resolved for it,
   and refuses a port the descriptor did not declare. Its steps, hooks,
   facets and the points it declares are static declarations on the
   descriptor, read before anything binds; `bind` is for what needs a live
   context.
5. **Freeze.** After the last `bind`, nothing more is accepted. A provider or
   a hook arriving from `start` would silently miss an already composed
   chain, so it is refused instead.
6. **Compile.** Each hook is placed in its slot, by phase and then by plugin
   order, and a handler that breaks its phase is refused. Routes compile;
   wrapper state binds once per route, so a concurrency limit is a property of the route rather than of one
   delivery. A route that asks for something only a plugin can give names that
   plugin's port as a requirement, and refuses to compile without it.
7. **Start.** Sources subscribe, then each plugin's `start` runs in order. The
   deferral plugin's boot scan runs here. A failure rolls back what was
   acquired.
8. **Stop.** In reverse: consumers before providers, every failure
   aggregated, nothing skipped.

`application.runtime.dump()` shows the phase, the plugin order, which plugin
provides each port and whether it is a replacement, and every route's chain
with each hook in its effective order. **Demonstrated.**

## Inside

The figure at the top of this page shows the parts working together. Five
things it says that the pages around it only imply:

- **The `error` slot sits outside the whole chain.** A failure the retry
  position absorbs never reaches it; the slot hears only what escapes the
  whole chain. A handler that wants to park a transient failure for a human
  therefore sees it after the retries are spent, not before.
- **The door is the front of the chain.** On a resume the kernel runs the
  chain up to and including `afterAuth` over the arriving approval, with a
  view of the record that leaves out its body, before it discloses or claims anything. The door is whatever the
  installed handlers and the `authorize` position decide; ours is the `auth`
  plugin's gate.
- **The kernel owns the sweep; the deferral plugin owns its cadence.**
  Claiming a due record, telling its route through the error channel and
  settling it are kernel code behind `execution.sweep()`. The deferral plugin
  decides when to call it, provides the store, and sets the default deadline.
- **Every record transition goes through one port.** The kernel never touches
  storage; it calls `CONTINUATIONS`, which ours provides over `RECORDS`. In
  the figure your store can replace the records store underneath, and
  nothing above it changes.
- **Positions belong to a port.** `retry` and `timeout` are positions of the
  resilience contract, so a replacement for our resilience plugin fills the
  same positions, and every slot around them stays where it was.

**Demonstrated:** the first two by probes D3 and D5 in
`validation/direction-docs-review/`, the fourth by D7, the third and fifth by
the proof of concept's `Runtime.sweep` and, for the fifth, its anchors,
which carry the same ownership rule (`ANCHOR_OWNER`) that positions will.

## Replacing something we ship

Install your provider and declare that it replaces the port. Ours is the
default because it is installed by default, not because the kernel knows its
name; once yours is selected, our own plugins get yours, and never learn that
anything changed.

Two honest qualifications. First, a displaced default still binds and still
contributes: replacing our continuation store does not remove our deferral
plugin's route methods, its sweep, its default deadline or its dependency on
atomic records. If you want none of that, leave the default out and install
yours alone; if you want the methods and the sweep over your store, keep it
and let yours be selected. Both recipes are supported and both are tested.
**Demonstrated.** Second, who owns migrations, shutdown and the default
deadline when the provider changes is a **migration decision**, and the
provider recipe will say so explicitly before it is published.
