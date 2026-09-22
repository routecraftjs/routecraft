# The mechanism, one level down

Read `DIAGRAMS.md` first. That file has the idea; this one has how it runs.

These are drawn from the code rather than the prose, and `bun run verify:diagram`
re-derives the module graph from the AST and fails if this file and `src/v2/`
disagree. They therefore look like reality, because they are.

`ARCHITECTURE.md` remains the source of truth.

Mermaid renders inline on GitHub. Nothing here needs a toolchain.

---

## 1. Modules and the enforced dependency graph

The layering exists so that editors who come and go cannot quietly couple two
things. Every edge below is permitted by `validation/round-two/boundaries.ts`;
every edge not drawn fails `bun run verify`. The gate is closed over the directory,
walks dynamic `import()` as well as top-level statements, and refuses a computed
specifier, so a new file cannot sit outside it.

```mermaid
%% module-graph
graph TD
    subgraph kernel["kernel: lifecycle and contracts, no business logic"]
        contracts["contracts.ts<br/><i>types, ports, StepOutcome</i>"]
        graph_["graph.ts<br/><i>topological sort</i>"]
        host["host.ts<br/><i>installation, resolution, teardown</i>"]
        runtime["runtime.ts<br/><i>execution, handlers, continuation</i>"]
        codec["codec.ts<br/><i>persistence codec, fingerprints</i>"]
    end
    subgraph surface["consumer surface"]
        dsl["dsl.ts<br/><i>fluent builder, facets, Application</i>"]
    end
    subgraph plugins["first-party plugins, replaceable like any other"]
        operations["operations.ts<br/><i>transform, retry, timeout, breaker</i>"]
        storage["storage.ts<br/><i>SQLite records, deferral</i>"]
        auth["auth.ts<br/><i>principal header, brand, authorize</i>"]
    end
    index["index.ts<br/><i>the published entry point</i>"]

    graph_ --> contracts
    host --> contracts
    host --> graph_
    runtime --> contracts
    runtime --> host
    runtime --> codec
    codec --> contracts
    dsl --> contracts
    dsl --> host
    dsl --> runtime
    operations --> contracts
    operations --> dsl
    storage --> contracts
    storage --> dsl
    storage --> codec
    auth --> contracts
    auth --> dsl
    index --> contracts
    index --> dsl
    index --> host
    index --> runtime
    index --> operations
    index --> storage
    index --> auth
    index --> codec
```

Read the absent edges. `contracts.ts` imports nothing, so a contract can never
reach an implementation. `host.ts` cannot see `runtime.ts`, so installation does
not know how an exchange runs. Neither `operations.ts` nor `storage.ts` is
visible to anything in the kernel, which is the mechanical form of the claim
that first-party capabilities hold no privilege.

---

## 2. What core owns, and what a plugin reaches it through

Core is lifecycle management and contracts. It has no opinion about retries,
storage, agents or HTTP. A plugin never names another plugin: it names a **port**
and the host resolves a provider, which is why a stranger can replace a
first-party provider under its own identity.

```mermaid
graph TB
    subgraph core["CORE: lifecycle and contracts only"]
        direction LR
        lifecycle["Lifecycle<br/>bind → freeze → start → stop"]
        resolution["Resolution<br/>ports → one provider"]
        ordering["Ordering<br/>anchors and constraints"]
        execution["Execution<br/>the six-outcome protocol"]
    end

    subgraph contractsbox["CONTRACTS core defines and never implements"]
        direction LR
        port["Port&lt;T&gt;<br/><i>RECORDS, SESSIONS,<br/>CONTINUATIONS</i>"]
        contribution["Contribution<br/><i>Handler | Wrapper</i>"]
        instr["Step<br/><i>returns StepOutcome</i>"]
        facet["Facet<br/><i>typed exchange property</i>"]
    end

    subgraph first["FIRST PARTY (plugins)"]
        ops["operations"]
        res["resilience"]
        defer["deferral"]
        sql["sqlite"]
    end

    subgraph third["THIRD PARTY (plugins)"]
        acme["acme.store<br/><i>replaces CONTINUATIONS</i>"]
        acmeh["acme.inspect<br/><i>declares a handler point</i>"]
    end

    core --- contractsbox
    first -->|"require / provide / contribute"| contractsbox
    third -->|"the same verbs, no extra privilege"| contractsbox

    style core fill:#1f3a5f,color:#fff
    style contractsbox fill:#2d4a2b,color:#fff
```

The two lower boxes reach the middle one by identical arrows on purpose. That
equality is the whole design claim, and it is tested by building a plugin
against a packed tarball rather than against workspace source.

---

