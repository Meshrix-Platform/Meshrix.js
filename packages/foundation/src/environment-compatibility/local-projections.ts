import os from "node:os";
import path from "node:path";

interface LocalProjectionOptions {
  homeDir?: string;
}

export interface LocalProjectionPaths {
  sharedRoot: string;
}

export function defaultLocalSharedRootPath({ homeDir = os.homedir() }: LocalProjectionOptions = {}): string {
  return path.join(homeDir, "Meshrix.js", "shared");
}

export function defaultLocalProjectionRootPath(_provider: unknown = "", options: LocalProjectionOptions = {}): string {
  return defaultLocalSharedRootPath(options);
}

export function defaultLocalProjectionPaths(options: LocalProjectionOptions = {}): LocalProjectionPaths {
  return {
    sharedRoot: defaultLocalSharedRootPath(options)
  };
}
