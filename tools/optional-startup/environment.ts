import fs from "node:fs/promises";
import path from "node:path";

function environmentError(code: string) : any {
  const error: Error & Record<string, any> = new Error(code);
  error.code = code;
  return error;
}

export async function loadOptionalTargetEnvironments(
  bindings: Readonly<Record<string, any>>,
  selectedTargets: readonly any[],
) : Promise<any> {
  const selectedById: any = new Map(selectedTargets.map((entry?: any) : any => [entry.id, entry]));
  const loaded: Record<string, any> = {};

  await Promise.all(Object.entries(bindings).map(async ([targetId, filePath]: [string, any]) : Promise<any> => {
    const target: any = selectedById.get(targetId);
    if (!target) throw environmentError("optional_startup_env_target_not_selected");
    if (!["service", "agent"].includes(target.kind)) {
      throw environmentError("optional_startup_env_target_unsupported");
    }
    let parsed: any;
    try {
      parsed = JSON.parse(await fs.readFile(path.resolve(String(filePath)), "utf8"));
    } catch {
      throw environmentError("optional_startup_env_file_invalid");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw environmentError("optional_startup_env_file_invalid");
    }
    for (const [name, value] of Object.entries(parsed)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || typeof value !== "string") {
        throw environmentError("optional_startup_env_file_invalid");
      }
    }
    loaded[targetId] = Object.freeze({ ...process.env, ...parsed });
  }));

  return Object.freeze(loaded);
}
