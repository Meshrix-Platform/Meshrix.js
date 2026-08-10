#!/usr/bin/env node
import fs from "node:fs";

const statePath = process.env.MESHRIX_FAKE_CLIENT_STATE;
const state = statePath && fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { installed: false, packageInstalled: false };
const args = process.argv.slice(2);
function save() { if (statePath) fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`); }
if (args[0] === "--version") { console.log("fake 1.0.0"); process.exit(0); }
if (args[0] === "--help" || (args[0] === "mcp" && args[1] === "--help")) { console.log("Model Context Protocol --add-mcp"); process.exit(0); }
if (args[0] === "list") { if (state.packageInstalled) console.log("@meshrix/agent-pi-adapter"); process.exit(0); }
if (args[0] === "install" && args[1] === "--help") { console.log("pi install <source>"); process.exit(0); }
if (args[0] === "install") { state.packageInstalled = true; state.lastInstallSource = args[1]; save(); process.exit(0); }
if (args[0] === "remove") { state.packageInstalled = false; save(); process.exit(0); }
if (args[0] === "mcp" && ["get", "show"].includes(args[1])) { if (state.installed) { console.log("lico"); process.exit(0); } process.exit(1); }
if (args[0] === "mcp" && ["add", "add-json", "set"].includes(args[1])) { state.installed = true; save(); process.exit(0); }
if (args[0] === "mcp" && ["remove", "unset"].includes(args[1])) { state.installed = false; save(); process.exit(0); }
process.exit(1);
