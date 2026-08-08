import { toCanonicalSafeValue } from "pactium";

/**
 * @deprecated Use `toCanonicalSafeValue` from `pactium`. Removal: next major (Meshrix.js 1.0.0).
 */
export function toPactiumCanonicalSafeValue(
  value?: any,
  options: Record<string, any> = {},
  depth: any = 0
) : any {
  return toCanonicalSafeValue(value, options, depth);
}
