export const OPTIONAL_STARTUP_TARGET_ID: any = "service:model-gateway";

export async function startOptionalTarget(context: Record<string, any>) : Promise<any> {
  return context.startProcess({
    id: OPTIONAL_STARTUP_TARGET_ID,
    kind: "service",
    command: process.execPath,
    args: [context.resolveRepoPath("services/model-gateway/src/main.mjs")],
    cwd: context.resolveRepoPath("services/model-gateway"),
    env: context.environmentFor(OPTIONAL_STARTUP_TARGET_ID),
  });
}
