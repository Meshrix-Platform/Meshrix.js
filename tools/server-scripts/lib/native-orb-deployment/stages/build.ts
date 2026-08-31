import path from "node:path";

import { assertInactiveReleaseMutation, orbText, runOrb, writeRemoteFile } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine } = context.parsed;
  const buildMarker: any = path.posix.join(context.releaseDirectory, ".meshrix-build-ready");
  const buildReady: any = context.dependenciesReady && orbText(machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -f "$3/build/dist/index.html" && printf ready`,
    "meshrix-build-check",
    buildMarker,
    context.toolchainState,
    context.releaseDirectory,
  ], { allowFailure: true, timeout: 15_000 }) === "ready";
  assertInactiveReleaseMutation({
    activeWorkingDirectory: context.currentWorkingDirectory,
    releaseDirectory: context.releaseDirectory,
    ready: buildReady,
  });
  if (!buildReady) {
    runOrb({
      machine,
      args: [
        "sh",
        "-lc",
        "export PATH=\"$1:$PATH\"; cd \"$2\" && exec \"$3\" \"$4\" run build",
        "meshrix-build",
        context.serviceNodeDirectory,
        context.releaseDirectory,
        context.serviceNode,
        context.serviceNpmCli,
      ],
      timeout: 1_200_000,
      code: "native_orb_build_failed",
    });
    writeRemoteFile(machine, buildMarker, `${context.toolchainState}\n`);
  }
  return Object.freeze({ id: "build", status: buildReady ? "resumed" : "completed" });
}
