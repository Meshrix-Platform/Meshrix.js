#!/usr/bin/env node
// Configuration-only fixture; never connects to a server or starts an Agent.
import fs from "node:fs";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("fixture 1.0.0"); process.exit(0); }
if (args[0] === "--help" || (args[0] === "mcp" && args[1] === "--help")) { console.log("pi mcp add <server>"); process.exit(0); }
const file = process.env.OPENCLAW_CONFIG_PATH;
if (!file) process.exit(64);
const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
if (args.join(" ") === "mcp show --json") { console.log(JSON.stringify(config.mcp?.servers || {})); process.exit(0); }
if (args[0] === "config" && args[1] === "set" && args[2] === "--batch-file") {
  const assignments = JSON.parse(fs.readFileSync(args[3], "utf8"));
  for (const { path, value } of assignments) {
    if (!/^mcp\.servers\.[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(path)) process.exit(64);
    config.mcp ??= {};
    config.mcp.servers ??= {};
    config.mcp.servers[path.split(".")[2]] = value;
  }
} else if (args[0] === "mcp" && args[1] === "unset") {
  if (!config.mcp?.servers?.[args[2]]) process.exit(1);
  delete config.mcp.servers[args[2]];
} else process.exit(64);
fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
