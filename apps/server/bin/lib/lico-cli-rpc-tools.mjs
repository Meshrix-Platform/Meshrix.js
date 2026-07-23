import {
  buildApiPathForCliOperation,
  findCliOperation,
  formatInterfaceCatalogMarkdown,
  listInterfaceCatalog
} from "#lico/operation-registry";
import {
  applyCommonSafetyFlags,
  applyCommonSafetyHeaders,
  buildBodyFromCliParams,
  readBody,
  readHeaders,
  readHttpPayload,
  readRpcParams,
  requestJson,
  requestRaw,
  requireValue,
  writeResponse
} from "./lico-cli-common.mjs";

export async function runRpc(args) {
  const method = String(args.method || args.m || "GET").toUpperCase();
  const apiPath = normalizeApiPath(requireValue(args, "path"));
  const { body, headers } = await readHttpPayload(args, method);
  const { response, buffer } = await requestRaw({
    serverUrl: args["server-url"],
    method,
    apiPath,
    body,
    headers,
    binary: Boolean(args.output)
  });
  const contentType = response.headers.get("content-type") || "";

  if (/json/i.test(contentType)) {
    await writeResponse({
      args,
      result: JSON.parse(buffer.toString("utf8") || "{}"),
      rawBuffer: args.output ? buffer : null,
      contentType
    });
    return;
  }

  await writeResponse({
    args,
    result: {},
    rawBuffer: buffer,
    contentType
  });
}

export async function runServerRpcCall(args) {
  const rpcMethod = args["rpc-method"] || args._[1];
  if (!rpcMethod || rpcMethod === true) {
    throw new Error("rpc-call requires a RPC method, for example: lico rpc-call jobs.list");
  }
  const params = applyCommonSafetyFlags(args, await readRpcParams(args));
  const result = await requestJson({
    serverUrl: args["server-url"],
    method: "POST",
    apiPath: "/api/rpc",
    headers: applyCommonSafetyHeaders(args, readHeaders(args)),
    body: {
      jsonrpc: "2.0",
      id: args.id || Date.now(),
      method: String(rpcMethod),
      params
    }
  });
  await writeResponse({ args, result });
}

function toolIdArg(args) {
  return String(args["tool-id"] || args.toolId || args.id || args._[2] || "").trim();
}

