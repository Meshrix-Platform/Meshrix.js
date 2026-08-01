import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";

const copies: any = [
  ["dist/packages/contracts/src", "packages/contracts/dist"],
  ["dist/packages/foundation/src", "packages/foundation/dist"],
  ["dist/packages/agents/src", "packages/agents/dist"],
  ["dist/packages/capabilities/src", "packages/capabilities/dist"],
  ["dist/packages/server-runtime/src", "packages/server-runtime/dist"],
  ["dist/packages/protocols", "packages/protocols/dist"],
  ["dist/apps/server", "apps/server/dist"],
  [
    "dist/packages/protocols/mcp/adapter/gateway-installer",
    "packages/protocols/mcp/adapter/gateway-installer/dist",
  ],
] as const;

const assetCopies: any = [
  [
    "packages/agents/src/agent-gateway/external-gateway/module.json",
    "packages/agents/dist/agent-gateway/external-gateway/module.json",
  ],
  [
    "packages/agents/src/workspace-contribution/workspace-contribution.lifecycle.json",
    "packages/agents/dist/workspace-contribution/workspace-contribution.lifecycle.json",
  ],
  [
    "packages/capabilities/src/communication-service/module.json",
    "packages/capabilities/dist/communication-service/module.json",
  ],
  [
    "packages/contracts/src/fixtures/mcp-catalog-delivery-wire-corpus.json",
    "packages/contracts/dist/fixtures/mcp-catalog-delivery-wire-corpus.json",
  ],
  [
    "packages/foundation/src/version-control/version-registry.json",
    "packages/foundation/dist/version-control/version-registry.json",
  ],
  [
    "packages/foundation/src/version-control/version-registry.schema.json",
    "packages/foundation/dist/version-control/version-registry.schema.json",
  ],
  [
    "packages/foundation/src/workflow/state-machine/definitions",
    "packages/foundation/dist/workflow/state-machine/definitions",
  ],
] as const;

for (const [source, target] of copies) {
  await rm(target, { recursive: true, force: true });
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

for (const [source, target] of assetCopies) {
  await mkdir(path.dirname(target), { recursive: true });
  await cp(source, target, { recursive: true });
}

process.stdout.write(
  `${JSON.stringify({ synchronizedPackages: copies.length, synchronizedAssets: assetCopies.length })}\n`,
);
