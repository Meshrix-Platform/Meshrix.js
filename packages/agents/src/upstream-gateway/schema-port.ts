/**
 * Domain-owned schema capability consumed by the upstream gateway feature.
 *
 * The Agents feature never imports the Gateway schema implementation. The
 * composition root injects a port backed by the existing isolated schema
 * worker; classified outcomes replace kernel error types at this boundary.
 */

export interface UpstreamSchemaValidationInput {
  readonly schema: unknown;
  readonly value: unknown;
  readonly signal?: AbortSignal;
}

export type UpstreamSchemaValidationOutcome =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; code: string; message: string }>;

export class UpstreamSchemaPortError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "UpstreamSchemaPortError";
    this.code = code;
  }
}

export interface UpstreamSchemaPort {
  /** Synchronous bounded budget inspection for an advertised external schema. */
  assertSchemaBudget(schema: unknown): void;
  /** Compile in isolation and validate one value; classified outcome, never kernel types. */
  validate(input: UpstreamSchemaValidationInput): Promise<UpstreamSchemaValidationOutcome>;
  /** Release the port-owned validator after registry work has drained. */
  close?(): Promise<void>;
}
