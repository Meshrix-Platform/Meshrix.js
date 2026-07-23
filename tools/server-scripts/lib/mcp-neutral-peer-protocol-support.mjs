import assert from "node:assert/strict";

export function outletNames(tools = []) {
  return tools.map((tool) => tool.name).sort();
}

export function assertExpectedOutlets(tools = [], expectedOutlets = [], label = "tools/list") {
  assert.deepEqual(outletNames(tools), [...expectedOutlets].sort(), `${label} did not return the expected stable outlets`);
}
