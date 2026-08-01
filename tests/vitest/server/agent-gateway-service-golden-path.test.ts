import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  agentGatewayError,
  callAgentGateway,
  publicAgentGatewayRegistry
} from "../../../packages/agents/src/agent-gateway/index.ts";
import { createToolCatalog } from "../../../packages/capabilities/src/operation-permission-core/catalog.ts";
import {
  revalidateGrantForExecution
} from "../../../packages/capabilities/src/operation-permission-core/revalidate-grant-for-execution.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import {
  mcpToolForOperation,
  publicMcpTool
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter-tools.ts";
import {
  handleMeshrixMcpHttpRequest
} from "../../../packages/protocols/mcp/adapter/http-mcp-adapter.ts";
import {
  executeSettingsAgentGatewayOperation
} from "../../../packages/server-runtime/src/composition/console-domain/operation-executors/settings-agent-gateway-executor.ts";

let root: any = "";
let fixture: any = null;

function modelEntry({ alias, baseUrl, token, timeoutMs = 500 }: Record<string, any>) : any {
  return {
    uid: alias,
    provider: "openai",
    model: "fixture-model",
    baseUrl,
    apiKey: token,
    tokenHeader: "Authorization",
    tokenPrefix: "Bearer ",
    timeoutMs
  };
}

function createMcpResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = { ...this.headers, ...headers };
    },
    end(chunk: any = "") : any {
      this.body = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
    }
  };
}

async function callMcp({ body, provider }: Record<string, any>) : Promise<any> {
  const response: any = createMcpResponse();
  const handled: any = await handleMeshrixMcpHttpRequest({
    request: {
      headers: { authorization: "fixture-grant-token" },
      socket: { remoteAddress: "127.0.0.1" },
      __meshrixRequestId: "fixture-mcp-request"
    },
    response,
    requestBody: Buffer.from(JSON.stringify(body), "utf8"),
    method: "POST",
    url: new URL("/mcp", "http://127.0.0.1"),
    toolSkillManagementProvider: provider,
    upstreamGatewayRegistry: null,
    listenUrl: "http://127.0.0.1:7331",
    discoveryState: null
  });
  return {
    handled,
    statusCode: response.statusCode,
    payload: JSON.parse(response.body)
  };
}

function agentGatewayMcpProvider({ settings, authorization }: Record<string, any>) : any {
  const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
  const tool: any = catalog.tools.find((item?: any) : any => item.operationId === "agent_gateway.call");
  return {
    authorizeRequest: async () : Promise<any> => authorization,
    listVisibleTools: () : any => authorization?.ok === true ? [tool] : [],
    visibleGrantSummary: () : any => ({
      id: authorization?.grant?.id || "",
      scopes: authorization?.grant?.scopes || []
    }),
    resolveMcpWorkspaceInput: async ({ input }: Record<string, any>) : Promise<any> => ({
      input,
      workspaceDirectory: null
    }),
    executeTool: async ({ toolId, input }: Record<string, any>) : Promise<any> => {
      if (toolId !== "meshrix.agentGateway.call") {
        return {
          ok: false,
          status: 404,
          payload: {
            error: {
              code: "operation_not_found",
              message: "Operation is not available."
            }
          }
        };
      }
      try {
        const result: any = await callAgentGateway({
          settings,
          input,
          userDataPath: root
        });
        return {
          ok: true,
          status: 200,
          payload: {
            toolExecutionId: "fixture-tool-execution",
            traceId: "fixture-trace",
            result
          }
        };
      } catch (error: any) {
        return {
          ok: false,
          status: error?.statusCode || 500,
          payload: {
            error: {
              code: error?.code || "agent_gateway_upstream_unavailable",
              message: error?.message || "Agent Gateway call failed.",
              details: {
                retryable: error?.retryable === true,
                stage: error?.stage || "transport"
              }
            }
          }
        };
      }
    },
    publicMcpToolPayload: async ({ payload }: Record<string, any>) : Promise<any> => payload
  };
}

