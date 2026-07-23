import os from "node:os";
import path from "node:path";

export function defaultLocalSharedRootPath({ homeDir = os.homedir() } = {}) {
  return path.join(homeDir, "LicoMesh", "shared");
}

export function defaultLocalProjectionRootPath(_provider = "", options = {}) {
  return defaultLocalSharedRootPath(options);
}

export function defaultLocalProjectionPaths(options = {}) {
  return {
    sharedRoot: defaultLocalSharedRootPath(options)
  };
}
