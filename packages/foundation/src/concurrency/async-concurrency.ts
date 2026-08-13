export function normalizeConcurrency(value?: any, fallback: any = 1, max: any = Number.MAX_SAFE_INTEGER) : any {
  const parsed: any = Number(value);
  const normalized: any = Number.isFinite(parsed) ? Math.trunc(parsed) : Number(fallback || 1);
  return Math.max(1, Math.min(Math.max(1, Number(max || 1)), normalized || 1));
}

export async function mapWithConcurrency(items?: any, concurrency?: any, mapper?: any, options: Record<string, any> = {}) : Promise<any> {
  const list: any = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    return [];
  }
  const safeConcurrency: any = normalizeConcurrency(
    concurrency,
    options.fallbackConcurrency || 1,
    options.maxConcurrency || list.length
  );
  const output: any[] = new Array(list.length);
  let cursor: any = 0;
  const workers: any[] = Array.from(
    { length: Math.min(safeConcurrency, list.length) },
    async () : Promise<any> => {
      while (cursor < list.length) {
        const index: any = cursor++;
        output[index] = await mapper(list[index], index);
      }
    }
  );
  await Promise.all(workers);
  return output;
}
