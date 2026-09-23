import {
  applyStructuredResponsePolicy,
  bodyMetadata,
  createResponseProjectionUnavailableError,
  responseFilteringConfigured,
  responseSchemaConfigured,
  redactStructuredValue
} from "./response-policy.ts";
import {
  UPSTREAM_GATEWAY_PROTOCOL_VERSION,
  asArray,
  object,
  stableJson,
  text
} from "./support.ts";
import { createIsolatedSchemaValidator, GatewaySchemaError } from "@meshrix/gateway/schema";
import { createForwardAbortContext } from "./registry-lifecycle.ts";

function parseJsonText(value: any = "") : any {
  const raw: any = String(value || "").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mcpPolicyTarget(result: Record<string, any> = {}) : any {
  const source: any = object(result);
  if (Object.prototype.hasOwnProperty.call(source, "structuredContent")) {
    return { kind: "structured", value: source.structuredContent };
  }
  const content: any = asArray(source.content);
  if (content.length === 1 && content[0]?.type === "text") {
    const parsed: any = parseJsonText(content[0].text);
    if (parsed !== undefined) {
      return { kind: "json-text", value: parsed };
    }
  }
  return { kind: "result", value: source };
}

function redactJsonTextBlocks(content: any = [], sensitiveBodyFields: any = []) : any {
  return asArray(content).map((block?: any) : any => {
    if (block?.type !== "text") {
      return redactStructuredValue(block, sensitiveBodyFields);
    }
    const parsed: any = parseJsonText(block.text);
    return parsed === undefined
      ? { ...block }
      : {
          ...block,
          text: JSON.stringify(redactStructuredValue(parsed, sensitiveBodyFields))
        };
  });
}

function prepareFilterableMcpResult(result: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  const source: any = object(result);
  if (!responseFilteringConfigured(operation) || !Array.isArray(source.content)) {
    return source;
  }
  return {
    ...source,
    content: source.content.map((block?: any) : any => {
      if (block?.type !== "text") {
        return redactStructuredValue(block, operation.sensitiveBodyFields);
      }
      const parsed: any = parseJsonText(block.text);
      if (parsed === undefined) {
        throw createResponseProjectionUnavailableError(
          "Upstream MCP text response is not valid JSON."
        );
      }
      return {
        ...block,
        text: JSON.stringify(redactStructuredValue(parsed, operation.sensitiveBodyFields))
      };
    })
  };
}

export function publicMcpResult(result: Record<string, any> = {}, operation: Record<string, any> = {}) : any {
  const source: any = prepareFilterableMcpResult(result, operation);
  if (!responseFilteringConfigured(operation) && !responseSchemaConfigured(operation.responseSchema)) {
    return {
      result: source,
      schemaValidated: false,
      projectionValidated: false
    };
  }
  const target: any = mcpPolicyTarget(source);
  const policy: any = applyStructuredResponsePolicy(target.value, operation);
  const publicFieldsConfigured: any = asArray(operation.publicResponseFields).length > 0;
  if (target.kind === "result") {
    return {
      result: policy.publicValue,
      schemaValidated: policy.schemaValidated,
      projectionValidated: policy.projectionValidated
    };
  }
  const output: any = redactStructuredValue(source, operation.sensitiveBodyFields);
  if (target.kind === "structured") {
    output.structuredContent = policy.publicValue;
  }
  if (publicFieldsConfigured || target.kind === "json-text") {
    output.content = [{ type: "text", text: JSON.stringify(policy.publicValue) }];
  } else if (Array.isArray(source.content)) {
    output.content = redactJsonTextBlocks(source.content, operation.sensitiveBodyFields);
  }
  return {
    result: output,
    schemaValidated: policy.schemaValidated,
    projectionValidated: policy.projectionValidated
  };
}

function safeFailure(error?: any, abortContext: any = null) : any {
  const authorityCode: any = text(error?.code);
  const internalReasonCode: any = text(error?.reasonCode) || (/^upstream_final_effect_[a-z0-9_]+$/u.test(authorityCode) ? authorityCode : "");
  const callerAborted: any = abortContext?.callerAborted?.() === true ||
    internalReasonCode === "upstream_mcp_cancelled";
  const timedOut: any = !callerAborted && (
    internalReasonCode === "upstream_mcp_timeout" ||
    abortContext?.timedOut?.() === true ||
    error?.name === "AbortError" ||
    /timed out/iu.test(String(error?.message || ""))
  );
  return {
    status: callerAborted ? 499 : timedOut ? 504 : Number(error?.status || error?.statusCode || 502),
    reasonCode: internalReasonCode || (
      callerAborted
        ? "upstream_mcp_cancelled"
        : timedOut
          ? "upstream_mcp_timeout"
          : "upstream_mcp_call_failed"
    ),
    message: callerAborted
      ? "Upstream MCP request was cancelled."
      : timedOut
        ? "Upstream MCP request timed out."
        : "Upstream MCP forwarding failed."
  };
}

/** Console response policy/audit adapter; protocol execution belongs solely to invokeTypedMcp. */
export function createMcpExecutionAdapter({
  appendAudit,
  invokeTypedMcp,
  claimMcpProtectedSink,
  persist,
  publicEndpoint,
  recordEndpointOutcome,
  recordMetric
}: Record<string, any>) : any {
  if (typeof invokeTypedMcp !== "function" || typeof claimMcpProtectedSink !== "function") {
    throw new TypeError("Upstream MCP adapter requires the configured typed transport.");
  }
  return async function recordMcpExecution(service?: any, operation?: any, input: Record<string, any> = {}, endpoint: any = null, options: Record<string, any> = {}) : Promise<any> {
    const startedAt: any = Date.now();
    const upstreamToolName: any = text(
      input.toolName ||
        input.name ||
        input.mcpTool ||
        input.upstreamToolName ||
        operation.toolName ||
        (operation.operationKey !== "tools/call" ? operation.operationKey : "")
    );
    if (!upstreamToolName) {
      throw Object.assign(new Error("Upstream MCP forwarding requires toolName."), { status: 400 });
    }
    const toolArguments: any = object(
      input.arguments ||
        input.args ||
        input.input ||
        input.body ||
        input.payload ||
        {}
    );
    if (operation.inputSchema !== undefined) {
      const validator = createIsolatedSchemaValidator();
      try { await validator.compile(operation.inputSchema).assertValid(toolArguments, options.signal); }
      catch (error) {
        if (!(error instanceof GatewaySchemaError) || error.code !== "schema_validation_failed") throw error;
        throw Object.assign(new Error("Upstream MCP tool arguments do not match the advertised input schema."), { status: 400, reasonCode: "upstream_mcp_arguments_invalid" });
      } finally { await validator.close(); }
    }
    const requestBodyMetadata: any = bodyMetadata(toolArguments, operation.sensitiveBodyFields, {
      byteLength: Buffer.byteLength(stableJson(toolArguments)),
      contentType: "application/json"
    });
    const requestedTimeoutMs: any = Number(options.timeoutMs || 0);
    const timeoutMs: any = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= 100
      ? Math.min(operation.timeoutMs, requestedTimeoutMs)
      : operation.timeoutMs;
    const abortContext: any = createForwardAbortContext(options.signal || null, timeoutMs);
    try {
      await claimMcpProtectedSink(service, operation, input, endpoint, options);
      const response: any = await invokeTypedMcp(service, operation, {
        name: upstreamToolName, arguments: toolArguments,
        ...(input.inputResponses === undefined ? {} : { inputResponses: input.inputResponses }),
        ...(input.requestState === undefined ? {} : { requestState: input.requestState })
      }, { ...options, signal: abortContext.signal, requestState: input.requestState ?? options.requestState });
      if (response.httpFailure) throw Object.assign(new Error("Upstream MCP peer returned HTTP failure."), { status: response.httpFailure.status, reasonCode: "upstream_mcp_call_failed" });
      const responseBytes: any = Buffer.byteLength(stableJson(response.result || {}));
      if (responseBytes > operation.responseMaxBytes) {
        recordMetric({ serviceId: service.serviceId, statusCode: 502, failed: true });
        const audit: any = appendAudit("upstream.mcp.call.rejected", {
          serviceId: service.serviceId,
          operationKey: operation.operationKey,
          upstreamToolName,
          protocol: "mcp",
          endpoint: publicEndpoint(endpoint),
          reason: "response_too_large",
          requestBody: requestBodyMetadata,
          responseBytes,
          limitBytes: operation.responseMaxBytes,
          durationMs: Date.now() - startedAt
        });
        persist();
        throw Object.assign(new Error("Upstream MCP response exceeds configured limit."), {
          status: 502,
          audit
        });
      }
      const publicResponse: any = publicMcpResult(response.result || {}, operation);
      const responseBodyMetadata: any = bodyMetadata(
        publicResponse.result,
        operation.sensitiveBodyFields,
        {
          byteLength: Buffer.byteLength(stableJson(publicResponse.result)),
          contentType: "application/json"
        }
      );
      recordEndpointOutcome(service, operation, endpoint, {
        statusCode: 200,
        ok: true
      });
      const audit: any = appendAudit("upstream.mcp.call.completed", {
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        upstreamToolName,
        protocol: "mcp",
        endpoint: publicEndpoint(endpoint),
        requestBody: requestBodyMetadata,
        responseBody: responseBodyMetadata,
        responsePolicy: {
          schemaValidated: publicResponse.schemaValidated,
          projectionValidated: publicResponse.projectionValidated,
          publicFieldCount: asArray(operation.publicResponseFields).length
        },
        responseBytes,
        durationMs: Date.now() - startedAt
      });
      recordMetric({ serviceId: service.serviceId, statusCode: 200, failed: false });
      persist();
      return {
        protocolVersion: UPSTREAM_GATEWAY_PROTOCOL_VERSION,
        ok: true,
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        dynamicCapability: operation.dynamicCapability,
        upstream: {
          protocol: "mcp",
          toolName: upstreamToolName,
          responseBytes,
          durationMs: Date.now() - startedAt
        },
        response: publicResponse.result,
        auditId: audit.auditId
      };
    } catch (error: any) {
      const failure: any = safeFailure(error, abortContext);
      const status: any = failure.status;
      recordEndpointOutcome(service, operation, endpoint, {
        statusCode: status,
        ok: false
      });
      recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
      const audit: any = error?.audit || appendAudit("upstream.mcp.call.failed", {
        serviceId: service.serviceId,
        operationKey: operation.operationKey,
        upstreamToolName,
        protocol: "mcp",
        endpoint: publicEndpoint(endpoint),
        requestBody: requestBodyMetadata,
        reasonCode: failure.reasonCode,
        durationMs: Date.now() - startedAt
      });
      persist();
      throw Object.assign(new Error(failure.message), {
        status,
        reasonCode: failure.reasonCode,
        audit
      });
    } finally {
      abortContext.dispose();
    }
  };
}