## 3. Installation: descriptors to a running application

Everything that can fail names the plugin responsible, and everything that can
be contributed must be contributed before the chain is composed. `freeze` is the
line: a contribution arriving from `start()` would silently miss an already
composed chain, so it is refused instead.

```mermaid
flowchart TD
    A["Plugin descriptors<br/><i>an ordinary array</i>"] --> B{"Validate identity"}
    B -->|"duplicate id"| X1["DUPLICATE_ID"]
    B -->|"two tokens, one name"| X2["PORT_IDENTITY"]
    B -->|"replaces without provides"| X3["INVALID_REPLACEMENT"]
    B --> C{"Resolve each port"}
    C -->|"no provider"| X4["UNAVAILABLE_PORT"]
    C -->|"two undeclared providers"| X5["DUPLICATE_PROVIDER<br/><i>names both</i>"]
    C -->|"one, or one plus<br/>a declared replacement"| D["Topologically sort<br/>by declared dependency"]
    D -->|"cycle"| X6["CYCLE<br/><i>owner is every unresolved id,<br/>detail is the edges</i>"]
    D --> E["bind() each plugin in order<br/><i>require, provide, contribute, observe</i>"]
    E --> F["FREEZE<br/><i>no contribution after this point</i>"]
    F --> G["Order contributions<br/>by anchor and constraint"]
    G --> H["Compile routes<br/><i>wrapper state binds once per route</i>"]
    H --> I["sources subscribe, then<br/>start() each plugin<br/><i>the deferral plugin's boot scan runs here</i>"]
    I -->|"any failure"| R["Roll back<br/><i>release what was acquired</i>"]
    I --> J(["Running"])
    J --> K["stop() in reverse<br/><i>consumers before providers,<br/>failures aggregated</i>"]

    style F fill:#5f1f1f,color:#fff
    style J fill:#1f5f2f,color:#fff
```

The same topological sort orders plugins by dependency and contributions by
constraint. They are the same problem, and solving them once is the evidence
that core understands dependency rather than capability.

---

## 4. One exchange through a route

The step loop is the protocol round one discarded and round five restored. Six
outcomes, not a `void` return, which is what makes halting, branching and
deferring expressible by a plugin rather than only by the framework.

```mermaid
flowchart TD
    D(["deliver / resume / errorChannel"]) --> ADM{"admission handlers"}
    ADM -->|"refuse"| REF(["refused"])
    ADM -->|"allow, decoration composes"| ENT{"entry handlers"}
    ENT -->|"refuse"| REF
    ENT --> W

    subgraph W["wrapper chain, ordered by declared anchors"]
        direction LR
        BR["breaker"] --> RT["retry"] --> TO["timeout"] --> CC["concurrency"]
    end

    W --> LOOP{"next step<br/>returns StepOutcome"}
    LOOP -->|"continue"| LOOP
    LOOP -->|"complete"| EXIT
    LOOP -->|"drop"| EXIT
    LOOP -->|"branch"| NEST["splice the chosen children<br/>ahead of what pends"]
    NEST --> LOOP
    LOOP -->|"fanOut"| FAN["schedule every child<br/><i>siblings pend; none may park</i>"]
    FAN --> LOOP
    LOOP -->|"defer"| SAVE["persist continuation<br/><i>route, frames, tail hash, exchange</i>"]
    SAVE --> PARK(["deferred: process may now exit"])
    LOOP -->|"fault"| ERRH{"error handlers"}
    ADM -->|"refuse, first delivery"| ERRH
    ERRH -->|"a handler throws"| SEC["primary error kept,<br/>handler fault recorded as secondary"]
    SEC --> ERRH
    ERRH -->|"defer, from a handler<br/>that declared it"| SITE{"at the failing step,<br/>or the door for a refusal;<br/>refused if cancelled, unsited,<br/>in a fan-out, or repeated"}
    SITE --> SAVE
    ERRH -->|"otherwise"| FAIL(["failed"])
    LOOP -->|"path done"| EXIT["exit handlers<br/><i>decoration reaches the caller</i>"]
    EXIT --> DONE(["completed"])

    style PARK fill:#5f4a1f,color:#fff
    style DONE fill:#1f5f2f,color:#fff
    style REF fill:#5f1f1f,color:#fff
    style FAIL fill:#5f1f1f,color:#fff
```

A handler declares which run kinds it survives, so a policy can apply on first
delivery and deliberately not re-apply on a resumed continuation. A park
raised at the door (a refusal an error handler answered by parking) is
re-admitted when it resumes, so the gate that refused is asked again of what
the continuation carries now. A wrapper does
the same: the breaker does not re-arm on `resume`, and nothing in the chain runs
on `errorChannel`.

