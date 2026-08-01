export function liveReadinessExitCode(readiness: Record<string, any> = {}) : any {
  if (readiness?.releaseReady === true) {
    return 0;
  }
  return readiness?.liveStatus === "blocked" ? 2 : 1;
}
