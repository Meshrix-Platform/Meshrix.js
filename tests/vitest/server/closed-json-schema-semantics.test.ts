import { describe, expect, it, vi } from "vitest";

import {
  createUpstreamPublishingApplication,
  UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION
} from "../../../packages/agents/src/upstream-gateway/publishing-application.ts";
import {
  applyStructuredResponsePolicy,
  validateResponseSchema
} from "../../../packages/agents/src/upstream-gateway/response-policy.ts";
import {
  publicUpstreamMcpTool,
  publicUpstreamOperationTool
} from "../../../packages/agents/src/upstream-gateway/tool-projection.ts";
import {
  compileInputSchema,
  validateInputSchema
} from "../../../packages/capabilities/src/operation-permission-core/runtime-schema.ts";
import { structuredJsonPayloadTransport } from "../../helpers/upstream-runtime-snapshot.ts";

const PRIVATE_SCHEMA_MARKER: any = "synthetic-protected-schema-marker";
const SIMPLE_REMOVED_PATTERN: any = "^[a-z0-9-]{3,16}$";
const AMBIGUOUS_REMOVED_PATTERN: any = "(a|aa)+$";

function validClosedSchema() : any {
  return {
    type: "object",
    additionalProperties: false,
    required: ["tenantId", "policy", "records", "labels"],
    properties: {
      tenantId: {
        type: "string",
        minLength: 3,
        maxLength: 16
      },
      policy: {
        type: "object",
        additionalProperties: false,
        required: ["level"],
        properties: {
          level: {
            type: "integer",
            minimum: 1,
            maximum: 5
          }
        }
      },
      records: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
              maxLength: 8
            }
          }
        }
      },
      labels: {
        type: "object",
        additionalProperties: {
          type: "string",
          minLength: 1,
          maxLength: 12
        }
      }
    }
  };
}

function validValue() : any {
  return {
    tenantId: "tenant-a",
    policy: {
      level: 3
    },
    records: [{
      name: "alpha"
    }],
    labels: {
      region: "east"
    }
  };
}

