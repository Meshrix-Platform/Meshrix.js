export interface ConcurrencyOptions {
  fallbackConcurrency?: number;
  maxConcurrency?: number;
}

export function normalizeConcurrency(
  value: unknown,
  fallback = 1,
  max = Number.MAX_SAFE_INTEGER,
): number {
  const parsed = Number(value);
  const normalized = Number.isFinite(parsed)
    ? Math.trunc(parsed)
    : Number(fallback || 1);
  return Math.max(1, Math.min(Math.max(1, Number(max || 1)), normalized || 1));
}

export async function mapWithConcurrency<T, R>(
  items: readonly T[] | null | undefined,
  concurrency: unknown,
  mapper: (item: T, index: number) => R | PromiseLike<R>,
  options: ConcurrencyOptions = {},
): Promise<R[]> {
  const list: readonly T[] = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }
  const safeConcurrency = normalizeConcurrency(
    concurrency,
    options.fallbackConcurrency || 1,
    options.maxConcurrency || list.length,
  );
  const output: R[] = [];
  output.length = list.length;
  let cursor = 0;
  const workers: Promise<void>[] = Array.from(
    { length: Math.min(safeConcurrency, list.length) },
    async (): Promise<void> => {
      while (cursor < list.length) {
        const index = cursor++;
        output[index] = await mapper(list[index], index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}
