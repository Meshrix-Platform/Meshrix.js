import { beforeEach, describe, expect, it, vi } from "vitest";

const bridgeHttpMock: any = vi.hoisted(() : any => ({
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("@meshrix/ui-console/bridge-http", () : any => bridgeHttpMock);

function deferred<T>() : { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

beforeEach(() : any => {
  vi.clearAllMocks();
  vi.resetModules();
});

describe("API-key issuer-scope reads", () : any => {
  it("coalesces concurrent reads and fetches fresh data after they settle", async () : Promise<any> => {
    const firstResponse = deferred<Record<string, unknown>>();
    const secondResponse = { eligibleNodes: [{ nodeId: "new-node" }] };
    bridgeHttpMock.getJson
      .mockReturnValueOnce(firstResponse.promise)
      .mockResolvedValueOnce(secondResponse);
    const client = await import("../../../apps/console/lib/api-key-distribution-client");

    const sideNavRead = client.getApiKeyIssuerScopes();
    const pageRead = client.getApiKeyIssuerScopes();

    expect(bridgeHttpMock.getJson).toHaveBeenCalledTimes(1);
    expect(bridgeHttpMock.getJson).toHaveBeenCalledWith(
      "/api/operation-permission/v1/api-keys/issuer-scopes",
    );
    const firstResult = { eligibleNodes: [{ nodeId: "first-node" }] };
    firstResponse.resolve(firstResult);
    await expect(Promise.all([sideNavRead, pageRead])).resolves.toEqual([firstResult, firstResult]);

    await expect(client.getApiKeyIssuerScopes()).resolves.toEqual(secondResponse);
    expect(bridgeHttpMock.getJson).toHaveBeenCalledTimes(2);
  });
});
