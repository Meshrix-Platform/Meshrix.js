import { test } from "vitest";

// Share the dependency-free Node test cases with the repository's Vitest discovery.
const { registerSourceStartTests } = await import(
  new URL("../../lib/source-start-cases.mjs", import.meta.url).href
);
registerSourceStartTests(test);
