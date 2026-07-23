export const PLATFORM_ACCEPTANCE_DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
export const PLATFORM_ACCEPTANCE_PARALLELISM = 4;
export const PLATFORM_ACCEPTANCE_PROFILES = Object.freeze({
  core: Object.freeze({ id: "core" })
});

export function requirePlatformAcceptanceProfile(value) {
  const selectedProfile = String(value || "").trim();
  if (!selectedProfile) throw new Error("Platform acceptance requires --profile.");
  if (!Object.hasOwn(PLATFORM_ACCEPTANCE_PROFILES, selectedProfile)) {
    throw new Error(`Unknown platform acceptance profile: ${selectedProfile}`);
  }
  return selectedProfile;
}
export const PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS = 15 * 60 * 1000;
export const PLATFORM_ACCEPTANCE_MINIMUM_JOB_BUDGET_MS = 395 * 60 * 1000;
const PLATFORM_ACCEPTANCE_JOB_BUDGET_QUANTUM_MS = 5 * 60 * 1000;

export function platformAcceptanceJobBudget(worstCaseTimeoutMs) {
  return Math.max(
    PLATFORM_ACCEPTANCE_MINIMUM_JOB_BUDGET_MS,
    Math.ceil(
      (worstCaseTimeoutMs + PLATFORM_ACCEPTANCE_JOB_OVERHEAD_MS) /
        PLATFORM_ACCEPTANCE_JOB_BUDGET_QUANTUM_MS
    ) * PLATFORM_ACCEPTANCE_JOB_BUDGET_QUANTUM_MS
  );
}

export const PLATFORM_ACCEPTANCE_STATE_MACHINE = Object.freeze({
  schemaVersion: "v0.0.1:state-machine:platform-acceptance-1",
  id: "licomesh-platform-acceptance",
  initialState: "initialized",
  terminalStates: ["accepted", "blocked", "failed"],
  states: [
    "initialized",
    "planned",
    "running_parallel_acceptance_layers",
    "reducing_evidence",
    "accepted",
    "blocked",
    "failed"
  ],
  transitions: [
    { from: "initialized", event: "build_plan", to: "planned" },
    { from: "planned", event: "start", to: "running_parallel_acceptance_layers" },
    { from: "running_parallel_acceptance_layers", event: "all_runnable_commands_finished", to: "reducing_evidence" },
    { from: "reducing_evidence", event: "all_acceptance_criteria_ready", to: "accepted" },
    { from: "reducing_evidence", event: "missing_required_core_evidence", to: "blocked" },
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

export function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function commandExecutable(command) {
  if (command === "node") return process.execPath;
  if (command === "npm") return npmCommand();
  return command;
}

export function commandLine(command = {}) {
  return [command.command, ...(command.args || [])].join(" ");
}

export function normalizedParallelism(env = process.env) {
  const configured = Number(env.LICO_ACCEPTANCE_PARALLELISM || env.LICO_RELEASE_PARALLELISM || "");
  if (Number.isFinite(configured) && configured > 0) {
    return Math.max(1, Math.trunc(configured));
  }
  return PLATFORM_ACCEPTANCE_PARALLELISM;
}

export function parsePlatformAcceptanceArgs(argv = []) {
  let planOnly = false;
  let selectedProfile = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
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

export function nodeCommand(args) {
  return { command: "node", args };
}

export function npmRun(script) {
  return { command: "npm", args: ["run", script] };
}

export function npmTest() {
  return { command: "npm", args: ["test"] };
}

export function acceptanceCommand(id, label, layer, commandSpec, report, covers = [], options = {}) {
  const ownedReports = [...new Set([
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
      ...ownedReports.map((reportPath) => `report:${reportPath}`),
      ...(options.resourceLocks || [])
    ].filter(Boolean)),
    ownedReports: Object.freeze(ownedReports),
    blockedExitCodes: Object.freeze(options.blockedExitCodes || []),
    exclusive: options.exclusive === true,
    timeoutMs: options.timeoutMs
  });
}
