import { getJson } from "@meshrix/ui-console/bridge-http";
import type { ProductionHealthResponse, ReadinessBaselineStatus } from "./types";

export function getProductionHealth() {
  return getJson<ProductionHealthResponse>("/api/production/health");
}

export function getReadinessBaselineStatus() {
  return getJson<ReadinessBaselineStatus>("/api/readiness/baseline/status");
}
