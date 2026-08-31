import path from "node:path";

import { runOrb, writeRemoteFile } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine, publicOrigin } = context.parsed;
  runOrb({
    machine,
    args: ["install", "-d", "-m", "0700", context.dropInDirectory],
    timeout: 30_000,
    code: "native_orb_service_write_failed",
  });
  const dropInPath: any = path.posix.join(context.dropInDirectory, "30-native-orb-candidate.conf");
  const backupPath: any = `${dropInPath}.previous`;
  const previousDropInPresent: any = runOrb({
    machine,
    args: ["sh", "-lc", "if test -f \"$1\"; then cp -p \"$1\" \"$2\"; exit 0; else rm -f \"$2\"; exit 3; fi", "meshrix-candidate-backup", dropInPath, backupPath],
    allowFailure: true,
    timeout: 30_000,
  }).status === 0;
  const temporaryPath: any = `${dropInPath}.${context.sourceRevision}.tmp`;
  writeRemoteFile(
    machine,
    temporaryPath,
    [
      "[Service]",
      `WorkingDirectory=${context.releaseDirectory}`,
      `Environment=\"MESHRIX_BOOTSTRAP_URL=${publicOrigin}\"`,
      `Environment=\"MESHRIX_ADVERTISED_BASE_URL=${publicOrigin}\"`,
      `Environment=\"MESHRIX_ACTIVE_SERVICE_URL=${publicOrigin}\"`,
      "",
    ].join("\n"),
  );
  runOrb({
    machine,
    args: ["mv", temporaryPath, dropInPath],
    timeout: 30_000,
    code: "native_orb_service_write_failed",
  });
  Object.assign(context, { dropInPath, backupPath, previousDropInPresent });
  return Object.freeze({ id: "configure", status: "completed" });
}
