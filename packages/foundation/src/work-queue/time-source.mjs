export function createSystemQueueTimeSource() {
  return Object.freeze({
    nowMs() {
      return Date.now();
    },
    nowDate() {
      return new Date(this.nowMs());
    },
    nowIso() {
      return this.nowDate().toISOString();
    }
  });
}

export function createFixedQueueTimeSource(value = 0) {
  const fixedMs = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return Object.freeze({
    nowMs() {
      return fixedMs;
    },
    nowDate() {
      return new Date(fixedMs);
    },
    nowIso() {
      return new Date(fixedMs).toISOString();
    }
  });
}

export function createManualQueueTimeSource(value = 0) {
  let currentMs = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0;
  return {
    nowMs() {
      return currentMs;
    },
    nowDate() {
      return new Date(currentMs);
    },
    nowIso() {
      return new Date(currentMs).toISOString();
    },
    set(valueMs) {
      currentMs = Math.trunc(Number(valueMs));
      return currentMs;
    },
    advance(deltaMs) {
      currentMs += Math.trunc(Number(deltaMs));
      return currentMs;
    }
  };
}

export const systemQueueTimeSource = createSystemQueueTimeSource();
