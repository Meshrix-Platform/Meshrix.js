#!/usr/bin/env node
import {
  checkReassemblyContract,
  planReassembly
} from "./reassembly-contract.mjs";

const [command, first = ".", ...rest] = process.argv.slice(2);
const option = (name) => {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] || "" : "";
};

let result;
if (command === "plan") {
  result = await planReassembly({
    target: first,
    changedFrom: option("--changed-from")
  });
} else if (command === "check") {
  result = await checkReassemblyContract({
    contractPath: first,
    target: option("--target") || "."
  });
} else {
  throw new Error("usage: reassembly-cli.mjs <plan|check> <target-or-contract>");
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