export async function runToolsCommand(args) {
  const command = String(args._[1] || "catalog");
  const subcommand = String(args._[2] || "");
  if (command === "catalog") {
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "GET",
        apiPath: "/api/operation-permission/v1/catalog",
        headers: readHeaders(args)
      })
    });
    return;
  }
  if (command === "toolsets") {
    if (subcommand === "resolve") {
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "POST",
          apiPath: "/api/operation-permission/v1/toolsets/resolve",
          headers: applyCommonSafetyHeaders(args, readHeaders(args)),
          body: await readBody(args)
        })
      });
      return;
    }
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "GET",
        apiPath: "/api/operation-permission/v1/toolsets",
        headers: readHeaders(args)
      })
    });
    return;
  }
  if (command === "profiles") {
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "GET",
        apiPath: "/api/operation-permission/v1/profiles",
        headers: readHeaders(args)
      })
    });
    return;
  }
  if (command === "execute" || command === "dry-run") {
    const body = await readBody(args);
    const toolId = String(body.toolId || toolIdArg(args));
    if (!toolId) {
      throw new Error("tools execute requires --tool-id or body.toolId");
    }
    const { toolId: _toolId, schemaVersion: _schemaVersion, context = {}, dryRun = false, input: explicitInput, ...inlineInput } = body;
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "POST",
        apiPath: command === "dry-run" ? "/api/operation-permission/v1/dry-run" : "/api/operation-permission/v1/execute",
        headers: readHeaders(args),
        body: {
          schemaVersion: "v0.0.1:schema:definition-1",
          ...body,
          toolId,
          context,
          dryRun,
          input: explicitInput || inlineInput
        }
      })
    });
    return;
  }
  if (command === "audit") {
    const query = new URLSearchParams();
    if (args.limit) {
      query.set("limit", String(args.limit));
    }
    if (args["tool-id"] || args.toolId) {
      query.set("toolId", String(args["tool-id"] || args.toolId));
    }
    if (args["grant-id"] || args.grantId) {
      query.set("grantId", String(args["grant-id"] || args.grantId));
    }
    if (args.status) {
      query.set("status", String(args.status));
    }
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "GET",
        apiPath: `/api/operation-permission/v1/audit${query.toString() ? `?${query}` : ""}`,
        headers: readHeaders(args)
      })
    });
    return;
  }
  if (command === "metrics") {
    if (subcommand === "export") {
      const query = new URLSearchParams();
      if (args.limit) {
        query.set("limit", String(args.limit));
      }
      if (args.since) {
        query.set("since", String(args.since));
      }
      if (args.until) {
        query.set("until", String(args.until));
      }
      if (args.kind) {
        query.set("kind", String(args.kind));
      }
      if (args["tool-id"] || args.toolId) {
        query.set("toolId", String(args["tool-id"] || args.toolId));
      }
      if (args["grant-id"] || args.grantId) {
        query.set("grantId", String(args["grant-id"] || args.grantId));
      }
      if (args["profile-id"] || args.profileId) {
        query.set("profileId", String(args["profile-id"] || args.profileId));
      }
      if (args.route) {
        query.set("route", String(args.route));
      }
      if (args.transport) {
        query.set("transport", String(args.transport));
      }
      if (args.status) {
        query.set("status", String(args.status));
      }
      if (args["status-code"] || args.statusCode) {
        query.set("statusCode", String(args["status-code"] || args.statusCode));
      }
      if (args["completion-status"] || args.completionStatus) {
        query.set("completionStatus", String(args["completion-status"] || args.completionStatus));
      }
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "GET",
          apiPath: `/api/operation-permission/v1/metrics/export${query.toString() ? `?${query}` : ""}`,
          headers: readHeaders(args)
        })
      });
      return;
    }
    if (subcommand === "health") {
      const query = new URLSearchParams();
      if (args["window-seconds"] || args.windowSeconds) {
        query.set("windowSeconds", String(args["window-seconds"] || args.windowSeconds));
      }
      if (args["max-request-error-rate"] || args.maxRequestErrorRate) {
        query.set("maxRequestErrorRate", String(args["max-request-error-rate"] || args.maxRequestErrorRate));
      }
      if (args["max-tool-failure-rate"] || args.maxToolFailureRate) {
        query.set("maxToolFailureRate", String(args["max-tool-failure-rate"] || args.maxToolFailureRate));
      }
      if (args["max-denied-rate"] || args.maxDeniedRate) {
        query.set("maxDeniedRate", String(args["max-denied-rate"] || args.maxDeniedRate));
      }
      if (args["max-request-p95-ms"] || args.maxRequestP95Ms) {
        query.set("maxRequestP95Ms", String(args["max-request-p95-ms"] || args.maxRequestP95Ms));
      }
      if (args["max-tool-p95-ms"] || args.maxToolP95Ms) {
        query.set("maxToolP95Ms", String(args["max-tool-p95-ms"] || args.maxToolP95Ms));
      }
      if (args["min-requests"] || args.minRequests) {
        query.set("minRequests", String(args["min-requests"] || args.minRequests));
      }
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "GET",
          apiPath: `/api/operation-permission/v1/metrics/health${query.toString() ? `?${query}` : ""}`,
          headers: readHeaders(args)
        })
      });
      return;
    }
    if (subcommand === "prometheus") {
      const query = new URLSearchParams();
      if (args["window-seconds"] || args.windowSeconds) {
        query.set("windowSeconds", String(args["window-seconds"] || args.windowSeconds));
      }
      if (args["max-request-error-rate"] || args.maxRequestErrorRate) {
        query.set("maxRequestErrorRate", String(args["max-request-error-rate"] || args.maxRequestErrorRate));
      }
      if (args["max-tool-failure-rate"] || args.maxToolFailureRate) {
        query.set("maxToolFailureRate", String(args["max-tool-failure-rate"] || args.maxToolFailureRate));
      }
      if (args["max-denied-rate"] || args.maxDeniedRate) {
        query.set("maxDeniedRate", String(args["max-denied-rate"] || args.maxDeniedRate));
      }
      if (args["max-request-p95-ms"] || args.maxRequestP95Ms) {
        query.set("maxRequestP95Ms", String(args["max-request-p95-ms"] || args.maxRequestP95Ms));
      }
      if (args["max-tool-p95-ms"] || args.maxToolP95Ms) {
        query.set("maxToolP95Ms", String(args["max-tool-p95-ms"] || args.maxToolP95Ms));
      }
      if (args["min-requests"] || args.minRequests) {
        query.set("minRequests", String(args["min-requests"] || args.minRequests));
      }
      const { response, buffer } = await requestRaw({
        serverUrl: args["server-url"],
        method: "GET",
        apiPath: `/api/operation-permission/v1/metrics/prometheus${query.toString() ? `?${query}` : ""}`,
        headers: readHeaders(args),
        binary: true
      });
      await writeResponse({
        args,
        result: {},
        rawBuffer: buffer,
        contentType: response.headers.get("content-type") || ""
      });
      return;
    }
    if (subcommand === "storage") {
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "GET",
          apiPath: "/api/operation-permission/v1/metrics/storage",
          headers: readHeaders(args)
        })
      });
      return;
    }
    if (subcommand === "prune") {
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "POST",
          apiPath: "/api/operation-permission/v1/metrics/prune",
          headers: applyCommonSafetyHeaders(args, readHeaders(args)),
          body: await readBody(args)
        })
      });
      return;
    }
    const query = new URLSearchParams();
    if (args.limit) {
      query.set("limit", String(args.limit));
    }
    if (args.since) {
      query.set("since", String(args.since));
    }
    if (args.until) {
      query.set("until", String(args.until));
    }
    if (args["tool-id"] || args.toolId) {
      query.set("toolId", String(args["tool-id"] || args.toolId));
    }
    if (args["grant-id"] || args.grantId) {
      query.set("grantId", String(args["grant-id"] || args.grantId));
    }
    if (args["profile-id"] || args.profileId) {
      query.set("profileId", String(args["profile-id"] || args.profileId));
    }
    if (args.route) {
      query.set("route", String(args.route));
    }
    if (args.transport) {
      query.set("transport", String(args.transport));
    }
    if (args.status) {
      query.set("status", String(args.status));
    }
    if (args["status-code"] || args.statusCode) {
      query.set("statusCode", String(args["status-code"] || args.statusCode));
    }
    if (args["completion-status"] || args.completionStatus) {
      query.set("completionStatus", String(args["completion-status"] || args.completionStatus));
    }
    if (args["bucket-seconds"] || args.bucketSeconds) {
      query.set("bucketSeconds", String(args["bucket-seconds"] || args.bucketSeconds));
    }
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "GET",
        apiPath: `/api/operation-permission/v1/metrics/summary${query.toString() ? `?${query}` : ""}`,
        headers: readHeaders(args)
      })
    });
    return;
  }
  if (command === "grants") {
    if (!subcommand || subcommand === "list") {
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "GET",
          apiPath: "/api/operation-permission/v1/grants",
          headers: readHeaders(args)
        })
      });
      return;
    }
    if (subcommand === "create") {
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "POST",
          apiPath: "/api/operation-permission/v1/grants",
          headers: applyCommonSafetyHeaders(args, readHeaders(args)),
          body: await readBody(args)
        })
      });
      return;
    }
    if (subcommand === "rotate" || subcommand === "revoke") {
      const grantId = String(args["grant-id"] || args.grantId || args.id || args._[3] || "").trim();
      if (!grantId) {
        throw new Error(`tools grants ${subcommand} requires --id GRANT_ID`);
      }
      await writeResponse({
        args,
        result: await requestJson({
          serverUrl: args["server-url"],
          method: "POST",
          apiPath: `/api/operation-permission/v1/grants/${encodeURIComponent(grantId)}/${subcommand}`,
          headers: applyCommonSafetyHeaders(args, readHeaders(args)),
          body: subcommand === "revoke" ? await readBody(args) : {}
        })
      });
      return;
    }
  }
  if (command === "policy" && subcommand === "preview") {
    await writeResponse({
      args,
      result: await requestJson({
        serverUrl: args["server-url"],
        method: "POST",
        apiPath: "/api/operation-permission/v1/policy/preview",
        headers: applyCommonSafetyHeaders(args, readHeaders(args)),
        body: await readBody(args)
      })
    });
    return;
  }
  throw new Error(`未知 tools 命令：${args._.join(" ")}`);
}

