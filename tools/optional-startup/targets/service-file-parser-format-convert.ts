export const OPTIONAL_STARTUP_TARGET_ID: any = "service:file-parser-format-convert";

export async function startOptionalTarget(context: Record<string, any>) : Promise<any> {
  return context.startProcess({
    id: OPTIONAL_STARTUP_TARGET_ID,
    kind: "service",
    command: "go",
    args: ["run", "./cmd/format-convert"],
    cwd: context.resolveRepoPath("services/file-parser/format-convert"),
    env: context.environmentFor(OPTIONAL_STARTUP_TARGET_ID),
  });
}
