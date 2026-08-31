import path from "node:path";
import { bootstrapOrbText } from "../support.ts";
import { runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const marker: any = path.posix.join(context.layout.currentDirectory, ".meshrix-dependencies-ready");
  const state: any = `${context.sourceRevision}:${context.runtimeId}`;
  const ready: any = bootstrapOrbText(context.parsed.machine, ["sh", "-lc",
    "test -f \"$1\" && test ! -L \"$1\" && test \"$(stat -c %a \"$1\")\" = 600 && test \"$(cat \"$1\")\" = \"$2\" && test -d \"$3/node_modules\" && printf ready",
    "meshrix-dependencies-ready", marker, state, context.layout.currentDirectory], { allowFailure: true }) === "ready";
  if (!ready) {
    const unsafeMarker: any = runOrb({
      machine: context.parsed.machine,
      args: ["sh", "-lc", "test -L \"$1\" || { test -e \"$1\" && { test ! -f \"$1\" || test \"$(stat -c %a \"$1\")\" != 600; }; }", "meshrix-dependency-marker", marker],
      allowFailure: true,
    }).status === 0;
    if (unsafeMarker) {
      failNativeOrbBootstrap("native_orb_bootstrap_dependency_marker_unsafe", "Dependency marker is unsafe.");
    }
    runOrb({ machine: context.parsed.machine, args: ["sh", "-lc",
      "cd \"$1\" && exec \"$2\" \"$3\" ci --no-audit --no-fund",
      "meshrix-bootstrap-dependencies", context.layout.currentDirectory, context.nodeExecutable, context.npmCli],
    code: "native_orb_bootstrap_dependencies_failed" });
    runOrb({ machine: context.parsed.machine, args: ["sh", "-lc", "umask 077; printf '%s\\n' \"$2\" > \"$1\"", "meshrix-dependency-marker", marker, state] });
  }
  context.toolchainState = state;
  return Object.freeze({ id: "dependencies", status: ready ? "resumed" : "completed" });
}
