export function liveReadinessExitCode(readiness = {}) {
  if (readiness?.releaseReady === true) {
    return 0;
  }
  return readiness?.liveStatus === "blocked" ? 2 : 1;
}
