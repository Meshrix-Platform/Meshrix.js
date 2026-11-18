import { getProductionHealth, getReadinessBaselineStatus } from "./production-health-client";
import type { ProductionHealthResponse, ReadinessBaselineStatus } from "./types";

type VersionReleaseSnapshot = {
  baseline?: ReadinessBaselineStatus;
  baselineError?: string;
  productionHealth?: ProductionHealthResponse;
  productionHealthError?: string;
};

function errorMessage(error: unknown) : any {
  return error instanceof Error ? error.message : String(error);
}

export async function loadVersionReleaseSnapshot(): Promise<VersionReleaseSnapshot> {
  const [baselineResult, productionHealthResult] = await Promise.allSettled([
    getReadinessBaselineStatus(),
    getProductionHealth(),
  ]);
  const snapshot: VersionReleaseSnapshot = {};
  if (baselineResult.status === "fulfilled") {
    snapshot.baseline = baselineResult.value;
  } else {
    snapshot.baselineError = errorMessage(baselineResult.reason);
  }
  if (productionHealthResult.status === "fulfilled") {
    snapshot.productionHealth = productionHealthResult.value;
  } else {
    snapshot.productionHealthError = errorMessage(productionHealthResult.reason);
  }
  return snapshot;
}

export type { ProductionHealthResponse, ReadinessBaselineStatus };
