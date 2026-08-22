function argumentError(code: string) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

function argumentValue(argv: readonly string[], index: number, name: string) : any {
  const value: any = String(argv[index + 1] || "").trim();
  if (!value || value.startsWith("--")) throw argumentError(`optional_startup_${name}_missing`);
  return value;
}

function parseEnvironmentBinding(value: string) : any {
  const separator: any = value.indexOf("=");
  const targetId: any = value.slice(0, separator).trim();
  const filePath: any = value.slice(separator + 1).trim();
  if (separator < 1 || !targetId || !filePath) throw argumentError("optional_startup_env_file_invalid");
  return { targetId, filePath };
}

export function parseOptionalStartupArgs(argv: readonly string[]) : any {
  const targets: any[] = [];
  const environmentFiles: Record<string, any> = {};
  let runtimeConfigPath: any = "";
  let mode: any = "start";

  for (let index: any = 0; index < argv.length; index += 1) {
    const argument: any = argv[index];
    if (argument === "--target") {
      const targetId: any = argumentValue(argv, index, "target");
      if (targets.includes(targetId)) throw argumentError("optional_startup_target_duplicate");
      targets.push(targetId);
      index += 1;
      continue;
    }
    if (argument === "--runtime-config") {
      if (runtimeConfigPath) throw argumentError("optional_startup_runtime_config_duplicate");
      runtimeConfigPath = argumentValue(argv, index, "runtime_config");
      index += 1;
      continue;
    }
    if (argument === "--env-file") {
      const binding: any = parseEnvironmentBinding(argumentValue(argv, index, "env_file"));
      if (environmentFiles[binding.targetId]) throw argumentError("optional_startup_env_file_duplicate");
      environmentFiles[binding.targetId] = binding.filePath;
      index += 1;
      continue;
    }
    if (argument === "--list") {
      mode = "list";
      continue;
    }
    if (argument === "--help") {
      mode = "help";
      continue;
    }
    throw argumentError("optional_startup_argument_unknown");
  }

  if (mode !== "start" && (targets.length > 0 || runtimeConfigPath || Object.keys(environmentFiles).length > 0)) {
    throw argumentError("optional_startup_mode_conflict");
  }

  return Object.freeze({
    mode,
    targets: Object.freeze(targets),
    runtimeConfigPath,
    environmentFiles: Object.freeze(environmentFiles),
  });
}
