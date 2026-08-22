export const OPTIONAL_STARTUP_TARGET_ID: any = "service:skill-hub";

export async function startOptionalTarget(context: Record<string, any>) : Promise<any> {
  return context.startProcess({
    id: OPTIONAL_STARTUP_TARGET_ID,
    kind: "service",
    command: process.execPath,
    args: [context.resolveRepoPath("services/skill-hub/src/main.mjs")],
    cwd: context.resolveRepoPath("services/skill-hub"),
    env: context.environmentFor(OPTIONAL_STARTUP_TARGET_ID),
  });
}
