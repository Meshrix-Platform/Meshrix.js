import fs from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  MODEL_GATEWAY_CALL_OPERATION_ID,
  MODEL_GATEWAY_MESHRIX_PERMIT_NEVER_SERVICE_AUTHORITY,
  MODEL_GATEWAY_MODEL_OPERATION_IDS,
  assertModelGatewayCallRequest,
  isModelGatewayOperationId
} from "@meshrix/contracts/model-gateway/client-port";
import {
  MODEL_GATEWAY_ADAPTER_STATELESS,
  assertModelGatewayAdapterConfig,
  createDefaultDisabledModelGatewayAdapterConfig,
  isModelGatewayAdapterConfig
} from "@meshrix/contracts/model-gateway/adapter-config";
const canned1 = "idem-1";
const canned2 = "idem-too-long";
const canned3 = "idem-2";




interface OpenApiOperation {
  parameters?: readonly unknown[];
  responses: Record<string, {
    content: Record<string, { schema: { $ref: string } }>;
  }>;
}

interface OpenApiSchema {
  additionalProperties?: boolean;
  $ref?: string;
  const?: string;
  description?: string;
  enum?: string[];
  oneOf?: OpenApiSchema[];
  properties?: Record<string, OpenApiSchema>;
  items?: OpenApiSchema;
  type?: string;
}

interface OpenApiContract {
  openapi: string;
  info: { version: string; title: string };
  paths: Record<string, { post?: OpenApiOperation }>;
  components: {
    securitySchemes: Record<string, unknown>;
    schemas: Record<string, OpenApiSchema>;
  };
}

async function readServiceContract(): Promise<OpenApiContract> {
  const url = new URL(
    "../../../services/model-gateway/contracts/openapi.json",
    import.meta.url
  );
  return JSON.parse(await fs.readFile(url, "utf8")) as OpenApiContract;
}

