import path from "node:path";

import { failNativeOrbDeployment } from "../contract.ts";
import { orbText, resolveServiceNodeExecutable, runOrb } from "../support.ts";

const UNIT_PATTERN: any = /^[a-zA-Z0-9_.@-]+\.service$/u;
const RUNTIME_ID_PATTERN: any = /^\d+\.\d+\.\d+:\d+$/u;

export function assertExistingServiceActive(state?: any) : void {
  if (String(state || "").trim() !== "active") {
    failNativeOrbDeployment(
      "native_orb_existing_service_inactive",
      "Existing native Meshrix.js service must be active before an upgrade.",
    );
  }
}

export async function runNativeOrbDeploymentStage(context?: any) : Promise<any> {
  const { machine } = context.parsed;
  const distribution: any = orbText(machine, [
    "sh",
    "-lc",
    ". /etc/os-release; printf %s \"$ID\"",
  ], { timeout: 15_000 });
  if (!["ubuntu", "debian"].includes(distribution)) {
    failNativeOrbDeployment("native_orb_distribution_unsupported", "Target VM must use Ubuntu or Debian.");
  }
  const unit: any = orbText(machine, [
    "sh",
    "-lc",
    "systemctl --user list-unit-files --type=service --no-legend | awk 'tolower($1) ~ /meshrix/ {print $1; exit}'",
  ], { timeout: 15_000 });
  if (!UNIT_PATTERN.test(unit)) {
    failNativeOrbDeployment("native_orb_service_missing", "Existing native Meshrix.js service is unavailable.");
  }
  assertExistingServiceActive(orbText(machine, [
    "systemctl", "--user", "is-active", unit,
  ], { allowFailure: true, timeout: 15_000 }));
  const currentWorkingDirectory: any = orbText(machine, [
    "systemctl", "--user", "show", unit, "-p", "WorkingDirectory", "--value",
  ], { timeout: 15_000 });
  const fragmentPath: any = orbText(machine, [
    "systemctl", "--user", "show", unit, "-p", "FragmentPath", "--value",
  ], { timeout: 15_000 });
  const originalWorkingDirectory: any = orbText(machine, [
    "sh",
    "-lc",
    [
      "raw=$(sed -n 's/^WorkingDirectory=//p' \"$1\" | tail -n 1)",
      "case \"$raw\" in %h/*) suffix=${raw#%h/}; printf %s \"$HOME/$suffix\";; /*) printf %s \"$raw\";; esac",
    ].join("; "),
    "meshrix-original-working-directory",
    fragmentPath,
  ], { timeout: 15_000 });
  const currentExecStart: any = orbText(machine, [
    "systemctl", "--user", "show", unit, "-p", "ExecStart", "--value",
  ], { timeout: 15_000 });
  const serviceNode: any = resolveServiceNodeExecutable(currentExecStart);
  const serviceNodeDirectory: any = path.posix.dirname(serviceNode);
  const serviceNpmCli: any = orbText(machine, [
    "sh",
    "-lc",
    [
      "prefix=$(dirname \"$(dirname \"$1\")\")",
      "for candidate in \"$prefix/lib/node_modules/npm/bin/npm-cli.js\" /usr/share/nodejs/npm/bin/npm-cli.js; do",
      "  if test -f \"$candidate\"; then readlink -f \"$candidate\"; exit 0; fi",
      "done",
      "exit 1",
    ].join("\n"),
    "meshrix-service-npm",
    serviceNode,
  ], { timeout: 15_000, code: "native_orb_node_unavailable" });
  const nodeReady: any = runOrb({
    machine,
    args: [
      serviceNode,
      "-e",
      "const [major,minor]=process.versions.node.split('.').map(Number);process.exit((major===22&&minor>=18)||(major===24&&minor>=3)||major>24?0:1)",
    ],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  const npmReady: any = runOrb({
    machine,
    args: [serviceNode, serviceNpmCli, "--version"],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  const runtimeId: any = orbText(machine, [
    serviceNode,
    "-p",
    "process.versions.node+':'+process.versions.modules",
  ], { timeout: 15_000, code: "native_orb_node_unavailable" });
  if (!nodeReady || !npmReady || !RUNTIME_ID_PATTERN.test(runtimeId)) {
    failNativeOrbDeployment("native_orb_node_unavailable", "The service Node.js toolchain is unavailable or unsupported.");
  }

  const releaseParent: any = path.posix.join(path.posix.dirname(originalWorkingDirectory), "releases");
  const dropInDirectory: any = orbText(machine, [
    "sh", "-lc", "printf %s \"$HOME/.config/systemd/user/$1.d\"", "meshrix-drop-in", unit,
  ], { timeout: 15_000 });
  if (
    !originalWorkingDirectory
    || originalWorkingDirectory === "/"
    || originalWorkingDirectory === path.posix.dirname(originalWorkingDirectory)
    || currentExecStart.includes(currentWorkingDirectory)
    || (
      currentWorkingDirectory !== originalWorkingDirectory
      && !currentWorkingDirectory.startsWith(`${releaseParent}/`)
    )
  ) {
    failNativeOrbDeployment("native_orb_service_layout_unsupported", "Native service must use a working-directory-relative command.");
  }
  if (!/--with-ui|start:console|start-all/u.test(currentExecStart)) {
    failNativeOrbDeployment("native_orb_console_mode_required", "Native service must serve the Web Console.");
  }
  const existingProgramValid: any = runOrb({
    machine,
    args: [
      serviceNode,
      "-e",
      "const p=require(process.argv[1]);process.exit(p.name==='meshrix.js'?0:1)",
      path.posix.join(originalWorkingDirectory, "package.json"),
    ],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  if (!existingProgramValid) {
    failNativeOrbDeployment("native_orb_previous_program_unverified", "Previous program directory is not a verified Meshrix.js source tree.");
  }

  Object.assign(context, {
    existingServiceActiveBeforeUpgrade: true,
    unit,
    currentWorkingDirectory,
    originalWorkingDirectory,
    currentExecStart,
    serviceNode,
    serviceNodeDirectory,
    serviceNpmCli,
    runtimeId,
    releaseParent,
    dropInDirectory,
  });
  return Object.freeze({ id: "runtime", status: "resumed" });
}
