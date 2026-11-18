export function assertPeerReady(value: string): void {
  if (value !== "ready") throw new Error("The fixture peer did not publish a complete readiness marker.");
}

export function readHttpPeerPort(value: string): number {
  let readiness: unknown;
  try { readiness = JSON.parse(value); }
  catch { throw new Error("The HTTP fixture peer published malformed readiness."); }
  if (
    readiness === null ||
    typeof readiness !== "object" ||
    Array.isArray(readiness) ||
    Object.keys(readiness).length !== 1 ||
    !Object.hasOwn(readiness, "port")
  ) {
    throw new Error("The HTTP fixture peer published malformed readiness.");
  }
  const port = (readiness as { port?: unknown }).port;
  if (!Number.isSafeInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("The HTTP fixture peer published an invalid listener port.");
  }
  return Number(port);
}
