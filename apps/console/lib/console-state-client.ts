import { getJson } from "@lico/ui-console/bridge-http";
import type { ServerConsoleState } from "./types";

export function getServerConsoleState() {
  return getJson<ServerConsoleState>("/api/console/state");
}
