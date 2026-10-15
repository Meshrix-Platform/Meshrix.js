import { spawn } from "node:child_process";

const [ownerChildScript, moduleUrl, dataDir] = process.argv.slice(2);
const writer = spawn(process.execPath, ["--experimental-strip-types", ownerChildScript, moduleUrl, dataDir, "hold"], {
  detached: true,
  stdio: ["ignore", "inherit", "inherit"]
});
writer.unref();
process.stdout.write(`parent:${writer.pid}\n`);
process.stdin.resume();
