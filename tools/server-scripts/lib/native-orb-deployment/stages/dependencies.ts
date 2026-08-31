import path from "node:path";

import { assertInactiveReleaseMutation, orbText, runOrb, writeRemoteFile } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine } = context.parsed;
  const dependencyMarker: any = path.posix.join(context.releaseDirectory, ".meshrix-dependencies-ready");
  const toolchainState: any = `${context.sourceRevision}:${context.runtimeId}`;
  const dependenciesReady: any = orbText(machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -d "$3/node_modules" && printf ready`,
    "meshrix-dependencies-check",
    dependencyMarker,
    toolchainState,
    context.releaseDirectory,
  ], { allowFailure: true, timeout: 15_000 }) === "ready";
  assertInactiveReleaseMutation({
    activeWorkingDirectory: context.currentWorkingDirectory,
    releaseDirectory: context.releaseDirectory,
    ready: dependenciesReady,
  });
  if (!dependenciesReady) {
    runOrb({
      machine,
      args: [
        "sh",
        "-lc",
        "export PATH=\"$1:$PATH\"; cd \"$2\" && exec \"$3\" \"$4\" ci --no-audit --no-fund",
        "meshrix-dependencies",
        context.serviceNodeDirectory,
        context.releaseDirectory,
        context.serviceNode,
        context.serviceNpmCli,
      ],
      timeout: 1_200_000,
      code: "native_orb_dependency_install_failed",
    });
    writeRemoteFile(machine, dependencyMarker, `${toolchainState}\n`);
  }
  Object.assign(context, { toolchainState, dependenciesReady });
  return Object.freeze({ id: "dependencies", status: dependenciesReady ? "resumed" : "completed" });
}
