import path from "node:path";

export function getOperationPermissionDatabasePath(userDataPath) {
  return path.join(userDataPath, "operation-permission", "operation-permission.sqlite");
}
