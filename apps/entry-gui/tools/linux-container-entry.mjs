import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

try {
  run("npm", ["ci", "--registry=https://registry.npmjs.org", "--userconfig=/dev/null"]);
  run("npm", ["run", "dist", "--workspace", "@meshrix/entry-gui", "--", "--bundles", "deb"]);
} catch {
  process.stderr.write("The native Linux Meshrix Entry package build did not complete.\n");
  process.exit(1);
}
