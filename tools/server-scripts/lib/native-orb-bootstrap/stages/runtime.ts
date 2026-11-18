import path from "node:path";
import {
  acquireAuthenticatedNodeRuntime,
  BOOTSTRAP_REQUIRED_PACKAGES,
  bootstrapOrbText,
  createPrivateBootstrapStagingDirectory,
} from "../support.ts";
import { runOrb } from "../../native-orb-deployment/support.ts";
import { failNativeOrbBootstrap } from "../contract.ts";

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const machine: any = context.parsed.machine;
  const runtime: any = await acquireAuthenticatedNodeRuntime(context.runtimeLock, context.targetId);
  const targetProvisioned: any = provisionBootstrapTarget(context);
  const translatedArchive: any = bootstrapOrbText(machine, ["readlink", "-f", runtime.archivePath], { translatePaths: true });
  const ready: any = bootstrapOrbText(machine, ["sh", "-lc",
    "test -d \"$1\" && test ! -L \"$1\" && test \"$(stat -c %a \"$1\")\" = 700 && test -f \"$2\" && test ! -L \"$2\" && test \"$(stat -c %a \"$2\")\" = 600 && test \"$(cat \"$2\")\" = \"$3\" && test -x \"$1/bin/node\" && printf ready",
    "meshrix-runtime-ready", context.layout.runtimeRoot, context.layout.runtimeMarkerPath, context.runtimeLock.version],
  { allowFailure: true }) === "ready";
  if (!ready) {
    const exists: any = runOrb({ machine, args: ["sh", "-lc", "test -e \"$1\" || test -L \"$1\"", "meshrix-runtime-exists", context.layout.runtimeRoot], allowFailure: true }).status === 0;
    if (exists) failNativeOrbBootstrap("native_orb_bootstrap_runtime_layout_unsafe", "Existing runtime layout is not safely resumable.");
    runOrb({ machine, args: ["install", "-d", "-m", "0700", path.posix.dirname(context.layout.runtimeRoot)] });
    const staging: any = createPrivateBootstrapStagingDirectory(
      machine,
      context.layout.runtimeRoot,
      context.sourceRevision,
    );
    runOrb({ machine, args: ["tar", "-xf", translatedArchive, "-C", staging, "--strip-components=1"], code: "native_orb_bootstrap_runtime_install_failed" });
    runOrb({ machine, args: ["chmod", "0700", staging], code: "native_orb_bootstrap_runtime_install_failed" });
    runOrb({
      machine,
      args: [path.posix.join(staging, "bin", "node"), "-e", "require('node:fs').writeFileSync(process.argv[1],process.argv[2]+'\\n',{flag:'wx',mode:0o600})", path.posix.join(staging, ".meshrix-runtime-ready"), context.runtimeLock.version],
      code: "native_orb_bootstrap_runtime_install_failed",
    });
    runOrb({
      machine,
      args: ["sh", "-lc", "mv -T -n \"$1\" \"$2\"; test ! -e \"$1\" && test ! -L \"$1\"", "meshrix-runtime-publish", staging, context.layout.runtimeRoot],
      code: "native_orb_bootstrap_runtime_layout_unsafe",
    });
  }
  const nodeExecutable: any = path.posix.join(context.layout.runtimeRoot, "bin", "node");
  const npmCli: any = path.posix.join(context.layout.runtimeRoot, "lib", "node_modules", "npm", "bin", "npm-cli.js");
  const proof: any = runOrb({ machine, args: [nodeExecutable, "-e", "process.exit(require('node:path').isAbsolute(process.execPath)&&process.versions.node===process.argv[1].replace(/^v/,'')?0:1)", context.runtimeLock.version], allowFailure: true }).status === 0;
  if (!proof) failNativeOrbBootstrap("native_orb_bootstrap_runtime_unavailable", "Installed Node runtime could not be verified.");
  Object.assign(context, { nodeExecutable, npmCli, runtimeId: context.runtimeLock.version });
  return Object.freeze({ id: "runtime", status: ready && !targetProvisioned ? "resumed" : "completed" });
}

function provisionBootstrapTarget(context?: any) : boolean {
  const machine: any = context.parsed.machine;
  let changed: any = false;
  runOrb({ machine, args: ["sudo", "-n", "true"], code: "native_orb_bootstrap_privilege_unavailable" });
  if (context.lingerEnabled !== true) {
    runOrb({
      machine,
      args: ["sudo", "-n", "loginctl", "enable-linger", context.username],
      code: "native_orb_bootstrap_linger_failed",
    });
    changed = true;
  }
  const linger: any = bootstrapOrbText(machine, ["loginctl", "show-user", context.username, "-p", "Linger", "--value"], {
    code: "native_orb_bootstrap_linger_failed",
  });
  if (linger !== "yes") {
    failNativeOrbBootstrap("native_orb_bootstrap_linger_failed", "Target user persistence could not be enabled.");
  }
  const missing: any[] = BOOTSTRAP_REQUIRED_PACKAGES.filter((packageName?: any) : any => (
    !bootstrapPackageInstalled(machine, packageName)
  ));
  if (missing.length > 0) {
    runOrb({
      machine,
      args: ["sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "update"],
      code: "native_orb_bootstrap_prerequisite_install_failed",
    });
    runOrb({
      machine,
      args: [
        "sudo", "-n", "env", "DEBIAN_FRONTEND=noninteractive", "apt-get", "install", "-y",
        "--no-install-recommends", ...BOOTSTRAP_REQUIRED_PACKAGES,
      ],
      code: "native_orb_bootstrap_prerequisite_install_failed",
    });
    changed = true;
  }
  const prerequisitesReady: any = BOOTSTRAP_REQUIRED_PACKAGES.every((packageName?: any) : any => (
    bootstrapPackageInstalled(machine, packageName)
  ));
  if (!prerequisitesReady) {
    failNativeOrbBootstrap("native_orb_bootstrap_prerequisite_install_failed", "Target build prerequisites are unavailable.");
  }
  context.lingerEnabled = true;
  return changed;
}

function bootstrapPackageInstalled(machine?: any, packageName?: any) : boolean {
  const result: any = runOrb({
    machine,
    args: ["dpkg-query", "-W", "-f=${db:Status-Abbrev}", packageName],
    allowFailure: true,
  });
  return result.status === 0 && String(result.stdout || "").trim() === "ii";
}
