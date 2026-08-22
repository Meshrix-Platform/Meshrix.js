import path from "node:path";

import { orbText, runOrb, writeRemoteFile } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine } = context.parsed;
  const translatedArchive: any = orbText(machine, ["readlink", "-f", context.archive.archivePath], {
    translatePaths: true,
    timeout: 15_000,
  });
  const markerPath: any = path.posix.join(context.originalWorkingDirectory, ".meshrix-source-revision");
  const sourceReady: any = orbText(machine, [
    "sh",
    "-lc",
    `test -f "$1" && test "$(cat "$1")" = "$2" && test -f "$3/package.json" && printf ready`,
    "meshrix-release-check",
    markerPath,
    context.sourceRevision,
    context.originalWorkingDirectory,
  ], { allowFailure: true, timeout: 15_000 }) === "ready";
  if (!sourceReady) {
    runOrb({
      machine,
      args: ["systemctl", "--user", "stop", context.unit],
      timeout: 120_000,
      code: "native_orb_previous_service_stop_failed",
    });
    runOrb({
      machine,
      args: ["rm", "-rf", context.originalWorkingDirectory, context.releaseParent],
      timeout: 60_000,
      code: "native_orb_release_prepare_failed",
    });
    runOrb({
      machine,
      args: ["install", "-d", "-m", "0700", context.originalWorkingDirectory],
      timeout: 30_000,
      code: "native_orb_release_prepare_failed",
    });
    runOrb({
      machine,
      args: ["tar", "-xf", translatedArchive, "-C", context.originalWorkingDirectory],
      timeout: 120_000,
      code: "native_orb_transfer_failed",
    });
    writeRemoteFile(machine, markerPath, `${context.sourceRevision}\n`);
  }
  return Object.freeze({ id: "transfer", status: sourceReady ? "resumed" : "completed" });
}
