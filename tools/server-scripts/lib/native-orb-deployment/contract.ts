const MACHINE_PATTERN: any = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/u;

export function failNativeOrbDeployment(code?: any, message?: any) : never {
  const error: Error & Record<string, any> = new Error(String(message || code));
  error.code = code;
  throw error;
}

export function parseNativeOrbDeploymentArgs(argv?: any) : any {
  const args: any[] = Array.isArray(argv) ? argv.map(String) : [];
  let machine: any = "";
  let publicOrigin: any = "";
  for (let indexValue: any = 0; indexValue < args.length; indexValue += 1) {
    const argument: any = args[indexValue];
    if (argument === "--machine") {
      machine = String(args[indexValue + 1] || "");
      indexValue += 1;
      continue;
    }
    if (argument === "--origin") {
      publicOrigin = String(args[indexValue + 1] || "");
      indexValue += 1;
      continue;
    }
    failNativeOrbDeployment("native_orb_argument_unknown", "Use --machine and --origin.");
  }
  if (!MACHINE_PATTERN.test(machine)) {
    failNativeOrbDeployment("native_orb_machine_invalid", "OrbStack machine is required.");
  }
  let origin: any;
  try {
    origin = new URL(publicOrigin);
  } catch {
    failNativeOrbDeployment("native_orb_origin_invalid", "A complete public origin is required.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol)
    || origin.username
    || origin.password
    || origin.pathname !== "/"
    || origin.search
    || origin.hash
    || origin.port !== "7228"
  ) {
    failNativeOrbDeployment("native_orb_origin_invalid", "The public origin must use port 7228 without credentials or a path.");
  }
  return Object.freeze({ machine, publicOrigin: origin.origin });
}
