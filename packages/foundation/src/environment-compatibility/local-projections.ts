import os from "node:os";
import path from "node:path";

export function defaultLocalSharedRootPath({ homeDir = os.homedir() }: Record<string, any> = {}) : any {
  return path.join(homeDir, "Meshrix", "shared");
}

export function defaultLocalProjectionRootPath(_provider: any = "", options: Record<string, any> = {}) : any {
  return defaultLocalSharedRootPath(options);
}

export function defaultLocalProjectionPaths(options: Record<string, any> = {}) : any {
  return {
    sharedRoot: defaultLocalSharedRootPath(options)
  };
}
