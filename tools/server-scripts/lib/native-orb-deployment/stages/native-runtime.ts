import { failNativeOrbDeployment } from "../contract.ts";
import { runOrb } from "../support.ts";

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const nativeRuntimeReady: any = runOrb({
    machine: context.parsed.machine,
    args: [
      "sh",
      "-lc",
      "export PATH=\"$1:$PATH\"; cd \"$2\" && exec \"$3\" -e 'const D=require(\"better-sqlite3\");const db=new D(\":memory:\");db.close()'",
      "meshrix-native-runtime",
      context.serviceNodeDirectory,
      context.releaseDirectory,
      context.serviceNode,
    ],
    allowFailure: true,
  }).status === 0;
  if (!nativeRuntimeReady) {
    failNativeOrbDeployment("native_orb_native_runtime_incompatible", "Native dependencies do not match the service Node.js runtime.");
  }
  return Object.freeze({ id: "native-runtime", status: "completed" });
}
