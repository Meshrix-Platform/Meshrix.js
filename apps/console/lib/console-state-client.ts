import { getJson } from "@meshrix/ui-console/bridge-http";
import type { ServerConsoleState } from "./types";

export function getServerConsoleState() : any {
  return getJson<ServerConsoleState>("/api/console/state");
}
