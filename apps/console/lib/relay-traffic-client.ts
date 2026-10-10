import { getJson } from "@meshrix/ui-console/bridge-http";
import type { RelayTrafficResponse } from "./types";

export function getRelayTraffic() : any {
  return getJson<RelayTrafficResponse>("/api/system/relay-traffic");
}
