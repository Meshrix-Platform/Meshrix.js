import { createExternalGatewayPluginRuntime } from "./src/external-gateway-runtime.mjs";

export { validateExternalGatewayConfiguration } from "./src/external-gateway-runtime.mjs";

export async function activatePlugin({ manifest, context = {} } = {}) {
  if (manifest?.id !== "external-gateway") {
    throw new TypeError("External Gateway requires the external-gateway manifest.");
  }
  return createExternalGatewayPluginRuntime({
    pluginId: manifest.id,
    configuration: context.configuration ?? {},
    transport: context.gatewayTransport
  });
}
