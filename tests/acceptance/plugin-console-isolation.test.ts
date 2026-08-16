#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertPluginConsoleIsolationAcceptance } from "../../tools/server-scripts/plugin-console-isolation-closure.ts";

export { assertPluginConsoleIsolationAcceptance };

const executedDirectly: any = process.argv[1]
  && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (executedDirectly) {
  await assertPluginConsoleIsolationAcceptance();
}
