/**
 * Typed errors for the entry transport. `code` is the stable machine-readable
 * vocabulary the local MCP face projects into JSON-RPC error `data.code`;
 * `effectOutcome` records how far an operation provably got so callers can
 * distinguish a safe retry (`not_started`) from an in-doubt dispatch
 * (`unknown`) instead of inferring it from text.
 */
export interface EntryTransportError extends Error {
  readonly code: string;
  readonly effectOutcome?: "not_started" | "unknown";
}

export function entryError(
  code: string,
  message: string,
  options: { readonly cause?: unknown; readonly effectOutcome?: "not_started" | "unknown" } = {}
): EntryTransportError {
  const error = new Error(message, options.cause === undefined ? undefined : { cause: options.cause }) as Error & { code: string; effectOutcome?: "not_started" | "unknown" };
  error.code = code;
  if (options.effectOutcome !== undefined) error.effectOutcome = options.effectOutcome;
  return error;
}

export function isEntryError(value: unknown, code?: string): value is EntryTransportError {
  return typeof value === "object" && value !== null
    && typeof (value as { code?: unknown }).code === "string"
    && (code === undefined || (value as { code?: unknown }).code === code);
}
