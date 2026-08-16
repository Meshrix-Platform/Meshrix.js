export * from "./api-key-distribution-common.ts";

const API_KEY_COMMANDS: readonly string[] = Object.freeze([
  "getIssuerScopes", "list", "listAudienceGrants", "create", "rotate", "revoke", "authenticateRuntime",
  "revalidateAuthorization", "authorizeOperation", "reserveEffect", "revalidateEffect",
  "releaseEffect", "explainLookupPlan"
]);

export function createApiKeyDistributionProvider({ store, changeListener = null }: Record<string, any> = {}) : any {
  if (!store || typeof store.executeApiKey !== "function") {
    throw new Error("API Key distribution SQLite lane is unavailable.");
  }
  return Object.freeze(Object.fromEntries(API_KEY_COMMANDS.map((kind?: any) : any => [
    kind,
    async (input: any = {}) : Promise<any> => {
      const result: any = await store.executeApiKey(kind, input);
      if (["create", "rotate", "revoke"].includes(kind) && typeof changeListener === "function") {
        await changeListener({
          reasonCode: `api_key_${kind}`,
          type: `api_key_${kind}`,
          grantId: String(result?.record?.workloadPrincipalId || result?.workloadPrincipalId || "")
        });
      }
      return result;
    }
  ])));
}
