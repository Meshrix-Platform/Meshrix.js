import { createGateway } from "@meshrix/gateway";

export interface GatewayOnlyCliOptions {
  readonly health?: boolean;
  readonly dryRun?: boolean;
}

export async function runGatewayOnly(options: GatewayOnlyCliOptions = {}): Promise<{ readonly profile: "gateway-only"; readonly health: "ok" | "dry-run" }> {
  if (options.dryRun) return Object.freeze({ profile: "gateway-only", health: "dry-run" });
  const gateway = createGateway({ serverInfo: { profile: "gateway-only" } });
  await gateway.start();
  try {
    return Object.freeze({ profile: "gateway-only", health: gateway.stats().started ? "ok" : "dry-run" });
  } finally {
    await gateway.close({ drainDeadline: 1000 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runGatewayOnly({ dryRun: process.argv.includes("--dry-run"), health: process.argv.includes("--health") })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

