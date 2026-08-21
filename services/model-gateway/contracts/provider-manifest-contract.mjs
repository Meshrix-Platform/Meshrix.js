export const PROVIDER_MANIFEST_SCHEMA = "v0.0.1:meshrix:fixture-provider-manifest-1";

export function createProviderManifest(baseUrl) {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== "http:" || !parsed.hostname || !parsed.port ||
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname !== "/" || parsed.origin !== baseUrl) {
    throw Object.assign(new Error("provider manifest base URL is invalid"), {
      code: "provider_manifest_base_url_invalid"
    });
  }
  return Object.freeze({
    schemaVersion: PROVIDER_MANIFEST_SCHEMA,
    baseUrl,
    scenarioSelection: "closed-model-identifiers"
  });
}