async function getActiveCliOperations(args = {}) {
  const payload = await requestJson({
    serverUrl: args["server-url"],
    method: "GET",
    apiPath: "/api/interfaces",
    headers: readHeaders(args)
  });
  const interfaces = Array.isArray(payload?.interfaces) ? payload.interfaces : [];
  return interfaces.map((entry) => ({
    id: entry.id,
    feature: entry.feature,
    label: entry.label,
    description: entry.description || entry.label || entry.id,
    target: entry.targetBinding,
    http: entry.httpBinding,
    rpc: entry.rpcBinding,
    cli: entry.cliBinding,
    requiredScopes: entry.requiredScopes || [],
    inputSchema: entry.inputSchema || { type: "object", additionalProperties: true },
    safety: entry.safety || {},
    audit: entry.audit || {},
    log: entry.log || {},
    readOnly: entry.readOnly === true,
    destructive: entry.destructive === true,
    concurrencySafe: entry.concurrencySafe === true,
    public: entry.public === true,
    externalAuth: entry.externalAuth === true,
    binary: entry.binary === true
  })).filter((operation) => operation.cli?.command?.length > 0);
}

function writeLocalInterfaceCatalog(args, operations) {
  if (String(args.format || "").toLowerCase() === "markdown") {
    process.stdout.write(`${formatInterfaceCatalogMarkdown(operations)}\n`);
    return true;
  }
  if (args.local) {
    process.stdout.write(`${JSON.stringify({ interfaces: listInterfaceCatalog(operations) }, null, 2)}\n`);
    return true;
  }
  return false;
}