Two things are worth noticing because they were defects before they were
features. The chain order is declared, not positional, so a stranger can land
between `retry` and `timeout` without a core change. And wrapper state binds
once per compiled route, so a concurrency limit is a property of the route
rather than of one delivery.

---

## 5. A deferred continuation, including the crash path

This is the diagram round seven corrected and round 7e completed. Two
mechanisms, deliberately asymmetric. A **resume** is a compare-and-swap out of
`waiting`: exactly one caller wins, a second is answered from the cache with
how the first ended, and a holder that dies mid-run leaves residue that the
deferral plugin reports when the application next starts and never re-runs,
because a half-run continuation may have half-happened side effects. A
**notification** (expiry, or denial of a changed plan) is a claim over a record
that stays `waiting` and excludes a resume while it holds: a holder that dies
mid-delivery is healed by the lease and the nag is re-sent, because re-sending
a nag is safe. Round six had modelled the resume as the lease, which re-ran
continuations. The shipped framework (`revive.ts`, `types.ts`) has it this
way.

```mermaid
stateDiagram-v2
    [*] --> waiting: defer<br/>record + index in ONE transaction<br/>id = exchangeId#sequence
    state waiting {
        [*] --> unclaimed
        unclaimed --> claimed: claimExpiry(id, at)<br/>due, or plan changed
        claimed --> unclaimed: releaseClaims(before)<br/>lease elapsed, nag re-sent
    }
    unclaimed --> resumed: markResumed(id, at)<br/>CAS, unclaimed only<br/>index cleared
    resumed --> resumed: second resume<br/>answered DUPLICATE with the cached outcome
    claimed --> expired: markExpired(id, at)<br/>after the nag was delivered
    claimed --> denied: markDenied(id, at, reason)<br/>after the re-ask was delivered
    resumed --> [*]: purgeSettled, past retention
    expired --> [*]: purgeSettled, past retention
    denied --> [*]: purgeSettled, past retention

    note right of resumed
        Winner runs the tail, then
        recordOutcome. Died before
        that? Reported by the deferral
        plugin's boot scan through
        resumedWithoutOutcome.
        Never re-run.
    end note
```

The crash path in sequence, which is what the process test actually executes:

```mermaid
sequenceDiagram
    participant P1 as Process 1
    participant S as Store (SQLite)
    participant P2 as Process 2

    P1->>S: defer: record + waiting index (one transaction)
    Note over P1: effects so far: prefix, tool-request
    P1-xP1: SIGKILL
    Note over S: record: waiting
    P2->>P2: resume(id, ingress): the door, over the INGRESS<br/>handed a view of the record without its body,<br/>before the route is resolved or the record's state disclosed
    Note over P2: a refused resumer learns nothing<br/>and spends nothing
    P2->>S: deadline, then LIVE tail hash against the compiled route
    Note over P2: an edited or appended tail step is refused,<br/>the record denied, the route told through its error channel
    P2->>S: markResumed: CAS out of waiting, unclaimed only,<br/>writing what the door recorded about the resumer
    P2->>P2: deadline checked again, then run the SUFFIX only,<br/>as the PARKED identity restored, or as the door's lend re-minted it<br/>(a park raised at the door is re-admitted first)<br/>nothing else from the ingress reaches it
    P2->>S: recordOutcome (what is persistable; a completion stays a completion)
    P2->>S: resume(id) again
    S-->>P2: duplicate, with the cached outcome

    rect rgb(95, 74, 31)
        Note over P2,S: if Process 2 dies between markResumed<br/>and recordOutcome: reported by the next boot scan,<br/>never re-run
    end
```

What this does **not** claim, checked against the shipped framework: external
effects are at-least-once, not exactly-once; the session and deferral stores are
not in one distributed transaction; and a timeout cannot retract IO from a
plugin that ignores cancellation. All three are limits the current framework
also has and documents.

---

## Where to look in the code

| Diagram | Code |
|---|---|
| 1 | `validation/round-two/boundaries.ts` is the allowlist, executable |
| 2 | `src/v2/contracts.ts` for ports and contributions, `Installation` for the verbs |
| 3 | `src/v2/host.ts` constructor and `start`, `src/v2/graph.ts` |
| 4 | `src/v2/runtime.ts`, the outcome switch and the handler loop |
| 5 | `src/v2/storage.ts` `durableStore` and `deferralPlugin`, `src/v2/codec.ts`, `src/v2/runtime.ts` `resume`, `settle` and `sweep`, `test/round-two/process.test.ts`, `test/round-two/corrections.test.ts`, `test/round-two/round-seven-e.test.ts` |
