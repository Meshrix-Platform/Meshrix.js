export const OPTIONAL_STARTUP_TARGET_ID: any = "agent:self-maintenance";

export async function startOptionalTarget(context: Record<string, any>) : Promise<any> {
  return context.startProcess({
    id: OPTIONAL_STARTUP_TARGET_ID,
    kind: "agent",
    command: process.execPath,
    args: [context.resolveRepoPath("plugins/agents/meshrix-self-maintenance/src/main.mjs")],
    cwd: context.resolveRepoPath("plugins/agents/meshrix-self-maintenance"),
    env: context.environmentFor(OPTIONAL_STARTUP_TARGET_ID),
  });
}