async function createOpenAiCompatibleFixture() : Promise<any> {
  const requests: any[] = [];
  const effects: any[] = [];
  const authorizationFor: any = (token?: any) : any => ["Bearer", token].join(" ");
  const server: any = http.createServer(async (request?: any, response?: any) : Promise<any> => {
    const chunks: any[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body: any = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
    const authorization: any = String(request.headers.authorization || "");
    requests.push({
      path: request.url,
      model: body.model || ""
    });
    if (authorization === authorizationFor("invalid-fixture-token")) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: "private upstream credential detail must not escape"
      }));
      return;
    }
    if (authorization === authorizationFor("timeout-fixture-token")) {
      await new Promise((resolve?: any) : any => setTimeout(resolve, 150));
    }
    effects.push({ kind: "model-call", model: body.model || "" });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "fixture-response",
      model: "fixture-model",
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "fixture-ok" }
      }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 }
    }));
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: any = server.address();
  return {
    requests,
    effects,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () : any => new Promise((resolve?: any, reject?: any) : any =>
      server.close((error?: any) : any => error ? reject(error) : resolve())
    )
  };
}

beforeEach(async () : Promise<any> => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-agent-gateway-golden-"));
  fixture = await createOpenAiCompatibleFixture();
});

afterEach(async () : Promise<any> => {
  await fixture?.close();
  await fs.rm(root, { recursive: true, force: true });
  fixture = null;
  root = "";
});

