#!/usr/bin/env node
import { parseOptionalStartupArgs } from "./contract.ts";
import { listOptionalStartupTargets, startOptionalTargets } from "./runner.ts";

function printUsage() : any {
  process.stdout.write(`Usage:
  npm run start:optional -- --list
  npm run start:optional -- --target <kind:id> [--target <kind:id> ...]
    [--runtime-config <file>] [--env-file <kind:id>=<json-file> ...]

No target is selected by default. Runtime plugins require a runtime config
whose runtime.enabledPlugins exactly matches the selected plugin targets.
`);
}

async function main() : Promise<any> {
  const parsed: any = parseOptionalStartupArgs(process.argv.slice(2));
  if (parsed.mode === "help") {
    printUsage();
    return;
  }
  if (parsed.mode === "list") {
    process.stdout.write(`${JSON.stringify({ ok: true, targets: listOptionalStartupTargets() })}\n`);
    return;
  }

  const controller: any = await startOptionalTargets(parsed);
  process.stdout.write(`${JSON.stringify(controller.summary)}\n`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () : any => controller.stop(signal));
  }
  await controller.wait();
}

main().catch((error?: any) : any => {
  process.stderr.write(`${JSON.stringify({ ok: false, code: error?.code || "optional_startup_failed" })}\n`);
  process.exitCode = 1;
});
