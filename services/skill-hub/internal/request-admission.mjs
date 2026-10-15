// Reserve body capacity before consuming an authenticated operation request.
// A lease covers body receipt and execution; admitted work has no deadline.
export function createRequestAdmission({ maxPending = 256, maxPendingBytes = 16 * 1024 * 1024,
  maxSubjectPending = 32, maxSubjectBytes = 8 * 1024 * 1024 } = {}) {
  if ([maxPending, maxPendingBytes, maxSubjectPending, maxSubjectBytes]
    .some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new TypeError("Skill Hub request admission requires positive count and byte bounds.");
  }
  const subjects = new Map();
  let count = 0;
  let bytes = 0;
  return Object.freeze({
    acquire(subject, charge) {
      const current = subjects.get(subject) || { count: 0, bytes: 0 };
      if (count >= maxPending || bytes + charge > maxPendingBytes ||
          current.count >= maxSubjectPending || current.bytes + charge > maxSubjectBytes) return null;
      count += 1;
      bytes += charge;
      current.count += 1;
      current.bytes += charge;
      subjects.set(subject, current);
      let released = false;
      return Object.freeze({ release() {
        if (released) return;
        released = true;
        count -= 1;
        bytes -= charge;
        current.count -= 1;
        current.bytes -= charge;
        if (current.count === 0) subjects.delete(subject);
      } });
    }
  });
}
