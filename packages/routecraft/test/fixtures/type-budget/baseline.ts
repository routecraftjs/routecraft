import { craft, direct, noop } from "../../../src/index.ts";

export const route = craft().id("baseline").from(direct()).to(noop());
