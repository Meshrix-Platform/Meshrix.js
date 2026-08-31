import { failNativeOrbBootstrap } from "../contract.ts";
import { bootstrapOrbText, deriveBootstrapLayout } from "../support.ts";
import { runOrb } from "../../native-orb-deployment/support.ts";

export function parseBootstrapTargetFacts(value?: unknown) : any {
  const text: any = String(value || "");
  const facts: any[] = text.split("\n");
  if (facts.length !== 4 || /[\r\0]/u.test(text)) {
    failNativeOrbBootstrap("native_orb_bootstrap_target_unsupported", "Target facts are malformed.");
  }
  const [distribution, architecture, linger, home]: any = facts;
  if (!["ubuntu", "debian"].includes(distribution) || !["x86_64", "aarch64", "arm64"].includes(architecture) ||
      !["yes", "no"].includes(linger) || !/^\/[A-Za-z0-9._/-]+$/u.test(home || "") || home === "/") {
    failNativeOrbBootstrap("native_orb_bootstrap_target_unsupported", "Target must be Ubuntu or Debian x64/arm64 with a supported systemd user manager.");
  }
  return Object.freeze({ distribution, architecture, linger, home });
}

export function assertBootstrapUnitResumeState({
  existingBootstrapUnit,
  fixedState,
}: Record<string, any> = {}) : void {
  if (existingBootstrapUnit === true && fixedState !== "resumable") {
    failNativeOrbBootstrap(
      "native_orb_bootstrap_service_exists",
      "A pre-existing Meshrix service unit is not bootstrap resume state.",
    );
  }
}

