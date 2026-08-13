import { describe, expect, it } from "vitest";
import { SERVER_API_OPERATIONS } from "#meshrix/contracts/operations/operation-registry";
import { createOperationRouteIndex } from "#meshrix/server-runtime/routing/operation-route-index";
import {
  RadixPathTrie,
  ROUTE_PARAMETER_MAX_BYTES,
  ROUTE_WILDCARD_MAX_BYTES,
} from "#meshrix/server-runtime/routing/radix-path-trie";
import {
  findHttpOperation,
  findProxyRegisteredApiRequest,
  findRpcOperation,
} from "#meshrix/server-runtime/composition/dispatch-operation";
import { createCorePlatformProvider } from "#meshrix/server-runtime/composition/core-platform-provider";

function operation(id?: any, method?: any, path?: any, rpcMethod: any = id) : any {
  return {
    id,
    target: { controller: "fixture", method: "handle" },
    http: { method, path },
    rpc: { method: rpcMethod },
  };
}

describe("operation route index", () : any => {
  it("compiles an immutable canonical registry snapshot without route conflicts", () : any => {
    const index: any = createOperationRouteIndex(SERVER_API_OPERATIONS, { strict: true });

    expect(index.size).toBe(SERVER_API_OPERATIONS.length);
    expect(index.conflicts).toEqual([]);
    expect(index.warnings).toEqual([]);
    expect(Object.isFrozen(index.operations)).toBe(true);
    expect(Object.isFrozen(index.operations[0].http)).toBe(true);
  });

  it("uses indexed HTTP, RPC, and operation-id lookup with decoded route params", () : any => {
    const operations: any[] = [
      operation("workspace.get", "GET", "/api/workspaces/:workspaceId", "workspace.get"),
      operation("workspace.list", "GET", "/api/workspaces/list", "workspace.list"),
    ];
    const index: any = createOperationRouteIndex(operations, { strict: true });

    expect(findHttpOperation({
      operations,
      routeIndex: index,
      method: "GET",
      pathname: "/api/workspaces/list?ignored=true",
    })?.operation.id).toBe("workspace.list");
    expect(findHttpOperation({
      operations,
      routeIndex: index,
      method: "GET",
      pathname: "/api/workspaces/team%20alpha",
    })).toMatchObject({
      operation: { id: "workspace.get" },
      pathParams: { workspaceId: "team alpha" },
    });
    expect(findRpcOperation({ operations, routeIndex: index, method: "workspace.get" })?.id)
      .toBe("workspace.get");
    expect(index.getOperationById("workspace.list")?.id).toBe("workspace.list");
    expect(index.findHttpOperation("GET", "/api/workspaces/list"))
      .not.toHaveProperty("routeConfig");
  });

  it("does not become stale or mutable when the source catalog changes", () : any => {
    const operations: any[] = [operation("first", "GET", "/first", "first")];
    const index: any = createOperationRouteIndex(operations, { strict: true });
    operations[0].http.path = "/changed";
    operations.push(operation("second", "GET", "/second", "second"));

    expect(index.size).toBe(1);
    expect(index.findHttpOperation("GET", "/first")?.operation.id).toBe("first");
    expect(index.findHttpOperation("GET", "/changed")).toBeNull();
    expect(index.findHttpOperation("GET", "/second")).toBeNull();
    expect(() : any => {
      index.operations[0].http.path = "/mutated";
    }).toThrow(TypeError);
  });

  it("reuses the provider's immutable route index for its configured source catalog", () : any => {
    const operations: any[] = [
      operation("relay.send", "POST", "/api/relay/send", "relay.send"),
    ];
    const provider: any = createCorePlatformProvider({ operations });
    operations[0].http.path = "/api/relay/changed";

    const discoveryState: Record<string, any> = {
      mode: "forward",
      advertisedBaseUrl: "https://local.example",
      forwardBaseUrl: "https://upstream.example",
    };
    expect(provider.findProxyRegisteredApiRequest({
      operations,
      method: "POST",
      pathname: "/api/relay/send",
      discoveryState,
    })?.operation.id).toBe("relay.send");
    expect(provider.findProxyRegisteredApiRequest({
      operations,
      method: "POST",
      pathname: "/api/relay/changed",
      discoveryState,
    })).toBeNull();
  });

  it("caches dynamic route indices by immutable catalog identity instead of operation IDs", () : any => {
    const first: readonly any[] = Object.freeze([
      Object.freeze(operation("relay.send", "POST", "/api/relay/first", "relay.send")),
    ]);
    const second: readonly any[] = Object.freeze([
      Object.freeze(operation("relay.send", "POST", "/api/relay/second", "relay.send")),
    ]);
    let current: any = first;
    const provider: any = createCorePlatformProvider({ operations: [], getOperations: () : any => current });
    const discoveryState: Record<string, any> = {
      mode: "forward",
      advertisedBaseUrl: "https://local.example",
      forwardBaseUrl: "https://upstream.example",
    };

    expect(provider.findProxyRegisteredApiRequest({
      method: "POST",
      pathname: "/api/relay/first",
      discoveryState,
    })?.operation.id).toBe("relay.send");
    current = second;
    expect(provider.findProxyRegisteredApiRequest({
      method: "POST",
      pathname: "/api/relay/second",
      discoveryState,
    })?.operation.id).toBe("relay.send");
    expect(provider.findProxyRegisteredApiRequest({
      method: "POST",
      pathname: "/api/relay/first",
      discoveryState,
    })).toBeNull();
  });

  it("normalizes encoded unreserved static segments before parameter routes", () : any => {
    const index: any = createOperationRouteIndex(SERVER_API_OPERATIONS, { strict: true });
    expect(index.findHttpOperation("GET", "/api/jobs/%66ailed-review")?.operation.id)
      .toBe("jobs.failed_review");
    expect(index.findHttpOperation("GET", "/api/jobs/%77ork-queue")?.operation.id)
      .toBe("jobs.work_queue.inspect");
    expect(index.findHttpOperation("GET", "/api/jobs/%00")).toBeNull();
  });

  it("backs off from an incomplete static branch to a parameter branch", () : any => {
    const trie: any = new RadixPathTrie();
    trie.insert("/api/static/only", { id: "static" });
    trie.insert("/api/:scope/fallback", { id: "parameter" });

    expect(trie.lookup("/api/static/fallback")).toMatchObject({
      value: { id: "parameter" },
      params: { scope: "static" },
    });
  });

  it("orders static, parameter, and wildcard routes deterministically", () : any => {
    const trie: any = new RadixPathTrie();
    trie.insert("/assets/*", { id: "wildcard" });
    trie.insert("/assets/:assetId", { id: "parameter" });
    trie.insert("/assets/manifest", { id: "static" });

    expect(trie.lookup("/assets/manifest")?.value.id).toBe("static");
    expect(trie.lookup("/assets/icon")?.value.id).toBe("parameter");
    expect(trie.lookup("/assets/icons/app.svg")).toMatchObject({
      value: { id: "wildcard" },
      params: { "*": "icons/app.svg" },
    });

    const index: any = createOperationRouteIndex([
      operation("asset.param", "GET", "/assets/:assetId", "asset.param"),
      operation("asset.wildcard", "GET", "/assets/*", "asset.wildcard"),
    ], { strict: true });
    expect(index.listHttpRoutes()).toEqual([
      { method: "GET", path: "/assets/:assetId", operationId: "asset.param" },
      { method: "GET", path: "/assets/*", operationId: "asset.wildcard" },
    ]);
  });

  it("rejects invalid route shapes and malformed encoded params", () : any => {
    const trie: any = new RadixPathTrie();
    expect(() : any => trie.insert("/assets/*/nested", {})).toThrow("Wildcard must be the final segment");
    expect(() : any => trie.insert("/api/:/value", {})).toThrow("Parameter name is required");

    trie.insert("/api/:id", { id: "parameter" });
    expect(trie.lookup("/api/%E0%A4%A")).toBeNull();
    expect(trie.lookup("/api/%00")).toBeNull();
    expect(trie.lookup(`/api/${"x".repeat(ROUTE_PARAMETER_MAX_BYTES + 1)}`)).toBeNull();

    const wildcard: any = new RadixPathTrie();
    wildcard.insert("/assets/*", { id: "wildcard" });
    expect(wildcard.lookup(`/assets/${"x".repeat(ROUTE_WILDCARD_MAX_BYTES + 1)}`))
      .toBeNull();
  });

  it("fails strict compilation for duplicate ids, HTTP routes, and RPC methods", () : any => {
    expect(() : any => createOperationRouteIndex([
      operation("duplicate", "GET", "/first", "first"),
      operation("duplicate", "POST", "/second", "second"),
    ], { strict: true })).toThrow("Duplicate operation ID");

    expect(() : any => createOperationRouteIndex([
      operation("first", "GET", "/same", "first"),
      operation("second", "GET", "/same", "second"),
    ], { strict: true })).toThrow("duplicate_path");

    expect(() : any => createOperationRouteIndex([
      operation("first", "GET", "/first", "same.rpc"),
      operation("second", "POST", "/second", "same.rpc"),
    ], { strict: true })).toThrow("Duplicate RPC method");

    expect(() : any => createOperationRouteIndex([
      operation("invalid", "TRACE", "/invalid", "invalid"),
    ], { strict: true })).toThrow("Invalid HTTP method");
    expect(() : any => createOperationRouteIndex([
      operation("invalid", "GET", "/invalid", " invalid "),
    ], { strict: true })).toThrow("RPC method is required");
  });

  it("keeps explicit empty provider catalogs empty and local prefixes local", () : any => {
    const provider: any = createCorePlatformProvider({ operations: [] });
    expect(provider.listInterfaceCatalog()).toEqual([]);
    expect(provider.describeOperationRegistry().summary.total).toBe(0);

    const localOperation: any = operation("local.jobs", "GET", "/api/jobs/:jobId", "local.jobs");
    expect(findProxyRegisteredApiRequest({
      method: "GET",
      pathname: "/api/%6Aobs/example",
      discoveryState: {
        mode: "forward",
        advertisedBaseUrl: "https://local.example",
        forwardBaseUrl: "https://upstream.example",
      },
      operations: [localOperation],
    })).toBeNull();
  });
});
