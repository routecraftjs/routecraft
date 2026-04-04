#!/usr/bin/env node

/* eslint-disable no-console */

import { main } from "./lib.js";

main().catch((error) => {
  console.error("Unexpected error:", error);
  process.exit(1);
});