export async function runNamedRpc(args, { usage = () => "" } = {}) {
  if (args._[0] === "interfaces" && writeLocalInterfaceCatalog(args)) {
    return;
  }
  const activeOperations = await getActiveCliOperations(args);
  const cliMatch = findCliOperation(args._, activeOperations);
  if (!cliMatch) {
    throw new Error(`未知命令：${args._[0] || ""}\n${usage()}`);
  }
  const operation = cliMatch.operation;
  if (operation.id === "system.interfaces" && writeLocalInterfaceCatalog(args, activeOperations)) {
    return;
  }

  const apiPath = buildApiPathForCliOperation(operation, args);
  let body;
  let headers = applyCommonSafetyHeaders(args, readHeaders(args));
  if (operation.http.method !== "GET" && operation.http.method !== "HEAD") {
    const cliBody = args.body === undefined && !args["body-file"]
      ? buildBodyFromCliParams(operation, args)
      : null;
    if (cliBody) {
      body = cliBody;
    } else {
      const payload = await readHttpPayload(args, operation.http.method);
      body = payload.body;
      headers = applyCommonSafetyHeaders(args, payload.headers);
    }
    body = applyCommonSafetyFlags(args, body);
  }

  const { response, buffer } = await requestRaw({
    serverUrl: args["server-url"],
    method: operation.http.method,
    apiPath,
    body,
    headers,
    binary: operation.binary || Boolean(args.output)
  });
  const contentType = response.headers.get("content-type") || "";
  if (/json/i.test(contentType)) {
    await writeResponse({
      args,
      result: JSON.parse(buffer.toString("utf8") || "{}"),
      rawBuffer: args.output ? buffer : null,
      contentType
    });
    return;
  }
  await writeResponse({ args, result: {}, rawBuffer: buffer, contentType });
}
