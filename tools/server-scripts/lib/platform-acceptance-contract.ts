export const PLATFORM_ACCEPTANCE_PARALLELISM: any = 4;
export const PLATFORM_ACCEPTANCE_REPORT_SCHEMA: any = "v0.0.1:acceptance:platform-report-4";
export const PLATFORM_ACCEPTANCE_PROFILES: Readonly<Record<string, any>> = Object.freeze({
  "enterprise-single-node": Object.freeze({ id: "enterprise-single-node" }),
});

export function requirePlatformAcceptanceProfile(value?: any) : any {
  const selectedProfile: any = String(value || "").trim();
  if (!selectedProfile) throw new Error("Platform acceptance requires --profile.");
  if (!Object.hasOwn(PLATFORM_ACCEPTANCE_PROFILES, selectedProfile)) {
    throw new Error(`Unknown platform acceptance profile: ${selectedProfile}`);
  }
  return selectedProfile;
}
export const PLATFORM_ACCEPTANCE_STATE_MACHINE: Readonly<Record<string, any>> = Object.freeze({
  schemaVersion: "v0.0.1:state-machine:platform-acceptance-1",
  id: "meshrix-js-platform-acceptance",
  initialState: "initialized",
  terminalStates: ["accepted", "failed"],
  states: [
    "initialized",
    "planned",
    "running_parallel_acceptance_layers",
    "reducing_evidence",
    "accepted",
    "failed"
  ],
  transitions: [
    { from: "initialized", event: "build_plan", to: "planned" },
    { from: "planned", event: "start", to: "running_parallel_acceptance_layers" },
    { from: "running_parallel_acceptance_layers", event: "all_runnable_commands_finished", to: "reducing_evidence" },
    { from: "reducing_evidence", event: "all_acceptance_criteria_ready", to: "accepted" },
    { from: "reducing_evidence", event: "missing_required_core_evidence", to: "failed" },
    { from: "reducing_evidence", event: "command_or_report_failed", to: "failed" }
  ],
  parallelRegions: [
    "foundation",
    "downstream-gateway",
    "upstream-gateway",
    "platform-capability",
    "profile",
    "final-regression"
  ]
});

export function npmCommand() : any {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function commandExecutable(command?: any) : any {
  if (command === "node") return process.execPath;
  if (command === "npm") return npmCommand();
  return command;
}

export function commandLine(command: Record<string, any> = {}) : any {
  return [command.command, ...(command.args || [])].join(" ");
}

export function normalizedParallelism(env: any = process.env) : any {
  const configured: any = Number(env.MESHRIX_ACCEPTANCE_PARALLELISM || env.MESHRIX_RELEASE_PARALLELISM || "");
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.trunc(configured));
  }
  return PLATFORM_ACCEPTANCE_PARALLELISM;
}

export function parsePlatformAcceptanceArgs(argv: any = []) : any {
  let planOnly: any = false;
  let selectedProfile: any = "";
  for (let index: any = 0; index < argv.length; index += 1) {
    const argument: any = argv[index];
    if (argument === "--plan") {
      if (planOnly) throw new Error("Platform acceptance --plan was provided more than once.");
      planOnly = true;
      continue;
    }
    if (argument === "--profile") {
      if (selectedProfile) throw new Error("Platform acceptance --profile was provided more than once.");
      selectedProfile = String(argv[index + 1] || "").trim();
      index += 1;
      continue;
    }
    throw new Error(`Unknown platform acceptance argument: ${argument}`);
  }
  return { planOnly, selectedProfile: requirePlatformAcceptanceProfile(selectedProfile) };
}

export function nodeCommand(args?: any) : any {
  return { command: "node", args };
}

export function npmRun(script?: any) : any {
  return { command: "npm", args: ["run", script] };
}

export function npmTest() : any {
  return { command: "npm", args: ["test"] };
}

export function acceptanceCommand(id?: any, label?: any, layer?: any, commandSpec?: any, report?: any, covers: any = [], options: Record<string, any> = {}) : any {
  const ownedReports: any[] = [...new Set<any>([
    report,
    ...(options.ownedReports || [])
  ].filter(Boolean))];
  return Object.freeze({
    id,
    label,
    command: commandSpec.command,
    args: commandSpec.args,
    report,
    covers,
    acceptanceLayer: layer,
    layer: `acceptance.${layer}`,
    parallelGroup: `acceptance.${layer}`,
    dependsOn: Object.freeze(options.dependsOn || []),
    resourceLocks: Object.freeze([
      ...ownedReports.map((reportPath?: any) : any => `report:${reportPath}`),
      ...(options.resourceLocks || [])
    ].filter(Boolean)),
    ownedReports: Object.freeze(ownedReports),
    blockedExitCodes: Object.freeze(options.blockedExitCodes || []),
    exclusive: options.exclusive === true
  });
}
