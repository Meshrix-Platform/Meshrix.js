/**
 * Lifecycle facts for the installed entry product.
 *
 * The uninstall/revoke boundary is a fixed, enumerable path list — the app
 * only ever removes what it owns: its data dir, the config file, the managed
 * MCP snippet file and per-connection custody refs (`entry-gui.*` and
 * `dev.entry.*` minted by pairing/recovery). Platform install/uninstall notes
 * live in electron-builder.yml + README; this module is the runtime source
 * for the "what will be removed" display.
 */
import { join } from "node:path";

import type { EntryGuiConfig } from "./config-store.ts";

export interface EntryLifecyclePaths {
  readonly dataDir: string;
}

/** All filesystem paths this installation owns. */
export function ownedPathsFor(paths: EntryLifecyclePaths, config: EntryGuiConfig | null): readonly string[] {
  const owned = new Set<string>();
  owned.add(paths.dataDir);
  owned.add(join(paths.dataDir, "entry-gui.config.json"));
  if (config?.mcp.managedConfigPath) owned.add(config.mcp.managedConfigPath);
  return [...owned];
}
