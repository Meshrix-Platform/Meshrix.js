import path from "node:path";

import { assertInactiveReleaseMutation, orbText, runOrb, writeRemoteFile } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine } = context.parsed;
  const translatedArchive: any = orbText(machine, ["readlink", "-f", context.archive.archivePath], {
    translatePaths: true,
  });
  const releaseDirectory: any = path.posix.join(context.releaseParent, context.sourceRevision);
  const markerPath: any = path.posix.join(releaseDirectory, ".meshrix-source-revision");
  const sourceReady: any = orbText(machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -f "$3/package.json" && printf ready`,
    "meshrix-release-check",
    markerPath,
    context.sourceRevision,
    releaseDirectory,
  ], { allowFailure: true }) === "ready";
  assertInactiveReleaseMutation({
    activeWorkingDirectory: context.currentWorkingDirectory,
    releaseDirectory,
    ready: sourceReady,
  });
  if (!sourceReady) {
    runOrb({
      machine,
      args: ["rm", "-rf", releaseDirectory],
      code: "native_orb_release_prepare_failed",
    });
    runOrb({
      machine,
      args: ["install", "-d", "-m", "0700", releaseDirectory],
      code: "native_orb_release_prepare_failed",
    });
    runOrb({
      machine,
      args: ["tar", "-xf", translatedArchive, "-C", releaseDirectory],
      code: "native_orb_transfer_failed",
    });
    writeRemoteFile(machine, markerPath, `${context.sourceRevision}\n`);
  }
  context.releaseDirectory = releaseDirectory;
  return Object.freeze({ id: "transfer", status: sourceReady ? "resumed" : "completed" });
}
