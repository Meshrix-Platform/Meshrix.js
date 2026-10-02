import { assertExternalSchemaBudget, createIsolatedSchemaValidator, GatewaySchemaError } from "@meshrix/gateway/schema";
import type { UpstreamSchemaPort, UpstreamSchemaValidationOutcome } from "@meshrix/agents/upstream-gateway/index";
import { UpstreamSchemaPortError } from "@meshrix/agents/upstream-gateway/index";

/**
 * Composition-owned adapter from the Gateway's isolated schema worker to the
 * Agent feature's schema port. Each injected port owns one lazily-started
 * isolated validator for its full registry lifetime; registry shutdown closes
 * its bounded worker pool after active registry work has settled.
 */
export function createGatewaySchemaPort(): UpstreamSchemaPort {
  const validator = createIsolatedSchemaValidator();
  return Object.freeze({
    assertSchemaBudget(schema: unknown): void {
      try {
        assertExternalSchemaBudget(schema);
      } catch (error) {
        if (error instanceof GatewaySchemaError) throw new UpstreamSchemaPortError(error.code, error.message);
        throw error;
      }
    },
    async validate({ schema, value, signal }: Parameters<UpstreamSchemaPort["validate"]>[0]): Promise<UpstreamSchemaValidationOutcome> {
      try {
        await validator.compile(schema).assertValid(value, signal);
        return Object.freeze({ ok: true as const });
      } catch (error) {
        if (error instanceof GatewaySchemaError) {
          return Object.freeze({ ok: false as const, code: error.code, message: error.message });
        }
        throw error;
      }
    },
    close: () => validator.close()
  });
}