export async function runNativeOrbBootstrapStage(context?: any) : Promise<any> {
  const machine: any = context.parsed.machine;
  const factsResult: any = runOrb({ machine, args: ["sh", "-lc", [
    ". /etc/os-release",
    "arch=$(uname -m)",
    "linger=$(loginctl show-user \"$USER\" -p Linger --value 2>/dev/null || true)",
    "systemctl --user show-environment >/dev/null 2>&1 || exit 20",
    "printf '%s\\n%s\\n%s\\n%s' \"$ID\" \"$arch\" \"$linger\" \"$HOME\"",
  ].join("; ")], timeout: 15_000, code: "native_orb_bootstrap_target_unsupported" });
  const { distribution, architecture, linger, home }: any = parseBootstrapTargetFacts(factsResult.stdout);
  const existingUnits: any = bootstrapOrbText(machine, ["sh", "-lc",
    "{ systemctl --user list-unit-files --type=service --no-legend; systemctl --user list-units --type=service --all --no-legend; } | awk 'tolower($1) ~ /meshrix/ {print $1}' | sort -u"],
  { timeout: 15_000, code: "native_orb_bootstrap_service_probe_failed" });
  const targetId: any = architecture === "x86_64" ? "linux-x64" : "linux-arm64";
  const layout: any = deriveBootstrapLayout(home, context.parsed.sourceRevision, "pending");
  const unitOnDisk: any = runOrb({
    machine,
    args: ["sh", "-lc", "test -e \"$1\" || test -L \"$1\"", "meshrix-bootstrap-unit", layout.unitPath],
    allowFailure: true,
    timeout: 15_000,
  }).status === 0;
  let existingBootstrapUnit: any = false;
  if (existingUnits || unitOnDisk) {
    if (existingUnits && existingUnits !== "meshrix-js.service") {
      failNativeOrbBootstrap("native_orb_bootstrap_service_exists", "A foreign Meshrix service unit already exists.");
    }
    const activeState: any = bootstrapOrbText(machine, ["systemctl", "--user", "is-active", "meshrix-js.service"], {
      allowFailure: true,
      timeout: 15_000,
    });
    const enabledState: any = bootstrapOrbText(machine, ["systemctl", "--user", "is-enabled", "meshrix-js.service"], {
      allowFailure: true,
      timeout: 15_000,
    });
    if (!["inactive", "failed", "unknown"].includes(activeState) || enabledState !== "disabled") {
      failNativeOrbBootstrap("native_orb_bootstrap_service_exists", "An active or enabled Meshrix service already exists.");
    }
    existingBootstrapUnit = true;
  }
  const layoutDirectories: any[] = directoryComponents(home, [
    layout.currentDirectory,
    layout.releasesDirectory,
    layout.configRoot,
    layout.secretRoot,
    layout.dataDirectory,
    pathParent(layout.runtimeRoot),
    pathParent(layout.unitPath),
  ]);
  const unsafeLink: any = runOrb({ machine, args: ["sh", "-lc", [
    "for p in \"$@\"; do",
    "  if test -L \"$p\" || { test -e \"$p\" && test ! -d \"$p\"; }; then exit 31; fi",
    "done",
  ].join("\n"), "meshrix-bootstrap-layout", ...layoutDirectories], allowFailure: true, timeout: 15_000 }).status !== 0;
  if (unsafeLink) failNativeOrbBootstrap("native_orb_bootstrap_layout_unsafe", "The fixed bootstrap layout contains a link.");
  const fixedState: any = bootstrapOrbText(machine, ["sh", "-lc", [
    "if test ! -e \"$1\" && test ! -e \"$4\" && test ! -e \"$5\" && test ! -e \"$6\"; then test ! -e \"$8\" || { test -d \"$8\" && test ! -L \"$8\" && test \"$(stat -c %a \"$8\")\" = 700; } || exit 40; printf clean; exit 0; fi",
    "test -d \"$1\" && test ! -L \"$1\" || exit 41",
    "test -f \"$2\" && test ! -L \"$2\" && test \"$(stat -c %a \"$2\")\" = 600 && test \"$(cat \"$2\")\" = \"$3\" || exit 42",
    "for p in \"$1\" \"$4\" \"$5\" \"$6\" \"$7\" \"$8\" \"$9\"; do test ! -e \"$p\" || { test -d \"$p\" && test ! -L \"$p\" && test \"$(stat -c %a \"$p\")\" = 700; } || exit 43; done",
    "printf resumable",
  ].join("\n"), "meshrix-bootstrap-fixed-state", layout.fixedRoot, layout.sourceMarkerPath, context.parsed.sourceRevision, layout.configRoot, layout.secretRoot, layout.dataDirectory, layout.releasesDirectory, pathParent(layout.runtimeRoot), layout.currentDirectory], { allowFailure: true, timeout: 15_000 });
  if (!["clean", "resumable"].includes(fixedState)) {
    failNativeOrbBootstrap("native_orb_bootstrap_layout_unsafe", "The fixed bootstrap layout is foreign or not safely resumable.");
  }
  assertBootstrapUnitResumeState({ existingBootstrapUnit, fixedState });
  const username: any = bootstrapOrbText(machine, ["id", "-un"], { timeout: 15_000 });
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/u.test(username)) {
    failNativeOrbBootstrap("native_orb_bootstrap_target_unsupported", "Target user identity is unsupported.");
  }
  Object.assign(context, {
    distribution,
    architecture,
    targetId,
    home,
    username,
    lingerEnabled: linger === "yes",
    existingBootstrapUnit,
  });
  return Object.freeze({
    id: "target",
    status: fixedState === "resumable" || existingBootstrapUnit ? "resumed" : "completed",
  });
}

function pathParent(value?: unknown) : string {
  return String(value || "").split("/").slice(0, -1).join("/") || "/";
}

function directoryComponents(home?: unknown, targets: unknown[] = []) : string[] {
  const root: any = String(home || "");
  const paths: any = new Set<string>([root]);
  for (const value of targets) {
    const target: any = String(value || "");
    if (target !== root && !target.startsWith(`${root}/`)) {
      failNativeOrbBootstrap("native_orb_bootstrap_layout_unsafe", "The fixed bootstrap layout escapes its home.");
    }
    let current: any = root;
    for (const segment of target.slice(root.length).split("/").filter(Boolean)) {
      current = `${current}/${segment}`;
      paths.add(current);
    }
  }
  return [...paths];
}
