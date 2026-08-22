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
  writeRemoteFile(
    machine,
    path.posix.join(context.dropInDirectory, "20-native-orb-origin.conf"),
    [
      "[Service]",
      `Environment=\"MESHRIX_BOOTSTRAP_URL=${publicOrigin}\"`,
      `Environment=\"MESHRIX_ADVERTISED_BASE_URL=${publicOrigin}\"`,
      `Environment=\"MESHRIX_ACTIVE_SERVICE_URL=${publicOrigin}\"`,
      "",
    ].join("\n"),
  );
  return Object.freeze({ id: "configure", status: "completed" });
}
