const MACHINE_PATTERN: any = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;
const REVISION_PATTERN: any = /^[a-f0-9]{40}$/u;

export function failNativeOrbBootstrap(code?: unknown, message?: unknown) : never {
  const error: Error & Record<string, any> = new Error(String(message || code));
  error.code = String(code || "native_orb_bootstrap_failed");
  throw error;
}

export function parseNativeOrbBootstrapArgs(argv?: unknown) : any {
  const values: any[] = Array.isArray(argv) ? argv.map(String) : [];
  const parsed: Record<string, string> = {};
  const names: any = new Set(["--machine", "--origin", "--candidate", "--login-input"]);
  for (let index: any = 0; index < values.length; index += 2) {
    const name: any = values[index];
    const value: any = values[index + 1];
    if (!names.has(name) || !value || value.startsWith("--") || parsed[name]) {
      failNativeOrbBootstrap("native_orb_bootstrap_argument_invalid", "Use exactly --machine, --origin, --candidate, and --login-input.");
    }
    parsed[name] = value;
  }
  if (Object.keys(parsed).length !== 4 || !MACHINE_PATTERN.test(parsed["--machine"] || "")) {
    failNativeOrbBootstrap("native_orb_bootstrap_machine_invalid", "An OrbStack machine is required.");
  }
  let origin: URL;
  try {
    origin = new URL(parsed["--origin"] || "");
  } catch {
    failNativeOrbBootstrap("native_orb_bootstrap_origin_invalid", "A complete public origin is required.");
  }
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash || origin.port !== "7228") {
    failNativeOrbBootstrap("native_orb_bootstrap_origin_invalid", "The public origin must use port 7228 without credentials or a path.");
  }
  const sourceRevision: any = String(parsed["--candidate"] || "").trim();
  if (!REVISION_PATTERN.test(sourceRevision)) {
    failNativeOrbBootstrap("native_orb_bootstrap_candidate_invalid", "An explicit accepted candidate commit is required.");
  }
  const loginInput: any = String(parsed["--login-input"] || "").trim();
  if (!loginInput || /[\r\n\0]/u.test(loginInput)) {
    failNativeOrbBootstrap("native_orb_bootstrap_login_input_invalid", "A private login input file is required.");
  }
  return Object.freeze({
    machine: parsed["--machine"],
    publicOrigin: origin.origin,
    sourceRevision,
    loginInput,
  });
}
