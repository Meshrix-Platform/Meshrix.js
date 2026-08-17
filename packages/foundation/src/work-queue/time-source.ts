export interface QueueTimeSource {
  nowMs(): number;
  nowDate(): Date;
  nowIso(): string;
}

export interface ManualQueueTimeSource extends QueueTimeSource {
  set(valueMs?: unknown): number;
  advance(deltaMs?: unknown): number;
}

export function createSystemQueueTimeSource(): Readonly<QueueTimeSource> {
  return Object.freeze({
    nowMs(): number {
      return Date.now();
    },
    nowDate(): Date {
      return new Date(this.nowMs());
    },
    nowIso(): string {
      return this.nowDate().toISOString();
    }
  });
}

export function createFixedQueueTimeSource(value: unknown = 0): Readonly<QueueTimeSource> {
  const fixedMs = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return Object.freeze({
    nowMs(): number {
      return fixedMs;
    },
    nowDate(): Date {
      return new Date(fixedMs);
    },
    nowIso(): string {
      return new Date(fixedMs).toISOString();
    }
  });
}

export function createManualQueueTimeSource(value: unknown = 0): ManualQueueTimeSource {
  let currentMs = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return {
    nowMs(): number {
      return currentMs;
    },
    nowDate(): Date {
      return new Date(currentMs);
    },
    nowIso(): string {
      return new Date(currentMs).toISOString();
    },
    set(valueMs?: unknown): number {
      currentMs = Math.trunc(Number(valueMs));
      return currentMs;
    },
    advance(deltaMs?: unknown): number {
      currentMs += Math.trunc(Number(deltaMs));
      return currentMs;
    }
  };
}

export const systemQueueTimeSource = createSystemQueueTimeSource();
