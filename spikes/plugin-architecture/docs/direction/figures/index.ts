/**
 * The figures of the direction documents, in reading order, with their words.
 * Shaped like the site's `figures/index.ts` and `manifest.mjs` so a figure
 * moves across unchanged: `alt` is the accessible name and all a reader of
 * the raw markdown gets, `caption` is the line under the picture.
 */
import { chainAndSlots } from "./chain-and-slots.tsx";
import { continuationStates } from "./continuation-states.tsx";
import { everyWayIn } from "./every-way-in.tsx";
import { insideTheHarness } from "./inside-the-harness.tsx";
import { exchangePath } from "./exchange-path.tsx";
import { fourSockets } from "./four-sockets.tsx";
import { installation } from "./installation.tsx";
import { pluginDeclares } from "./plugin-declares.tsx";
import { resumeDoor } from "./resume-door.tsx";
import { todayAndAfter } from "./today-and-after.tsx";
import type { FigureDrawing, FigureText } from "./types.ts";

export const DRAWINGS: FigureDrawing[] = [
  everyWayIn,
  insideTheHarness,
  todayAndAfter,
  fourSockets,
  pluginDeclares,
  installation,
  exchangePath,
  chainAndSlots,
  continuationStates,
  resumeDoor,
];

export const FIGURE_TEXT: Record<string, FigureText> = {
  "inside-the-harness": {
    alt: "The inside of every harness. Top: every plugin, ours (operations, resilience, deferral, sqlite, principals, auth) and yours (a store, a wrapper, an adapter, a moment) in the same rows, each declaring id, requires, provides, replaces, points, facets, steps and hooks. Below: six sockets, port, contribution, step, facet, point and execution. Then the kernel, an inverted panel: its lifecycle, one run through a fixed chain of positions and slots (error, beforeAuth, authorize, retry, your wrapper, timeout), the step loop and exit with the six outcomes, the run kinds, and the park, resume and sweep sequences. Bottom: the ports it calls out through, each provided by a plugin.",
    caption:
      "Inside every harness: every feature a plugin, six sockets, and a kernel that decides when things run.",
  },
  "every-way-in": {
    alt: "Top: every way in, the doors when someone asks (editor over ACP, any MCP client, the CLI, HTTP) and the triggers when nobody asks (cron, webhooks, mail, runtime events, files, a parked task resuming), and you, approving by mail or chat. Middle: a local harness per person with personal credentials, and an always-on team harness with service credentials, sharing capabilities, skills and agents as npm packages. Below: inside every harness, the gate in a fixed order, agents and skills, capabilities, adapters and the runtime stores. Bottom: your systems and model providers, reached with personal or service credentials.",
    caption:
      "Every way in: the harness as a consumer meets it. The rest of these pages open up the band in the middle.",
  },
  "today-and-after": {
    alt: "Two bands. Today: your plugin outside with one verb, apply(ctx), beside an inverted Routecraft panel holding routes, deferral, resilience, auth, agents, stores and HTTP, and the private paths our own packages use. After: our plugins and yours in one row over an inverted kernel panel of lifecycle, contracts and the continuation protocol.",
    caption:
      "Today our features are inside and yours are at the window. After, every feature plugs into the kernel through the same sockets.",
  },
  "four-sockets": {
    alt: "One band of four panels, port, contribution, step and facet, each with what it is and what you build with it, and a row naming the two more sockets that reach the kernel, point and execution.",
    caption:
      "The four sockets you build with, and the two more that reach the kernel.",
  },
  "plugin-declares": {
    alt: "Left, your plugin: what it declares (id, requires, provides, replaces, points, facets, steps, hooks), what it does in bind, and its start and stop. Right, an inverted Routecraft panel: it orders, namespaces, freezes, starts and stops it.",
    caption: "A plugin declares and binds. Routecraft does the wiring.",
  },
  installation: {
    alt: "One band, a row per stage: descriptors, identity, resolution, order, bind, freeze, compile, start and stop, each with what happens there and the fault codes it can refuse with.",
    caption: "Installation, stage by stage, and where it can refuse.",
  },
  "exchange-path": {
    alt: "An inverted strip with one run through its fixed chain, from the error and beforeAuth slots through authorize, afterAuth, retry, perAttempt and timeout to the step loop, exit and completed; below it the six outcomes, what a refusal does, what happens when a step throws with the five declined parks, and the four run kinds.",
    caption:
      "One exchange through a route: the fixed order, the six outcomes, and every way a run can leave.",
  },
  "chain-and-slots": {
    alt: "Two bands. The first: the chain around every route, in order, with positions as dark chips (authorize, parse, input, throttle, circuitBreaker, retry, timeout, concurrency, cacheCheck, cacheStore) and slots as outlined chips between them (error, beforeAuth, afterAuth, admitted, perAttempt, exit), and your steps in the middle; a position is replaced through its port and never moved, removed or added, a slot takes any number of plugins. The second: inside the beforeAuth slot for an application listing security, tenancy, correlation, tracing and auth: observe runs tracing, mutate runs tenancy then correlation with the later write winning and a warning, validate runs security which may refuse and stop the chain, then the authorize position; the application can override a phase's order or disable a handler by id.",
    caption:
      "The chain: positions belong to the framework, slots belong to every plugin, and inside a slot the phase decides before the list does.",
  },
  "continuation-states": {
    alt: "A waiting band with unclaimed and claimed; beneath it an inverted panel, a resume is won once, and a light panel, a notification is leased, with the winner, a second resume and a crash on one side and the due, changed and crash paths on the other; a retention strip ends in gone.",
    caption:
      "A parked exchange over its life: a resume is won once, a notification is leased.",
  },
  "resume-door": {
    alt: "Nine numbered beats, each with the actor (the approver, the runtime or the store), the step and what it does: resume, read the record, the door, the deadline and live tail, the compare-and-swap, re-admission, the suffix, the recorded outcome, and a second resume answered as a duplicate.",
    caption:
      "The door of a resume: decided before disclosure, applied after the claim.",
  },
};
