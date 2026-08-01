export function createSystemQueueTimeSource() : any {
  return Object.freeze({
    nowMs() : any {
      return Date.now();
    },
    nowDate() : any {
      return new Date(this.nowMs());
    },
    nowIso() : any {
      return this.nowDate().toISOString();
    }
  });
}

export function createFixedQueueTimeSource(value: any = 0) : any {
  const fixedMs: any = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return Object.freeze({
    nowMs() : any {
      return fixedMs;
    },
    nowDate() : any {
      return new Date(fixedMs);
    },
    nowIso() : any {
      return new Date(fixedMs).toISOString();
    }
  });
}

export function createManualQueueTimeSource(value: any = 0) : any {
  let currentMs: any = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return {
    nowMs() : any {
      return currentMs;
    },
    nowDate() : any {
      return new Date(currentMs);
    },
    nowIso() : any {
      return new Date(currentMs).toISOString();
    },
    set(valueMs?: any) : any {
      currentMs = Math.trunc(Number(valueMs));
      return currentMs;
    },
    advance(deltaMs?: any) : any {
      currentMs += Math.trunc(Number(deltaMs));
      return currentMs;
    }
  };
}

export const systemQueueTimeSource: any = createSystemQueueTimeSource();
