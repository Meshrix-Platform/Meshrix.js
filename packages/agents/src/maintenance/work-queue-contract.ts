import { createHash } from "node:crypto";

const MAINTENANCE_CONTEXT_REF_MAX_LENGTH: any = 128;
const MAINTENANCE_CONTEXT_REF_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export function maintenanceQueueContextRef(runId?: any) : any {
  const contextRef: any = String(runId || "").trim();
  if (!contextRef) {
    throw new TypeError("Maintenance queue context reference is required.");
  }
  if (
    contextRef.length > MAINTENANCE_CONTEXT_REF_MAX_LENGTH ||
    !MAINTENANCE_CONTEXT_REF_PATTERN.test(contextRef)
  ) {
    throw new TypeError("Maintenance queue context reference must be a bounded opaque identifier.");
  }
  return contextRef;
}

export function maintenanceWorkItemId(runId?: any) : any {
  const contextRef: any = maintenanceQueueContextRef(runId);
  const digest: any = createHash("sha256").update(contextRef).digest("hex");
  return `wqwi_maintenance_${digest.slice(0, 40)}`;
}