describe("agent gateway deployed-service golden path", () : any => {
  it("discovers a configured model and governed MCP tool, then calls the local fixture", async () : Promise<any> => {
    const settings: Record<string, any> = {
      modelLibraryAgents: [
        modelEntry({
          alias: "fixture-primary",
          baseUrl: fixture.baseUrl,
          token: "valid-fixture-token"
        })
      ]
    };
    expect(publicAgentGatewayRegistry(settings)).toMatchObject({
      agents: [{
        alias: "fixture-primary",
        configured: true,
        status: "available",
        capabilities: ["agent.invoke", "gateway.forward"]
      }]
    });

    const catalog: any = createToolCatalog({ operations: SERVER_API_OPERATIONS });
    const tool: any = catalog.tools.find((item?: any) : any =>
      item.operationId === "agent_gateway.call"
    );
    const provider: Record<string, any> = {
      listVisibleTools({ authorization }: Record<string, any>) : any {
        return authorization?.ok === true ? [tool] : [];
      }
    };
    const authorization: Record<string, any> = { ok: true, grant: { id: "fixture-grant" } };
    const discovered: any = mcpToolForOperation({
      operation: "meshrix.agentGateway.call",
      toolSkillManagementProvider: provider,
      authorization
    });
    expect(publicMcpTool(discovered)).toMatchObject({
      name: "meshrix.agentGateway.call",
      _meta: {
        operationId: "agent_gateway.call",
        requiredScopes: ["model:call"]
      }
    });

    const result: any = await callAgentGateway({
      settings,
      input: {
        alias: "fixture-primary",
        question: "hello fixture"
      },
      userDataPath: root
    });
    expect(result).toMatchObject({
      ok: true,
      answer: "fixture-ok",
      upstream: { provider: "openai", status: 200, model: "fixture-model" }
    });
    expect(fixture.effects).toHaveLength(1);
  });

  it("serves downstream MCP discovery and call, and rejects a revoked Grant before execution", async () : Promise<any> => {
    const settings: Record<string, any> = {
      modelLibraryAgents: [
        modelEntry({
          alias: "fixture-primary",
          baseUrl: fixture.baseUrl,
          token: "valid-fixture-token"
        })
      ]
    };
    const activeAuthorization: Record<string, any> = {
      ok: true,
      grant: {
        id: "fixture-grant",
        scopes: ["model:call"]
      }
    };
    const provider: any = agentGatewayMcpProvider({
      settings,
      authorization: activeAuthorization
    });

    const discovered: any = await callMcp({
      provider,
      body: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "meshrix.discovery",
          arguments: {
            apiVersion: "v0.0.1:mcp:interface-1",
            operation: "meshrix.capabilities.list",
            input: {}
          }
        }
      }
    });
    expect(discovered).toMatchObject({
      handled: true,
      statusCode: 200
    });
    expect(discovered.payload.result.structuredContent.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "meshrix.agentGateway.call",
          _meta: expect.objectContaining({
            requiredScopes: ["model:call"]
          })
        })
      ])
    );

    const called: any = await callMcp({
      provider,
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "meshrix.discovery",
          arguments: {
            apiVersion: "v0.0.1:mcp:interface-1",
            operation: "meshrix.agentGateway.call",
            input: {
              alias: "fixture-primary",
              question: "hello through downstream MCP"
            }
          }
        }
      }
    });
    expect(called).toMatchObject({
      handled: true,
      statusCode: 200,
      payload: {
        result: {
          structuredContent: {
            operation: "meshrix.agentGateway.call",
            payload: {
              ok: true,
              answer: "fixture-ok"
            }
          }
        }
      }
    });
    expect(fixture.effects).toHaveLength(1);

    const revokedAuthorization: any = revalidateGrantForExecution({
      store: {
        authorizeGrantForExecution: () : any => ({
          ok: false,
          status: 403,
          reasonCode: "execution_grant_inactive",
          error: "Tool grant is no longer active."
        })
      },
      capturedGrant: {
        id: "revoked-grant",
        projectionFingerprint: "a".repeat(64)
      },
      requiredScopes: ["model:call"],
      tool: { id: "meshrix.agentGateway.call" }
    });
    let revokedExecutionCount: any = 0;
    const revokedProvider: any = agentGatewayMcpProvider({
      settings,
      authorization: revokedAuthorization
    });
    revokedProvider.executeTool = async () : Promise<any> => {
      revokedExecutionCount += 1;
      throw new Error("revoked execution must not be reached");
    };
    const revokedCall: any = await callMcp({
      provider: revokedProvider,
      body: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "meshrix.discovery",
          arguments: {
            apiVersion: "v0.0.1:mcp:interface-1",
            operation: "meshrix.agentGateway.call",
            input: {
              alias: "fixture-primary",
              question: "must not execute"
            }
          }
        }
      }
    });
    expect(revokedCall).toMatchObject({
      handled: true,
      statusCode: 403,
      payload: {
        error: {
          code: -32001,
          data: {
            code: "execution_grant_inactive"
          }
        }
      }
    });
    expect(revokedExecutionCount).toBe(0);
    expect(fixture.effects).toHaveLength(1);
  });

  it("returns stable failures for missing config, invalid credential, and timeout", async () : Promise<any> => {
    await expect(callAgentGateway({
      settings: {},
      input: { alias: "missing", question: "hello" },
      userDataPath: root
    })).rejects.toMatchObject({
      code: "agent_gateway_not_configured",
      statusCode: 409,
      retryable: false,
      stage: "configuration"
    });
    expect(fixture.requests).toHaveLength(0);

    const invalidSettings: Record<string, any> = {
      modelLibraryAgents: [
        modelEntry({
          alias: "invalid",
          baseUrl: fixture.baseUrl,
          token: "invalid-fixture-token"
        })
      ]
    };
    const invalid: any = await callAgentGateway({
      settings: invalidSettings,
      input: { alias: "invalid", question: "hello" },
      userDataPath: root
    }).catch((error?: any) : any => error);
    expect(invalid).toMatchObject({
      code: "agent_gateway_credential_invalid",
      statusCode: 502,
      retryable: false,
      stage: "credential"
    });
    expect(String(invalid)).not.toContain("private upstream credential detail");
    expect(fixture.effects).toHaveLength(0);

    const timeoutSettings: Record<string, any> = {
      modelLibraryAgents: [
        modelEntry({
          alias: "timeout",
          baseUrl: fixture.baseUrl,
          token: "timeout-fixture-token",
          timeoutMs: 20
        })
      ]
    };
    await expect(callAgentGateway({
      settings: timeoutSettings,
      input: { alias: "timeout", question: "hello" },
      userDataPath: root
    })).rejects.toMatchObject({
      code: "agent_gateway_upstream_timeout",
      statusCode: 504,
      retryable: true,
      stage: "transport"
    });
  });

  it("never falls back on credential failure, but may fall back after a timeout", async () : Promise<any> => {
    const invalidThenValid: Record<string, any> = {
      modelLibraryAgents: [
        modelEntry({
          alias: "invalid",
          baseUrl: fixture.baseUrl,
          token: "invalid-fixture-token"
        }),
        modelEntry({
          alias: "valid",
          baseUrl: fixture.baseUrl,
          token: "valid-fixture-token"
        })
      ],
      modelRouting: {
        enabled: true,
        routeId: "fixture.non-transient",
        candidateChain: ["invalid", "valid"],
        maxAttempts: 2
      }
    };
    await expect(callAgentGateway({
      settings: invalidThenValid,
      input: { question: "hello" },
      userDataPath: root
    })).rejects.toMatchObject({
      code: "agent_gateway_credential_invalid",
      retryable: false,
      modelRouting: {
        attempts: [{
          alias: "invalid",
          errorCode: "agent_gateway_credential_invalid",
          retryable: false
        }]
      }
    });
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.effects).toHaveLength(0);

    fixture.requests.length = 0;
    const timeoutThenValid: Record<string, any> = {
      modelLibraryAgents: [
        modelEntry({
          alias: "timeout",
          baseUrl: fixture.baseUrl,
          token: "timeout-fixture-token",
          timeoutMs: 20
        }),
        modelEntry({
          alias: "valid",
          baseUrl: fixture.baseUrl,
          token: "valid-fixture-token"
        })
      ],
      modelRouting: {
        enabled: true,
        routeId: "fixture.transient",
        candidateChain: ["timeout", "valid"],
        maxAttempts: 2
      }
    };
    const result: any = await callAgentGateway({
      settings: timeoutThenValid,
      input: { question: "hello" },
      userDataPath: root
    });
    expect(result).toMatchObject({
      answer: "fixture-ok",
      modelRouting: {
        selectedAlias: "valid",
        secondaryCandidateUsed: true,
        attempts: [
          {
            alias: "timeout",
            errorCode: "agent_gateway_upstream_timeout",
            retryable: true
          },
          { alias: "valid", status: "success" }
        ]
      }
    });
  });

  it("projects stable errors and blocks a revoked Grant before any model effect", async () : Promise<any> => {
    const projected: any = await executeSettingsAgentGatewayOperation({
      operationId: "agent_gateway.call",
      input: { alias: "fixture-primary", question: "hello" },
      context: {
        userDataPath: root,
        settingsPort: {
          getSettingsPath: () : any => "",
          normalizeSettings: (value?: any) : any => value,
          loadSettings: async () : Promise<any> => ({}),
          saveSettings: async (_root?: any, value?: any) : Promise<any> => value
        },
        agentRuntimeProvider: {
          getAgentConfigRegistry: () : any => ({
            refresh: async () : Promise<any> => {},
            replaceFromModelLibraryAgents: async () : Promise<any> => {},
            getModelLibraryAgents: () : any => [],
            getModelLibraryEntries: () : any => []
          }),
          callAgentGateway: async () : Promise<any> => {
            throw agentGatewayError("agent_gateway_upstream_timeout");
          }
        }
      }
    });
    expect(projected).toEqual({
      status: 504,
      payload: {
        schemaVersion: "v0.0.1:schema:definition-1",
        ok: false,
        error: {
          code: "agent_gateway_upstream_timeout",
          message: "The upstream model timed out.",
          retryable: true,
          stage: "transport"
        }
      }
    });

    const revoked: any = revalidateGrantForExecution({
      store: {
        authorizeGrantForExecution: () : any => ({
          ok: false,
          status: 403,
          reasonCode: "execution_grant_inactive",
          error: "Tool grant is no longer active."
        })
      },
      capturedGrant: {
        id: "revoked-grant",
        projectionFingerprint: "a".repeat(64)
      },
      requiredScopes: ["model:call"],
      tool: { id: "meshrix.agentGateway.call" }
    });
    expect(revoked).toMatchObject({
      ok: false,
      status: 403,
      reasonCode: "execution_grant_inactive"
    });
    expect(mcpToolForOperation({
      operation: "meshrix.agentGateway.call",
      toolSkillManagementProvider: { listVisibleTools: () : any => [] },
      authorization: revoked
    })).toBeNull();
    expect(fixture.effects).toHaveLength(0);
  });
});
