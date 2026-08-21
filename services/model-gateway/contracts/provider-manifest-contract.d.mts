export const PROVIDER_MANIFEST_SCHEMA: "v0.0.1:meshrix:fixture-provider-manifest-1";
export function createProviderManifest(baseUrl: string): Readonly<{
  schemaVersion: typeof PROVIDER_MANIFEST_SCHEMA;
  baseUrl: string;
  scenarioSelection: "closed-model-identifiers";
}>;
