import path from "node:path";
import { bootstrapOrbText } from "../support.ts";
import { runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const marker: any = path.posix.join(context.layout.currentDirectory, ".meshrix-build-ready");
  const ready: any = bootstrapOrbText(context.parsed.machine, ["sh", "-lc",
    "test -f \"$1\" && test ! -L \"$1\" && test \"$(stat -c %a \"$1\")\" = 600 && test \"$(cat \"$1\")\" = \"$2\" && test -f \"$3/build/dist/index.html\" && printf ready",
    "meshrix-build-ready", marker, context.toolchainState, context.layout.currentDirectory], { allowFailure: true, timeout: 15_000 }) === "ready";
  if (!ready) {
    const unsafeMarker: any = runOrb({
      machine: context.parsed.machine,
      args: ["sh", "-lc", "test -L \"$1\" || { test -e \"$1\" && { test ! -f \"$1\" || test \"$(stat -c %a \"$1\")\" != 600; }; }", "meshrix-build-marker", marker],
      allowFailure: true,
      timeout: 15_000,
    }).status === 0;
    if (unsafeMarker) {
      failNativeOrbBootstrap("native_orb_bootstrap_build_marker_unsafe", "Build marker is unsafe.");
    }
    runOrb({ machine: context.parsed.machine, args: ["sh", "-lc", "cd \"$1\" && exec \"$2\" \"$3\" run build", "meshrix-bootstrap-build", context.layout.currentDirectory, context.nodeExecutable, context.npmCli], timeout: 1_200_000, code: "native_orb_bootstrap_build_failed" });
    runOrb({ machine: context.parsed.machine, args: ["sh", "-lc", "umask 077; printf '%s\\n' \"$2\" > \"$1\"", "meshrix-build-marker", marker, context.toolchainState], timeout: 30_000 });
  }
  const nativeReady: any = runOrb({ machine: context.parsed.machine, args: ["sh", "-lc", "cd \"$1\" && exec \"$2\" -e 'const D=require(\"better-sqlite3\");const db=new D(\":memory:\");db.close()'", "meshrix-native-proof", context.layout.currentDirectory, context.nodeExecutable], allowFailure: true, timeout: 15_000 }).status === 0;
  if (!nativeReady) failNativeOrbBootstrap("native_orb_bootstrap_native_runtime_incompatible", "Native dependencies do not match the installed Node runtime.");
  return Object.freeze({ id: "build", status: ready ? "resumed" : "completed" });
}
