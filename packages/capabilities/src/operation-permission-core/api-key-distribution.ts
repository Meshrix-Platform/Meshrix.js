export * from "./api-key-distribution-common.ts";

const API_KEY_COMMANDS: readonly string[] = Object.freeze([
  "getIssuerScopes", "list", "create", "rotate", "revoke", "authenticateRuntime",
  "revalidateAuthorization", "authorizeOperation", "reserveEffect", "revalidateEffect",
  "releaseEffect", "explainLookupPlan"
]);

export function createApiKeyDistributionProvider({ store }: Record<string, any> = {}) : any {
  if (!store || typeof store.executeApiKey !== "function") {
    throw new Error("API Key distribution SQLite lane is unavailable.");
  }
  return Object.freeze(Object.fromEntries(API_KEY_COMMANDS.map((kind?: any) : any => [
    kind,
    (input: any = {}) : Promise<any> => store.executeApiKey(kind, input)
  ])));
}