describe("Model Gateway Service wire contract", () => {
  it("is a versioned, language-neutral HTTP and JSON contract", async () => {
    const contract = await readServiceContract();
    expect(contract.openapi).toBe("3.1.0");
    expect(contract.info.version).toBe("v1");
    expect(contract.info.title).toContain("Model Gateway");
    expect(contract.components.securitySchemes["bearerAuth"]).toMatchObject({
      type: "http",
      scheme: "bearer"
    });
  });

  it("uses OpenAI and Anthropic endpoint paths without a Meshrix translation endpoint", async () => {
    const contract = await readServiceContract();
    const paths: string[] = Object.keys(contract.paths);
    for (const required of [
      "/health",
      "/ready",
      "/v1/chat/completions",
      "/v1/messages",
      "/v1/models",
      "/v1/models/{model_id}"
    ]) {
      expect(paths).toContain(required);
    }
    expect(paths.some((entry) => entry.includes("translate"))).toBe(false);
    expect(paths.some((entry) => entry.includes("meshrix-only"))).toBe(false);

    const openAi = contract.paths["/v1/chat/completions"].post;
    expect(openAi).toBeDefined();
    expect(contract.components.securitySchemes["bearerAuth"]).toMatchObject({
      type: "http",
      scheme: "bearer"
    });
    expect(openAi?.responses["200"].content).toHaveProperty("text/event-stream");
    expect(openAi?.responses["default"].content["application/json"].schema.$ref)
      .toContain("OpenAiError");

    const anthropic = contract.paths["/v1/messages"].post;
    expect(anthropic).toBeDefined();
    expect(contract.components.securitySchemes["anthropicApiKey"]).toMatchObject({
      type: "apiKey",
      in: "header",
      name: "x-api-key"
    });
    expect(anthropic?.parameters).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "anthropic-version", in: "header", required: true })
    ]));
    expect(anthropic?.responses["200"].content).toHaveProperty("text/event-stream");
    expect(anthropic?.responses["default"].content["application/json"].schema.$ref)
      .toContain("AnthropicError");
  });

  it("closes native request schemas over priced text and client-executed tools", async () => {
    const contract = await readServiceContract();
    const openAi = contract.components.schemas.OpenAiChatCompletionsRequest;
    const anthropic = contract.components.schemas.AnthropicMessagesRequest;
    expect(openAi.additionalProperties).toBe(false);
    expect(anthropic.additionalProperties).toBe(false);
    expect(openAi.properties?.messages?.items?.additionalProperties).toBe(false);
    expect(anthropic.properties?.messages?.items?.additionalProperties).toBe(false);
    expect(openAi.properties?.messages?.items?.properties?.content?.oneOf?.map((schema) => schema.type))
      .toEqual(["string", "null"]);
    expect(openAi.properties?.messages?.items?.properties?.tool_calls?.items?.properties?.function)
      .toMatchObject({ additionalProperties: false });
    const anthropicBlocks = anthropic.properties?.messages?.items?.properties?.content?.oneOf?.[1]
      ?.items?.oneOf?.map((schema) => schema.$ref);
    expect(anthropicBlocks).toEqual(expect.arrayContaining([
      "#/components/schemas/AnthropicTextBlock",
      "#/components/schemas/AnthropicToolUseBlock",
      "#/components/schemas/AnthropicToolResultBlock"
    ]));
    expect(anthropicBlocks).not.toContain("#/components/schemas/AnthropicImageBlock");
    expect(Object.keys(openAi.properties ?? {})).toEqual(expect.arrayContaining([
      "messages",
      "max_completion_tokens",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "response_format"
    ]));
    expect(Object.keys(anthropic.properties ?? {})).toEqual(expect.arrayContaining([
      "messages",
      "max_tokens",
      "system",
      "tools",
      "tool_choice"
    ]));
    for (const unsupported of ["modalities", "audio", "service_tier", "web_search_options", "prompt_cache_retention", "mcp_servers"]) {
      expect(openAi.properties ?? {}).not.toHaveProperty(unsupported);
      expect(anthropic.properties ?? {}).not.toHaveProperty(unsupported);
    }
    expect(contract.paths["/v1/messages"].post?.parameters ?? []).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "anthropic-beta" })])
    );
    expect(contract.paths["/v1/chat/completions"].post?.parameters ?? []).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "x-client-request-id", in: "header" })])
    );
    const pricing = contract.components.schemas.PricingRevision;
    const description = (pricing.properties?.inputTokenRate?.description ?? "") + " " +
      (pricing.properties?.outputTokenRate?.description ?? "");
    expect(description).toContain("operator-supplied ceiling");
    expect(description).toContain("not verified against provider pricing");
    expect(description).toContain("invoice totals");
    expect(description).toContain("automatic prompt-cache writes");
    expect(contract.components.schemas.AnthropicToolResultBlock.properties?.content?.oneOf?.map((schema) => schema.type))
      .toEqual(["string", "array"]);
  });

  it("closes over admission, pricing, cancellation, ledger, and stable errors", async () => {
    const contract = await readServiceContract();
    const schemas = contract.components.schemas;
    expect(schemas["AdmissionPolicy"]).toMatchObject({
      required: expect.arrayContaining([
        "maxRatePerSecond",
        "maxInputTokenBudget",
        "maxRequestedOutputTokenBudget",
        "maxTotalTokenQuota",
        "maxConcurrentCalls",
        "maxCostQuota"
      ])
    });
    expect(schemas["PricingRevision"]).toMatchObject({ properties: { immutable: { const: true } } });
    expect(schemas["CallLedger"]).toMatchObject({
      properties: { state: { $ref: expect.stringContaining("CallLedgerState") } }
    });
    expect(schemas["CallLedgerState"]).toMatchObject({ enum: ["released", "settled", "in_doubt"] });
    expect(schemas["FixedPointAmount"]).toMatchObject({ required: ["currency", "units", "nanos"] });
    expect(schemas["StableError"]).toMatchObject({ additionalProperties: false });
    expect(Object.keys(contract.paths)).toEqual(
      expect.arrayContaining([
        "/v1/model-gateway/calls/{call_id}/cancel",
        "/v1/model-gateway/ledger/{call_id}",
        "/v1/model-gateway/pricing-revisions"
      ])
    );
  });
});

