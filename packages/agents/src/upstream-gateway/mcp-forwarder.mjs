import {
  applyStructuredResponsePolicy,
  bodyMetadata,
  createResponseProjectionUnavailableError,
  responseFilteringConfigured,
  redactStructuredValue
} from "./response-policy.mjs";
import {
  UPSTREAM_GATEWAY_PROTOCOL_VERSION,
  asArray,
  object,
  stableJson,
  text
} from "./support.mjs";

function parseJsonText(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function mcpPolicyTarget(result = {}) {
  const source = object(result);
  if (Object.prototype.hasOwnProperty.call(source, "structuredContent")) {
    return { kind: "structured", value: source.structuredContent };
  }
  const content = asArray(source.content);
  if (content.length === 1 && content[0]?.type === "text") {
    const parsed = parseJsonText(content[0].text);
    if (parsed !== undefined) {
      return { kind: "json-text", value: parsed };
    }
  }
  return { kind: "result", value: source };
}

function redactJsonTextBlocks(content = [], sensitiveBodyFields = []) {
  return asArray(content).map((block) => {
    if (block?.type !== "text") {
      return redactStructuredValue(block, sensitiveBodyFields);
    }
    const parsed = parseJsonText(block.text);
    return parsed === undefined
      ? { ...block }
      : {
          ...block,
          text: JSON.stringify(redactStructuredValue(parsed, sensitiveBodyFields))
        };
  });
}

function prepareFilterableMcpResult(result = {}, operation = {}) {
  const source = object(result);
  if (!responseFilteringConfigured(operation) || !Array.isArray(source.content)) {
    return source;
  }
  return {
    ...source,
    content: source.content.map((block) => {
      if (block?.type !== "text") {
        return redactStructuredValue(block, operation.sensitiveBodyFields);
      }
      const parsed = parseJsonText(block.text);
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

function publicMcpResult(result = {}, operation = {}) {
  const source = prepareFilterableMcpResult(result, operation);
  const target = mcpPolicyTarget(source);
  const policy = applyStructuredResponsePolicy(target.value, operation);
  const publicFieldsConfigured = asArray(operation.publicResponseFields).length > 0;
  if (target.kind === "result") {
    return {
      result: policy.publicValue,
      schemaValidated: policy.schemaValidated,
      projectionValidated: policy.projectionValidated
    };
  }
  const output = redactStructuredValue(source, operation.sensitiveBodyFields);
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

function createAbortContext(parentSignal = null, timeoutMs = 0) {
  if (
    parentSignal !== null &&
    parentSignal !== undefined &&
    (
      typeof parentSignal.aborted !== "boolean" ||
      typeof parentSignal.addEventListener !== "function" ||
      typeof parentSignal.removeEventListener !== "function"
    )
  ) {
    throw new TypeError("Upstream MCP caller signal must be an AbortSignal.");
  }
  const controller = new AbortController();
  let callerAborted = false;
  let timedOut = false;
  const abortFromCaller = () => {
    if (controller.signal.aborted) return;
    callerAborted = true;
    controller.abort();
  };
  if (parentSignal?.aborted) {
    abortFromCaller();
  } else {
    parentSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
  const timeout = setTimeout(() => {
    if (controller.signal.aborted) return;
    timedOut = true;
    controller.abort();
  }, Math.max(1, Number(timeoutMs || 1)));
  timeout.unref?.();
  return {
    signal: controller.signal,
    callerAborted: () => callerAborted,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timeout);
      parentSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

function safeFailure(error, abortContext = null) {
  const internalReasonCode = text(error?.reasonCode);
  const callerAborted = abortContext?.callerAborted?.() === true ||
    internalReasonCode === "upstream_mcp_cancelled";
  const timedOut = !callerAborted && (
    internalReasonCode === "upstream_mcp_timeout" ||
    abortContext?.timedOut?.() === true ||
    error?.name === "AbortError" ||
    /timed out/iu.test(String(error?.message || ""))
  );
  return {
    status: callerAborted ? 499 : timedOut ? 504 : Number(error?.status || 502),
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

export function createMcpForwarder({
  appendAudit,
  mcpSessionManager,
  mcpServiceConfigWithCredentials,
  persist,
  publicEndpoint,
  recordEndpointOutcome,
  recordMetric
}) {
  if (!mcpSessionManager || typeof mcpSessionManager.callTool !== "function") {
    throw new TypeError("Upstream MCP forwarder requires a session manager.");
  }
  return async function forwardMcp(service, operation, input = {}, endpoint = null, options = {}) {
    const startedAt = Date.now();
    const upstreamToolName = text(
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
    const toolArguments = object(
      input.arguments ||
        input.args ||
        input.input ||
        input.body ||
        input.payload ||
        {}
    );
    const requestBodyMetadata = bodyMetadata(toolArguments, operation.sensitiveBodyFields, {
      byteLength: Buffer.byteLength(stableJson(toolArguments)),
      contentType: "application/json"
    });
    const requestedTimeoutMs = Number(options.timeoutMs || 0);
    const timeoutMs = Number.isSafeInteger(requestedTimeoutMs) && requestedTimeoutMs >= 100
      ? Math.min(operation.timeoutMs, requestedTimeoutMs)
      : operation.timeoutMs;
    const abortContext = createAbortContext(options.signal || null, timeoutMs);
    try {
      const response = await mcpSessionManager.callTool(
        await mcpServiceConfigWithCredentials(service, operation),
        {
          name: upstreamToolName,
          arguments: toolArguments
        },
        {
          signal: abortContext.signal,
          onNotification: options.onNotification || null
        }
      );
      const responseBytes = Buffer.byteLength(stableJson(response.result || {}));
      if (responseBytes > operation.responseMaxBytes) {
        recordMetric({ serviceId: service.serviceId, statusCode: 502, failed: true });
        const audit = appendAudit("upstream.mcp.call.rejected", {
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
      const publicResponse = publicMcpResult(response.result || {}, operation);
      const responseBodyMetadata = bodyMetadata(
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
      const audit = appendAudit("upstream.mcp.call.completed", {
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
    } catch (error) {
      const failure = safeFailure(error, abortContext);
      const status = failure.status;
      recordEndpointOutcome(service, operation, endpoint, {
        statusCode: status,
        ok: false
      });
      recordMetric({ serviceId: service.serviceId, statusCode: status, failed: true });
      const audit = error?.audit || appendAudit("upstream.mcp.call.failed", {
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
