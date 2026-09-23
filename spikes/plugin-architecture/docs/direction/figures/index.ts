/**
 * The figures of the direction documents, in reading order, with their words.
 * Shaped like the site's `figures/index.ts` and `manifest.mjs` so a figure
 * moves across unchanged: `alt` is the accessible name and all a reader of
 * the raw markdown gets, `caption` is the line under the picture.
 */
import { continuationStates } from "./continuation-states.tsx";
import { exchangePath } from "./exchange-path.tsx";
import { fourSockets } from "./four-sockets.tsx";
import { installation } from "./installation.tsx";
import { kernelBoundary } from "./kernel-boundary.tsx";
import { pluginDeclares } from "./plugin-declares.tsx";
import { resumeDoor } from "./resume-door.tsx";
import { todayAndAfter } from "./today-and-after.tsx";
import type { FigureDrawing, FigureText } from "./types.ts";

export const DRAWINGS: FigureDrawing[] = [
  todayAndAfter,
  fourSockets,
  kernelBoundary,
  pluginDeclares,
  installation,
  exchangePath,
  continuationStates,
  resumeDoor,
];

export const FIGURE_TEXT: Record<string, FigureText> = {
  "today-and-after": {
    alt: "Left: a solid Routecraft block with routes, deferral, resilience, auth, agents and stores inside it, and a plugin outside reaching in through one call. Right: those same features drawn as equal blocks beside a third-party store and step, each plugged into a small kernel through an identical arrow.",
    caption:
      "Today our features are inside and yours are at the window. After, every feature plugs into the kernel through the same sockets.",
  },
  "four-sockets": {
    alt: "A plugin on the left with one arrow to four columns: port, contribution, step and facet, each with what it is and what you build with it.",
    caption: "The four sockets, and the five things you build with them.",
  },
  "kernel-boundary": {
    alt: "Four bands. First-party plugins and third-party plugins each reach a row of contracts (port, contribution, step, facet, point) through identical arrows; below the contracts sits the kernel: lifecycle, resolution, ordering, execution, continuation.",
    caption:
      "What the kernel owns, what it defines, and the two identical arrows into it.",
  },
  "plugin-declares": {
    alt: "A plugin card listing its id, what it requires and provides, the points it declares, what it does in bind, and its start and stop; an arrow to Routecraft, which orders, namespaces, freezes, starts and stops it.",
    caption: "A plugin declares and binds. Routecraft does the wiring.",
  },
  installation: {
    alt: "A vertical flow from plugin descriptors through identity validation, port resolution, dependency ordering, bind, freeze, contribution ordering, route compilation and start, to running and then stop in reverse; fault codes beside the stages that can refuse.",
    caption: "Installation, and where it can refuse.",
  },
  "exchange-path": {
    alt: "A central spine from delivery through the admission ring, entry ring, wrapper chain and step loop to the exit ring and completed. Left: the six step outcomes ending in deferred. Right: refused, and a thrown step reaching the error ring, which may park or end failed.",
    caption:
      "One exchange through a route: rings, the step loop, and where it can leave.",
  },
  "continuation-states": {
    alt: "A waiting box holding unclaimed and claimed with a lease between them; an accented arrow to resumed, won once by compare-and-swap; claimed leading to expired or denied; every settled state purged after retention.",
    caption:
      "A parked exchange over its life: a resume is won once, a notification is leased.",
  },
  "resume-door": {
    alt: "Nine numbered beats across three lanes, approver, runtime and store: resume, read the record, the door, the deadline and live tail check, the claim, re-admission, the suffix, the recorded outcome, and a duplicate resume answered from the record.",
    caption:
      "The door of a resume: decided before disclosure, applied after the claim.",
  },
};
