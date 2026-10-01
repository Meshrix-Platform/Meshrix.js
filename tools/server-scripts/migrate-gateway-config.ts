import {
  applyGatewayMigration,
  previewGatewayMigration,
  restoreGatewayMigration
} from "../../apps/mcp-gateway-installer/src/config-migration.ts";

export {
  GATEWAY_MIGRATION_SCHEMA,
  applyGatewayMigration,
  previewGatewayMigration,
  restoreGatewayMigration
} from "../../apps/mcp-gateway-installer/src/config-migration.ts";
export type {
  GatewayMigrationApplyOptions,
  GatewayMigrationOptions,
  GatewayMigrationReport
} from "../../apps/mcp-gateway-installer/src/config-migration.ts";

function cliArgs(argv: readonly string[]): { command: "preview" | "apply" | "restore"; input?: string; expectedRevision?: string; backupRevision?: string; backup?: string } {
  const [command = "preview", ...rest] = argv;
  let input: string | undefined;
  let expectedRevision: string | undefined;
  let backup: string | undefined;
  let backupRevision: string | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (item === "--input") input = rest[++index];
    else if (item === "--expected-revision") expectedRevision = rest[++index];
    else if (item === "--backup") backup = rest[++index];
    else if (item === "--backup-revision") backupRevision = rest[++index];
  }
  if (command !== "preview" && command !== "apply" && command !== "restore") throw new Error("Usage: migrate-gateway-config.ts preview|apply|restore --input CONFIG.json --expected-revision SHA256 [--backup-revision SHA256] [--backup BACKUP.json]");
  return { command, input, expectedRevision, backupRevision, backup };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = cliArgs(process.argv.slice(2));
  if (!args.input) throw new Error("--input is required");
  const operation = args.command === "preview"
    ? previewGatewayMigration(args.input, { expectedRevision: args.expectedRevision })
    : args.command === "restore"
      ? args.expectedRevision && args.backupRevision ? restoreGatewayMigration(args.input, { expectedRevision: args.expectedRevision, backupRevision: args.backupRevision, backupPath: args.backup }) : Promise.reject(new Error("Restore needs expected and backup revisions."))
      : applyGatewayMigration(args.input, { expectedRevision: args.expectedRevision, backupPath: args.backup });
  operation.then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
