import { readFile } from "node:fs/promises";
import { createGateway } from "@meshrix/gateway";

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

async function readConfig(path: unknown): Promise<Record<string, unknown> | undefined> {
  if (typeof path !== "string" || path.length === 0) return undefined;
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Gateway configuration must be a JSON object.");
  return parsed;
}

/** Handles only the embedded gateway profile; it never starts UI or plugins. */
export async function runGatewayCommand(args: Record<string, any>): Promise<boolean> {
  const profile = String(args._?.[0] ?? "");
  if (profile !== "gateway" && profile !== "gateway-only") return false;
  const config = await readConfig(args.config ?? args["config-file"]);
  if (args["dry-run"]) {
    console.log(JSON.stringify({ profile: "gateway-only", valid: true, hasConfig: Boolean(config), startsConsole: false, startsPlugins: false }));
    return true;
  }
  const gateway = createGateway({ serverInfo: { profile: "gateway-only" } });
  await gateway.start();
  try {
    if (args.health || args.close || !config) {
      console.log(JSON.stringify({ profile: "gateway-only", health: gateway.stats().started ? "ok" : "not_started", startsConsole: false, startsPlugins: false }));
    }
  } finally {
    await gateway.close({ drainDeadline: 1000 });
  }
  return true;
}
