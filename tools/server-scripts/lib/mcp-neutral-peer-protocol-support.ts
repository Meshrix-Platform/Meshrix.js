import assert from "node:assert/strict";

export function outletNames(tools: any = []) : any {
  return tools.map((tool?: any) : any => tool.name).sort();
}

export function assertExpectedOutlets(tools: any = [], expectedOutlets: any = [], label: any = "tools/list") : any {
  assert.deepEqual(outletNames(tools), [...expectedOutlets].sort(), `${label} did not return the expected stable outlets`);
}
