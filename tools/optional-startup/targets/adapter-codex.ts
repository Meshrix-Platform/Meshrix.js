import { loadOptionalAdapterTarget } from "../adapter-target.ts";

export const OPTIONAL_STARTUP_TARGET_ID: any = "adapter:codex";

export async function startOptionalTarget() : Promise<any> {
  return loadOptionalAdapterTarget({
    id: OPTIONAL_STARTUP_TARGET_ID,
    adapterTarget: "codex",
    load: () : any => import(new URL("../../../plugins/agents/codex/adapter.mjs", import.meta.url).href),
  });
}
