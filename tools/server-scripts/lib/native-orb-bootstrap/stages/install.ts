import path from "node:path";
import { bootstrapOrbText, createPrivateBootstrapStagingDirectory } from "../support.ts";
import { runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const machine: any = context.parsed.machine;
  const translatedArchive: any = bootstrapOrbText(machine, ["readlink", "-f", context.archive.archivePath], { translatePaths: true });
  const ready: any = bootstrapOrbText(machine, ["sh", "-lc",
    "test -d \"$1\" && test ! -L \"$1\" && test \"$(stat -c %a \"$1\")\" = 700 && test -f \"$2\" && test ! -L \"$2\" && test \"$(stat -c %a \"$2\")\" = 600 && test \"$(cat \"$2\")\" = \"$3\" && test -f \"$1/package.json\" && printf ready",
    "meshrix-source-ready", context.layout.currentDirectory, context.layout.sourceMarkerPath, context.sourceRevision],
  { allowFailure: true }) === "ready";
  if (!ready) {
    const exists: any = runOrb({ machine, args: ["sh", "-lc", "test -e \"$1\" || test -L \"$1\"", "meshrix-source-exists", context.layout.currentDirectory], allowFailure: true }).status === 0;
    if (exists) failNativeOrbBootstrap("native_orb_bootstrap_source_layout_unsafe", "Existing source layout is not safely resumable.");
    runOrb({ machine, args: ["install", "-d", "-m", "0700", context.layout.fixedRoot, context.layout.releasesDirectory] });
    const staging: any = createPrivateBootstrapStagingDirectory(
      machine,
      context.layout.currentDirectory,
      context.sourceRevision,
    );
    runOrb({ machine, args: ["tar", "-xf", translatedArchive, "-C", staging], code: "native_orb_bootstrap_source_install_failed" });
    runOrb({ machine, args: ["chmod", "0700", staging], code: "native_orb_bootstrap_source_install_failed" });
    runOrb({
      machine,
      args: [context.nodeExecutable, "-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2]+'\\n',{flag:'wx',mode:0o600})", path.posix.join(staging, ".meshrix-source-revision"), context.sourceRevision],
      code: "native_orb_bootstrap_source_install_failed",
    });
    runOrb({
      machine,
      args: ["sh", "-lc", "mv -T -n \"$1\" \"$2\"; test ! -e \"$1\" && test ! -L \"$1\"", "meshrix-source-publish", staging, context.layout.currentDirectory],
      code: "native_orb_bootstrap_source_layout_unsafe",
    });
  }
  const packageValid: any = runOrb({ machine, args: [context.nodeExecutable, "-e", "const p=require(process.argv[1]);process.exit(p.name==='meshrix.js'?0:1)", path.posix.join(context.layout.currentDirectory, "package.json")], allowFailure: true }).status === 0;
  if (!packageValid) failNativeOrbBootstrap("native_orb_bootstrap_source_invalid", "Installed candidate source is invalid.");
  return Object.freeze({ id: "install", status: ready ? "resumed" : "completed" });
}
