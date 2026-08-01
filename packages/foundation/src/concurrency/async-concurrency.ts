import pLimit from "p-limit";

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
  const limit: any = pLimit(safeConcurrency);
  return Promise.all(
    list.map((item?: any, index?: any) : any =>
      limit(() : any => mapper(item, index))
    )
  );
}
