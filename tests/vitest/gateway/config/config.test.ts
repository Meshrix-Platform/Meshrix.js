import { describe, expect, it } from "vitest";
import { createGatewayCredentialProvider } from "@meshrix/capabilities/gateway-credentials";
import { context } from "../support";
const canned1 = "Bearer opaque";




describe("credential and custom-field boundaries", () => {
  it("[CASE-G09] resolves only through an audience-bound provider", async () => {
    const calls: string[] = [];
    const provider = createGatewayCredentialProvider({ resolve: async ({ binding, audience }) => { calls.push(`${binding}:${audience}`); return { Authorization: canned1 }; } }, { allowedAudiences: ["endpoint.demo"] });
    await expect(provider.resolve({ binding: "secret://demo", audience: "endpoint.demo", context })).resolves.toEqual({ Authorization: canned1 });
    await expect(provider.resolve({ binding: "secret://demo", audience: "other", context })).rejects.toMatchObject({ code: "credential_audience_denied" });
    expect(calls).toEqual(["secret://demo:endpoint.demo"]);
  });
});
