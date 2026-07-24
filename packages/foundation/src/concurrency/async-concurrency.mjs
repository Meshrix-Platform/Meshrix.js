import pLimit from "p-limit";

export function normalizeConcurrency(value, fallback = 1, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : Number(fallback || 1);
  return Math.max(1, Math.min(Math.max(1, Number(max || 1)), normalized || 1));
}

export async function mapWithConcurrency(items, concurrency, mapper, options = {}) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }
  const safeConcurrency = normalizeConcurrency(
    concurrency,
    options.fallbackConcurrency || 1,
    options.maxConcurrency || list.length
  );
  const limit = pLimit(safeConcurrency);
  return Promise.all(
    list.map((item, index) =>
      limit(() => mapper(item, index))
    )
  );
}