function clone(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

function nestedSchema(depth?: any) : any {
  let schema: Record<string, any> = {
    type: "string",
    maxLength: 8
  };
  for (let index: any = 0; index < depth; index += 1) {
    schema = {
      type: "object",
      additionalProperties: false,
      required: ["child"],
      properties: {
        child: schema
      }
    };
  }
  return schema;
}

function schemaWithPattern(pattern?: any, { nested = false }: Record<string, any> = {}) : any {
  const schema: any = validClosedSchema();
  if (nested) {
    schema.properties.records.items.properties.name.pattern = pattern;
  } else {
    schema.properties.tenantId.pattern = pattern;
  }
  return schema;
}

function invalidSchemaDefinitions() : any {
  const unknownType: any = validClosedSchema();
  unknownType.properties.policy.properties.level.type = "executable";

  const unknownKeyword: any = validClosedSchema();
  unknownKeyword.properties.tenantId.transform = PRIVATE_SCHEMA_MARKER;

  const undeclaredRequired: any = validClosedSchema();
  undeclaredRequired.properties.policy.required.push("undeclared");

  const contradictoryBounds: any = validClosedSchema();
  contradictoryBounds.properties.tenantId.minLength = 10;
  contradictoryBounds.properties.tenantId.maxLength = 4;

  return [
    unknownType,
    { type: "string", maxLength: 16 },
    schemaWithPattern(SIMPLE_REMOVED_PATTERN),
    schemaWithPattern(AMBIGUOUS_REMOVED_PATTERN, { nested: true }),
    unknownKeyword,
    undeclaredRequired,
    contradictoryBounds,
    nestedSchema(10)
  ];
}

function invalidValues() : any {
  const missingRequired: any = validValue();
  delete missingRequired.tenantId;

  const unknownRootField: Record<string, any> = {
    ...validValue(),
    undeclared: true
  };

  const unknownNestedField: any = validValue();
  unknownNestedField.policy.undeclared = true;

  const nestedTypeMismatch: any = validValue();
  nestedTypeMismatch.policy.level = "3";

  const numberAboveMaximum: any = validValue();
  numberAboveMaximum.policy.level = 6;

  const emptyArray: any = validValue();
  emptyArray.records = [];

  const oversizedArray: any = validValue();
  oversizedArray.records = [{ name: "alpha" }, { name: "beta" }, { name: "gamma" }];

  const oversizedString: any = validValue();
  oversizedString.records[0].name = "ninechars";

  const additionalPropertyTypeMismatch: any = validValue();
  additionalPropertyTypeMismatch.labels.region = 7;

  const additionalPropertyBoundMismatch: any = validValue();
  additionalPropertyBoundMismatch.labels.region = "";

  return [
    "not-an-object",
    [validValue()],
    null,
    missingRequired,
    unknownRootField,
    unknownNestedField,
    nestedTypeMismatch,
    numberAboveMaximum,
    emptyArray,
    oversizedArray,
    oversizedString,
    additionalPropertyTypeMismatch,
    additionalPropertyBoundMismatch
  ];
}

function publishingCommand(requestSchema: any = validClosedSchema(), responseSchema: any = validClosedSchema()) : any {
  return JSON.stringify({
    schemaVersion: UPSTREAM_PUBLISHING_COMMAND_SCHEMA_VERSION,
    action: "create",
    serviceKey: "closed-schema-fixture",
    expectedServiceRevision: 0,
    expectedSetRevision: 0,
    idempotencyKey: "closed-schema-fixture-create",
    descriptor: {
      serviceProtocol: "http",
      label: "Closed schema fixture",
      baseUrl: "https://service.invalid:443",
      operations: [{
        operationKey: "evaluate",
        method: "POST",
        path: "/evaluate",
        requestSchema,
        responseSchema,
        payloadTransport: structuredJsonPayloadTransport()
      }]
    }
  });
}

function publishingHarness() : any {
  const commitManifestSet: any = vi.fn(async () : Promise<any> => ({
    serviceRevision: 1,
    setRevision: 1,
    setDigest: "a".repeat(64),
    manifestDigest: "b".repeat(64),
    receiptRef: "urn:meshrix:receipt:closed-schema-fixture",
    replayed: false
  }));
  const append: any = vi.fn(async () : Promise<any> => {});
  const getSnapshot: any = vi.fn(async () : Promise<any> => ({
    setRevision: 0,
    setDigest: "0".repeat(64),
    getService: () : any => null
  }));
  return {
    application: createUpstreamPublishingApplication({
      writerPort: {
        commitManifestSet
      },
      readerPort: {
        getSnapshot
      },
      auditPort: {
        append
      }
    }),
    append,
    commitManifestSet
  };
}

function publisherSubject() : any {
  return {
    subjectId: "schema-publisher",
    scopes: ["gateway:write"]
  };
}

function upstreamService() : any {
  return {
    serviceId: "closed-schema-fixture",
    serviceProtocol: "http",
    label: "Closed schema fixture",
    credentialRefs: [],
    mcp: {
      toolNamePrefix: "closed-schema-fixture"
    }
  };
}

function configuredOperation(requestSchema?: any) : any {
  return {
    operationKey: "evaluate",
    protocol: "http",
    method: "POST",
    requiredScopes: ["gateway:read"],
    risk: "read_only",
    ...(requestSchema === undefined ? {} : { requestSchema })
  };
}

function discoveredMcpTool(inputSchema?: any) : any {
  return {
    name: "records.evaluate",
    title: "Evaluate records",
    annotations: {
      readOnlyHint: true
    },
    ...(inputSchema === undefined ? {} : { inputSchema })
  };
}

function captureError(action?: any) : any {
  try {
    action();
  } catch (error: any) {
    return error;
  }
  return null;
}

async function withDynamicRegExpTrap(action?: any) : Promise<any> {
  const NativeRegExp: any = globalThis.RegExp;
  let invocationCount: any = 0;
  const TrappedRegExp: any = new Proxy(NativeRegExp, {
    apply(target?: any, thisArgument?: any, argumentsList?: any) : any {
      invocationCount += 1;
      return Reflect.apply(target, thisArgument, argumentsList);
    },
    construct(target?: any, argumentsList?: any, newTarget?: any) : any {
      invocationCount += 1;
      return Reflect.construct(target, argumentsList, newTarget);
    }
  });
  globalThis.RegExp = TrappedRegExp;
  try {
    await action();
    return invocationCount;
  } finally {
    globalThis.RegExp = NativeRegExp;
  }
}

describe("closed JSON schema semantics", () : any => {
  it("compiles bounded schemas at publishing before audit or durable commit", async () : Promise<any> => {
    const accepted: any = publishingHarness();
    await expect(
      accepted.application.execute(publishingCommand(), publisherSubject())
    ).resolves.toMatchObject({
      ok: true,
      serviceRevision: 1,
      setRevision: 1
    });
    expect(accepted.commitManifestSet).toHaveBeenCalledTimes(1);
    expect(accepted.commitManifestSet.mock.calls[0][0].manifest.payload.descriptor.operations[0])
      .toMatchObject({
        requestSchema: validClosedSchema(),
        responseSchema: validClosedSchema()
      });
    expect(accepted.append).toHaveBeenCalledTimes(1);

    for (const schema of invalidSchemaDefinitions()) {
      const rejected: any = publishingHarness();
      let error: any;
      try {
        await rejected.application.execute(
          publishingCommand(schema, validClosedSchema()),
          publisherSubject()
        );
      } catch (cause: any) {
        error = cause;
      }
      expect(error).toMatchObject({
        code: "upstream_publishing_schema_invalid",
        statusCode: 400
      });
      expect(JSON.stringify({
        code: error?.code,
        message: error?.message
      })).not.toContain(PRIVATE_SCHEMA_MARKER);
      expect(rejected.commitManifestSet).not.toHaveBeenCalled();
      expect(rejected.append).not.toHaveBeenCalled();
    }

    const invalidResponseSchema: any = validClosedSchema();
    invalidResponseSchema.properties.records.items.properties.name.pattern =
      AMBIGUOUS_REMOVED_PATTERN;
    const rejectedResponse: any = publishingHarness();
    await expect(rejectedResponse.application.execute(
      publishingCommand(validClosedSchema(), invalidResponseSchema),
      publisherSubject()
    )).rejects.toMatchObject({
      code: "upstream_publishing_schema_invalid",
      statusCode: 400
    });
    expect(rejectedResponse.commitManifestSet).not.toHaveBeenCalled();
    expect(rejectedResponse.append).not.toHaveBeenCalled();
  });

  it("rejects invalid definitions and values through the Operation Permission input boundary", () : any => {
    const operation: Record<string, any> = {
      id: "operation.closed-schema-fixture",
      inputSchema: validClosedSchema()
    };
    const compiled: any = compileInputSchema(operation);

    expect(compiled(validValue())).toEqual({
      ok: true
    });
    expect(validateInputSchema(operation, validValue())).toEqual({
      ok: true
    });

    for (const value of invalidValues()) {
      expect(compiled(value)).toMatchObject({
        ok: false
      });
      expect(validateInputSchema(operation, value)).toMatchObject({
        ok: false
      });
    }

    for (const [index, inputSchema] of invalidSchemaDefinitions().entries()) {
      expect(validateInputSchema({
        id: `operation.invalid-schema-${index}`,
        inputSchema
      }, validValue())).toMatchObject({
        ok: false
      });
    }
  });

  it("uses the same closed nested semantics at the structured response boundary", () : any => {
    const schema: any = validClosedSchema();

    expect(validateResponseSchema(validValue(), schema, {
      operationKey: "evaluate"
    })).toEqual({
      ok: true
    });
    expect(applyStructuredResponsePolicy(validValue(), {
      operationKey: "evaluate",
      responseSchema: schema
    })).toMatchObject({
      schemaValidated: true,
      projectionValidated: false,
      publicValue: validValue()
    });

    for (const value of invalidValues()) {
      expect(validateResponseSchema(value, schema, {
        operationKey: "evaluate"
      })).toMatchObject({
        ok: false
      });
      expect(captureError(() : any => applyStructuredResponsePolicy(value, {
        operationKey: "evaluate",
        responseSchema: schema
      }))).toMatchObject({
        reasonCode: "response_schema_mismatch",
        status: 502
      });
    }

    for (const [index, invalidSchema] of invalidSchemaDefinitions()
      .filter((schema?: any) : any => schema.type !== "string")
      .entries()) {
      expect(validateResponseSchema(validValue(), invalidSchema, {
        operationKey: `evaluate-invalid-schema-${index}`
      })).toMatchObject({
        ok: false
      });
    }
  });

  it("projects only detached deeply immutable closed object schemas to MCP", () : any => {
    const configuredSource: any = validClosedSchema();
    const configured: any = publicUpstreamOperationTool({
      service: upstreamService(),
      operation: configuredOperation(configuredSource)
    });
    const mcpSource: any = validClosedSchema();
    const discovered: any = publicUpstreamMcpTool({
      service: upstreamService(),
      tool: discoveredMcpTool(mcpSource)
    });

    for (const [projection, source] of [
      [configured, configuredSource],
      [discovered, mcpSource]
    ]) {
      expect(projection.inputSchema).toEqual(validClosedSchema());
      expect(projection.inputSchema).not.toBe(source);
      expect(Object.isFrozen(projection.inputSchema)).toBe(true);
      expect(Object.isFrozen(projection.inputSchema.properties)).toBe(true);
      expect(Object.isFrozen(projection.inputSchema.properties.policy.properties.level)).toBe(true);
      expect(Object.isFrozen(projection.inputSchema.properties.labels.additionalProperties)).toBe(true);
      source.properties.tenantId.type = "integer";
      source.properties.policy.properties.level.maximum = 999;
      expect(projection.inputSchema.properties.tenantId.type).toBe("string");
      expect(projection.inputSchema.properties.policy.properties.level.maximum).toBe(5);
    }

    const closedEmptySchema: Record<string, any> = {
      type: "object",
      properties: {},
      additionalProperties: false
    };
    expect(publicUpstreamOperationTool({
      service: upstreamService(),
      operation: configuredOperation()
    }).inputSchema).toEqual(closedEmptySchema);
    expect(publicUpstreamMcpTool({
      service: upstreamService(),
      tool: discoveredMcpTool()
    }).inputSchema).toEqual(closedEmptySchema);

    const invalidProjectionSchemas: any[] = [
      {
        type: "executable"
      },
      {
        type: "string",
        maxLength: 16
      },
      schemaWithPattern(SIMPLE_REMOVED_PATTERN),
      schemaWithPattern(AMBIGUOUS_REMOVED_PATTERN, { nested: true }),
      {
        type: "object",
        properties: {},
        additionalProperties: false,
        transform: PRIVATE_SCHEMA_MARKER
      }
    ];
    for (const schema of invalidProjectionSchemas) {
      for (const project of [
        () : any => publicUpstreamOperationTool({
          service: upstreamService(),
          operation: configuredOperation(clone(schema))
        }),
        () : any => publicUpstreamMcpTool({
          service: upstreamService(),
          tool: discoveredMcpTool(clone(schema))
        })
      ]) {
        const error: any = captureError(project);
        expect(error).toMatchObject({
          code: "upstream_tool_schema_invalid"
        });
        expect(JSON.stringify({
          code: error?.code,
          message: error?.message
        })).not.toContain(PRIVATE_SCHEMA_MARKER);
      }
    }
  });

  it("rejects removed pattern vocabulary before any schema-driven RegExp runtime entry", async () : Promise<any> => {
    const removedPatternSchemas: any[] = [
      schemaWithPattern(SIMPLE_REMOVED_PATTERN),
      schemaWithPattern(AMBIGUOUS_REMOVED_PATTERN, { nested: true })
    ];

    const dynamicRegExpInvocations: any = await withDynamicRegExpTrap(async () : Promise<any> => {
      for (const [index, schema] of removedPatternSchemas.entries()) {
        const operation: Record<string, any> = {
          id: `operation.removed-pattern-${index}`,
          inputSchema: clone(schema)
        };
        expect(compileInputSchema(operation)(validValue())).toMatchObject({
          ok: false
        });
        expect(validateInputSchema(operation, validValue())).toMatchObject({
          ok: false
        });

        expect(validateResponseSchema(validValue(), clone(schema), {
          operationKey: `evaluate-removed-pattern-${index}`
        })).toMatchObject({
          ok: false
        });
        expect(captureError(() : any => applyStructuredResponsePolicy(validValue(), {
          operationKey: `evaluate-removed-pattern-${index}`,
          responseSchema: clone(schema)
        }))).toMatchObject({
          reasonCode: "response_schema_mismatch",
          status: 502
        });

        for (const project of [
          () : any => publicUpstreamOperationTool({
            service: upstreamService(),
            operation: configuredOperation(clone(schema))
          }),
          () : any => publicUpstreamMcpTool({
            service: upstreamService(),
            tool: discoveredMcpTool(clone(schema))
          })
        ]) {
          expect(captureError(project)).toMatchObject({
            code: "upstream_tool_schema_invalid"
          });
        }

        const rejectedRequest: any = publishingHarness();
        await expect(rejectedRequest.application.execute(
          publishingCommand(clone(schema), validClosedSchema()),
          publisherSubject()
        )).rejects.toMatchObject({
          code: "upstream_publishing_schema_invalid",
          statusCode: 400
        });
        expect(rejectedRequest.commitManifestSet).not.toHaveBeenCalled();
        expect(rejectedRequest.append).not.toHaveBeenCalled();

        const rejectedResponse: any = publishingHarness();
        await expect(rejectedResponse.application.execute(
          publishingCommand(validClosedSchema(), clone(schema)),
          publisherSubject()
        )).rejects.toMatchObject({
          code: "upstream_publishing_schema_invalid",
          statusCode: 400
        });
        expect(rejectedResponse.commitManifestSet).not.toHaveBeenCalled();
        expect(rejectedResponse.append).not.toHaveBeenCalled();
      }
    });

    expect(dynamicRegExpInvocations).toBe(0);
  });
});
