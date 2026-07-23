import { getJson, postJson } from "@lico/ui-console/bridge-http";
import type {
  RuntimeAssemblyBuildPayload,
  RuntimeAssemblyBuildResponse,
  RuntimeInfoResponse,
  ServerPathBrowseResponse,
} from "./types";

export type ServerPathBrowsePayload = {
  path?: string;
  mode?: "directory" | "file";
  extensions?: string[];
  includeHidden?: boolean;
};

export function getRuntimeInfo() {
  return getJson<RuntimeInfoResponse>("/api/runtime/info");
}

export function browseServerPath(payload: ServerPathBrowsePayload) {
  return postJson<ServerPathBrowseResponse>("/api/runtime/path-browse", payload);
}

export function buildRuntimeAssembly(payload: RuntimeAssemblyBuildPayload) {
  return postJson<RuntimeAssemblyBuildResponse>(
    "/api/runtime/assembly/build",
    payload,
    { safetyConfirm: true },
  );
}
