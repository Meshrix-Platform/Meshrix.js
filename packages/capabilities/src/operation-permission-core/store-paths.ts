import path from "node:path";

export function getOperationPermissionDatabasePath(userDataPath?: any) : any {
  return path.join(userDataPath, "operation-permission", "operation-permission.sqlite");
}
