import { defineProject, direct } from "../../../src/index.ts";
import { plugins } from "./plugins.ts";

const project = defineProject({ plugins });

export const route = project
  .craft()
  .id("wrong")
  .from<string>(direct())
  .alphaKeep((body) => body.length)
  .bravoOrder(0.1);