describe("Meshrix ModelGatewayClientPort and adapter", () => {
  it("freezes model_gateway.call and models.* operation identities", () => {
    expect(MODEL_GATEWAY_CALL_OPERATION_ID).toBe("model_gateway.call");
    expect(MODEL_GATEWAY_MODEL_OPERATION_IDS).toEqual(["models.list", "models.get"]);
    expect(isModelGatewayOperationId("model_gateway.call")).toBe(true);
    expect(isModelGatewayOperationId("models.get")).toBe(true);
    expect(isModelGatewayOperationId("models.custom")).toBe(true);
    expect(isModelGatewayOperationId("agent_gateway.call")).toBe(false);
  });

  it("never forwards a Meshrix permit as Service authority", () => {
    expect(MODEL_GATEWAY_MESHRIX_PERMIT_NEVER_SERVICE_AUTHORITY).toBe(true);
  });

  it("accepts a bounded idempotent call request", () => {
    const request = assertModelGatewayCallRequest({
      operationId: "model_gateway.call",
      serviceRef: "model-gateway-prod",
      modelRef: "deepseek-v4-flash",
      providerRef: "deepseek",
      inputRefs: ["in-1"],
      idempotencyKey: canned1,
      deadlineMs: 60_000,
      stream: false
    });
    expect(request.idempotencyKey).toBe("idem-1");
    expect(request.inputRefs).toEqual(["in-1"]);
    expect(() => assertModelGatewayCallRequest({
      operationId: "model_gateway.call",
      serviceRef: "model-gateway-prod",
      modelRef: "deepseek-v4-flash",
      providerRef: "deepseek",
      inputRefs: ["in-1"],
      idempotencyKey: canned2,
      deadlineMs: 2_147_483_648,
      stream: false
    })).toThrow("model_gateway_call_deadline_invalid");
    expect(() => assertModelGatewayCallRequest({
      operationId: "model_gateway.call",
      serviceRef: "model-gateway-prod",
      modelRef: "deepseek-v4-flash",
      providerRef: "deepseek",
      inputRefs: Array.from({ length: 65 }, () => "in"),
      idempotencyKey: canned3,
      deadlineMs: 60_000,
      stream: false
    })).toThrow("model_gateway_call_input_refs_bounded");
  });

  it("is default-disabled, stateless, and preserves only an optional explicit timeout", () => {
    const disabled = createDefaultDisabledModelGatewayAdapterConfig();
    expect(disabled.enabled).toBe(false);
    expect(disabled.serviceRef).toBeNull();
    expect(isModelGatewayAdapterConfig(disabled)).toBe(true);
    expect(MODEL_GATEWAY_ADAPTER_STATELESS).toBe(true);

    const enabled = assertModelGatewayAdapterConfig({
      schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
      enabled: true,
      serviceRef: "model-gateway-prod"
    });
    expect(enabled.serviceRef).toBe("model-gateway-prod");
    const configured = assertModelGatewayAdapterConfig({
      schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
      enabled: true,
      serviceRef: "model-gateway-prod",
      timeoutMs: 30_000
    });
    expect(configured.timeoutMs).toBe(30_000);
    expect(() => assertModelGatewayAdapterConfig({
      schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
      enabled: true,
      serviceRef: null
    })).toThrow("model_gateway_adapter_config_service_ref_required");
    expect(() => assertModelGatewayAdapterConfig({
      schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
      enabled: false,
      serviceRef: null,
      timeoutMs: 30_000
    })).not.toThrow();
    expect(() => assertModelGatewayAdapterConfig({
      schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
      enabled: false,
      serviceRef: null,
      timeoutMs: 120_001
    })).toThrow("model_gateway_adapter_config_timeout_invalid");
    expect(() => assertModelGatewayAdapterConfig({
      schemaVersion: "v0.0.1:model-gateway:adapter-config-1",
      enabled: false,
      serviceRef: null,
      timeoutMs: 30_000,
      endpoint: "https://example.invalid"
    })).toThrow("model_gateway_adapter_config_closed_schema");
  });
});
