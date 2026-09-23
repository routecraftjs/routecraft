/**
 * Review mutants for round 7f: name, file under `src/v2`, pattern (matched
 * with the round-two runner's whitespace-tolerant tokenizer, and required to
 * match exactly once), replacement, and what a survivor would mean. Each is
 * run against the WHOLE suite (packed consumer excluded by name), after the
 * unchanged copy passes the same run, so a survivor is a survivor of every
 * test the head has.
 */
export const mutants: [string, string, string, string, string][] = [
  // The door and the lend.
  [
    "held elevation never released",
    "auth.ts",
    "elevations.delete(resume.id);",
    "",
    "the held elevation is never cleared; nothing tests its lifetime",
  ],
  [
    "parked lent grants dropped from the bound",
    "auth.ts",
    "...(input.deferred?.lent ?? []),",
    "",
    "a re-lend of what the park already carried is untested",
  ],
  [
    "elevation's grant ring not compared",
    "auth.ts",
    "[...view.grants].sort().join() !== [...input.deferred.grants].sort().join()",
    "false",
    "a door may widen the permanent grant ring, not only the lent one",
  ],
  [
    "elevation authenticity unchecked",
    "auth.ts",
    "if (!view?.authentic)",
    "if (false)",
    "a self-asserted shape passes the door",
  ],
  [
    "entry does not re-ask the gate of the lend",
    "auth.ts",
    "required && enforcement.check(carried.headers, required)",
    "undefined",
    "a lend that does not satisfy the gate still runs",
  ],
  [
    "door records the full principal",
    "auth.ts",
    "record: { resumedBy: authority.refOf(ex.headers) }",
    "record: { resumedBy: authority.principalOf(ex.headers) }",
    "the record keeps grants, not a reference",
  ],
  [
    "default door policy skipped",
    "auth.ts",
    "} else if (required) {",
    "} else if (false) {",
    "ruling 13 untested",
  ],
  // The resume path.
  [
    "door handed the parked body",
    "runtime.ts",
    "body: ingress.payload, headers: { ...ingress.headers },",
    "body: saved.exchange.body, headers: { ...ingress.headers },",
    "F4 untested",
  ],
  [
    "route resolved before the door",
    "runtime.ts",
    "const view: ResumeView = {",
    "this.route(saved.routeId); const view: ResumeView = {",
    "F5 untested",
  ],
  [
    "resume view omits the refusal",
    "runtime.ts",
    "...(saved.refusal !== undefined ? { refusal: saved.refusal } : {}),",
    "",
    "the bound never reaches the door",
  ],
  [
    "door record keyed by handler id",
    "runtime.ts",
    "recorded[this.host.namespaceFor(h.owner)] = result.record;",
    "recorded[h.id] = result.record;",
    "namespace keying untested",
  ],
  [
    "post-swap deadline read from the pre-door clock",
    "runtime.ts",
    "if (saved.expiresAt !== undefined && saved.expiresAt <= Date.now()) {",
    "if (saved.expiresAt !== undefined && saved.expiresAt <= now) {",
    "F6 recheck untested",
  ],
  [
    "post-swap expiry does not tell the route",
    "runtime.ts",
    "await this.errorChannel( route.spec.id, revive(saved.exchange), expiry, ).catch(() => undefined);",
    "",
    "the one notification the swap winner owes is untested",
  ],
  // Parking.
  [
    "error-ring park at a step drops the refusal",
    "runtime.ts",
    "[site.step, ...site.pending], ring.request, ring.owner, failure.detail,",
    "[site.step, ...site.pending], ring.request, ring.owner, undefined,",
    "a step-site park's bound is untested",
  ],
  [
    "error-ring park at admission drops the refusal",
    "runtime.ts",
    "route.initial, ring.request, ring.owner, failure.detail,",
    "route.initial, ring.request, ring.owner, undefined,",
    "the step-up bound is untested",
  ],
  [
    "defer inside runPath parked",
    "runtime.ts",
    'if (run.nested) throw new Fault(step.owner, "DEFER_IN_PATH", id);',
    "",
    "F7 untested",
  ],
  [
    "nested failures carry a site",
    "runtime.ts",
    "if (!run.nested && !f.site)",
    "if (!f.site)",
    "a nested step's site reaching the parent's park is untested",
  ],
  [
    "notify failure swallowed",
    "runtime.ts",
    'throw fault(owner, "NOTIFY", e);',
    "",
    "what a failed notify does is untested",
  ],
  [
    "notify told before the record is durable",
    "runtime.ts",
    "await store.create(id, saved);",
    "await request.notify?.(id); await store.create(id, saved);",
    "notify ordering untested",
  ],
  [
    "deferred event before notify",
    "runtime.ts",
    "if (request.notify) try {",
    'this.host.emit("exchange:deferred", { id, route: route.spec.id }); if (request.notify) try {',
    "event ordering untested",
  ],
  [
    "frames never bounded",
    "runtime.ts",
    "from + run < ids.length ? { list, from, to: from + run } : { list, from },",
    "{ list, from },",
    "F8 bounded slice untested",
  ],
  [
    "step state handed to every step",
    "runtime.ts",
    "...(run.resumption?.site === id",
    "...(run.resumption",
    "step-state scoping untested",
  ],
  // The sweep and the stop.
  [
    "stall check removed",
    "runtime.ts",
    "previous && !(",
    "false && !(",
    "SCAN_STALLED untested",
  ],
  [
    "sweep ignores a stop between records",
    "runtime.ts",
    "for (const entry of page) { if (!this.#accept) break;",
    "for (const entry of page) {",
    "F12 between-records stop untested",
  ],
  [
    "sweep ignores a stop between pages",
    "runtime.ts",
    "for (;;) { if (!this.#accept) break;",
    "for (;;) {",
    "F12 between-pages stop untested",
  ],
  [
    "error channel refused during the drain",
    "runtime.ts",
    "if (!this.#accept && !this.#draining)",
    "if (!this.#accept)",
    "F12 drain delivery untested",
  ],
  // Storage and the plugin.
  [
    "default ttl dropped",
    "storage.ts",
    "ttl = options.ttl === undefined ? DEFAULT_TTL : options.ttl;",
    "ttl = options.ttl === undefined ? null : options.ttl;",
    "F14 untested",
  ],
  [
    "boot report reads the plugin's own store",
    "storage.ts",
    "const store = ctx.require(CONTINUATIONS);",
    "const store = durableStore(ctx.require(RECORDS));",
    "F11 untested",
  ],
  [
    "purge deletes waiting records",
    "storage.ts",
    'saved.state === "waiting" ||',
    "",
    "retention of live records untested",
  ],
  // The codec.
  [
    "decode accumulates on an ordinary prototype",
    "codec.ts",
    "const out: Record<string, unknown> = Object.create(null) as Record< string, unknown >; for (const key of keys) out[key]",
    "const out: Record<string, unknown> = {}; for (const key of keys) out[key]",
    "the __proto__ read-side rule untested",
  ],
];
