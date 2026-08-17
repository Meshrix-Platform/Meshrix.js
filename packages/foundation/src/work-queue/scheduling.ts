export const WORK_QUEUE_PRIORITY_CLASSES = Object.freeze({
  CRITICAL: "critical",
  HIGH: "high",
  NORMAL: "normal",
  LOW: "low"
});

export type WorkQueuePriorityClass = typeof WORK_QUEUE_PRIORITY_CLASSES[keyof typeof WORK_QUEUE_PRIORITY_CLASSES];

export const WORK_QUEUE_PRIORITY_WEIGHTS: Readonly<Record<WorkQueuePriorityClass, number>> = Object.freeze({
  [WORK_QUEUE_PRIORITY_CLASSES.CRITICAL]: 8,
  [WORK_QUEUE_PRIORITY_CLASSES.HIGH]: 4,
  [WORK_QUEUE_PRIORITY_CLASSES.NORMAL]: 2,
  [WORK_QUEUE_PRIORITY_CLASSES.LOW]: 1
});

export const WORK_QUEUE_PRIORITY_CYCLE: readonly WorkQueuePriorityClass[] = Object.freeze(
  (Object.entries(WORK_QUEUE_PRIORITY_WEIGHTS) as [WorkQueuePriorityClass, number][])
    .flatMap(([priorityClass, weight]) => Array.from({ length: weight }, () => priorityClass))
);

export function normalizeWorkQueuePriority(value?: unknown): Readonly<{ priority: number; priorityClass: WorkQueuePriorityClass }> {
  const priority = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  if (priority >= 2) return Object.freeze({ priority: 2, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.CRITICAL });
  if (priority === 1) return Object.freeze({ priority: 1, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.HIGH });
  if (priority < 0) return Object.freeze({ priority: -1, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.LOW });
  return Object.freeze({ priority: 0, priorityClass: WORK_QUEUE_PRIORITY_CLASSES.NORMAL });
}

export function priorityClassAtCursor(cursor: unknown = 0): WorkQueuePriorityClass {
  const normalized = Math.max(0, Math.trunc(Number(cursor) || 0));
  return WORK_QUEUE_PRIORITY_CYCLE[normalized % WORK_QUEUE_PRIORITY_CYCLE.length];
}

export function nextPriorityCursor(cursor: unknown = 0): number {
  const normalized = Math.max(0, Math.trunc(Number(cursor) || 0));
  return (normalized + 1) % WORK_QUEUE_PRIORITY_CYCLE.length;
}

export function agedWorkQueuePriorityClass({ priority = 0, availableAtMs = 0, nowMs = 0, agingIntervalMs }: {
  priority?: unknown; availableAtMs?: unknown; nowMs?: unknown; agingIntervalMs?: unknown;
} = {}): WorkQueuePriorityClass {
  const interval = Math.max(1, Math.trunc(Number(agingIntervalMs) || 1));
  const base = normalizeWorkQueuePriority(priority).priorityClass;
  const classes: WorkQueuePriorityClass[] = [
    WORK_QUEUE_PRIORITY_CLASSES.LOW,
    WORK_QUEUE_PRIORITY_CLASSES.NORMAL,
    WORK_QUEUE_PRIORITY_CLASSES.HIGH,
    WORK_QUEUE_PRIORITY_CLASSES.CRITICAL
  ];
  const baseIndex = classes.indexOf(base);
  const promotions = Math.max(0, Math.floor((Number(nowMs) - Number(availableAtMs)) / interval));
  return classes[Math.min(classes.length - 1, baseIndex + promotions)];
}

export function hierarchicalScopeParts(scope: Record<string, unknown> = {}): Readonly<{ tenantId: string; workspaceId: string; projectId: string }> {
  return Object.freeze({
    tenantId: String(scope.tenantId || "").trim(),
    workspaceId: String(scope.workspaceId || "").trim(),
    projectId: String(scope.projectId || "").trim()
  });
}

export class WorkQueueCapacityError extends Error {
  code: "work_queue_capacity_exceeded";
  limit: unknown;
  reason: unknown;
  constructor(reason?: unknown, limit?: unknown) {
    super(`Work queue capacity exceeded: ${reason}.`);
    this.name = "WorkQueueCapacityError";
    this.code = "work_queue_capacity_exceeded";
    this.reason = reason;
    this.limit = limit;
  }
}

export function assertCapacityBelow({ count, limit, reason }: { count: unknown; limit: unknown; reason?: unknown }): void {
  if (Number(count) >= Number(limit)) {
    throw new WorkQueueCapacityError(reason, limit);
  }
}

export function assertCapacityAtMost({ count, limit, reason }: { count: unknown; limit: unknown; reason?: unknown }): void {
  if (Number(count) > Number(limit)) {
    throw new WorkQueueCapacityError(reason, limit);
  }
}
