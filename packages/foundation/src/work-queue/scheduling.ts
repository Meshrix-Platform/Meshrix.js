export const WORK_QUEUE_PRIORITY_CLASSES: Readonly<Record<string, any>> = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low"
});

export const WORK_QUEUE_PRIORITY_WEIGHTS: Readonly<Record<string, any>> = Object.freeze({
  [WORK_QUEUE_PRIORITY_CLASSES.CRITICAL]: 8,
  [WORK_QUEUE_PRIORITY_CLASSES.HIGH]: 4,
  [WORK_QUEUE_PRIORITY_CLASSES.NORMAL]: 2,
  [WORK_QUEUE_PRIORITY_CLASSES.LOW]: 1
});

export const WORK_QUEUE_PRIORITY_CYCLE: any = Object.freeze(
  (Object.entries(WORK_QUEUE_PRIORITY_WEIGHTS) as [string, any][])
    .flatMap(([priorityClass, weight]: any[]) : any => Array.from({ length: weight }, () : any => priorityClass))
);

export function normalizeWorkQueuePriority(value?: any) : any {
  const priority: any = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  if (priority >= 2) return Object.freeze({ priority: 2, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.CRITICAL });
  if (priority === 1) return Object.freeze({ priority: 1, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.HIGH });
  if (priority < 0) return Object.freeze({ priority: -1, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.LOW });
  return Object.freeze({ priority: 0, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.NORMAL });
}

export function priorityClassAtCursor(cursor: any = 0) : any {
  const normalized: any = Math.max(0, Math.trunc(Number(cursor) || 0));
  return WORK_QUEUE_PRIORITY_CYCLE[normalized % WORK_QUEUE_PRIORITY_CYCLE.length];
}

export function nextPriorityCursor(cursor: any = 0) : any {
  const normalized: any = Math.max(0, Math.trunc(Number(cursor) || 0));
  return (normalized + 1) % WORK_QUEUE_PRIORITY_CYCLE.length;
}

export function agedWorkQueuePriorityClass({ priority = 0, availableAtMs = 0, nowMs = 0, agingIntervalMs }: Record<string, any> = {}) : any {
  const interval: any = Math.max(1, Math.trunc(Number(agingIntervalMs) || 1));
  const base: any = normalizeWorkQueuePriority(priority).priorityClass;
  const classes: any[] = [
    WORK_QUEUE_PRIORITY_CLASSES.LOW,
    WORK_QUEUE_PRIORITY_CLASSES.NORMAL,
    WORK_QUEUE_PRIORITY_CLASSES.HIGH,
    WORK_QUEUE_PRIORITY_CLASSES.CRITICAL
  ];
  const baseIndex: any = classes.indexOf(base);
  const promotions: any = Math.max(0, Math.floor((Number(nowMs) - Number(availableAtMs)) / interval));
  return classes[Math.min(classes.length - 1, baseIndex + promotions)];
}

export function hierarchicalScopeParts(scope: Record<string, any> = {}) : any {
  return Object.freeze({
    tenantId: String(scope.tenantId || "").trim(),
    workspaceId: String(scope.workspaceId || "").trim(),
    projectId: String(scope.projectId || "").trim()
  });
}

export class WorkQueueCapacityError extends Error {
  code: any;
  limit: any;
  name: any;
  reason: any;
  constructor(reason?: any, limit?: any) {
    super(`Work queue capacity exceeded: ${reason}.`);
    this.name = "WorkQueueCapacityError";
    this.code = "work_queue_capacity_exceeded";
    this.reason = reason;
    this.limit = limit;
  }
}

export function assertCapacityBelow({ count, limit, reason }: Record<string, any>) : any {
  if (Number(count) >= Number(limit)) {
    throw new WorkQueueCapacityError(reason, limit);
  }
}

export function assertCapacityAtMost({ count, limit, reason }: Record<string, any>) : any {
  if (Number(count) > Number(limit)) {
    throw new WorkQueueCapacityError(reason, limit);
  }
}
