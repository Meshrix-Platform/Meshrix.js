import { normalizeEnabledPluginIds } from "../../../packages/foundation/src/module-system/plugin-registry.ts";
import { normalizePluginArtifactTrustedPublicKeys } from "../../../packages/foundation/src/module-system/plugin-artifact-trust.ts";

function isPlainObject(value?: any) : any {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: any = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export const ENABLED_PLUGINS_CONFIG_PATH: any = "runtime.enabledPlugins";
export const PLUGIN_CONFIGURATIONS_CONFIG_PATH: any = "runtime.pluginConfigurations";
export const PLUGIN_ARTIFACT_TRUST_CONFIG_PATH: any = "runtime.pluginArtifactTrustedPublicKeys";
export const DEPLOYMENT_PROFILE_ID_CONFIG_PATH: any = "runtime.deploymentProfileId";

export function resolveEnabledPluginSelection(runtimeConfig: Record<string, any> = {}) : any {
  if (!isPlainObject(runtimeConfig)) {
    throw new TypeError("Runtime configuration must be an object.");
  }
  const runtime: any = runtimeConfig.runtime;
  if (runtime === undefined) return Object.freeze([]);
  if (!isPlainObject(runtime)) {
    throw new TypeError("runtime must be an object when provided.");
  }
  if (!Object.hasOwn(runtime, "enabledPlugins")) return Object.freeze([]);
  return Object.freeze(normalizeEnabledPluginIds(runtime.enabledPlugins));
}

export function resolvePluginConfigurations(runtimeConfig: Record<string, any> = {}) : any {
  if (!isPlainObject(runtimeConfig)) {
    throw new TypeError("Runtime configuration must be an object.");
  }
  const runtime: any = runtimeConfig.runtime;
  if (runtime === undefined) return Object.freeze({});
  if (!isPlainObject(runtime)) {
    throw new TypeError("runtime must be an object when provided.");
  }
  if (!Object.hasOwn(runtime, "pluginConfigurations")) return Object.freeze({});
  if (!isPlainObject(runtime.pluginConfigurations)) {
    throw new TypeError("runtime.pluginConfigurations must be an object when provided.");
  }
  return Object.freeze(structuredClone(runtime.pluginConfigurations));
}

export function resolvePluginArtifactTrustedPublicKeys(runtimeConfig: Record<string, any> = {}) : any {
  if (!isPlainObject(runtimeConfig)) {
    throw new TypeError("Runtime configuration must be an object.");
  }
  const runtime: any = runtimeConfig.runtime;
  if (runtime === undefined) return Object.freeze({});
  if (!isPlainObject(runtime)) {
    throw new TypeError("runtime must be an object when provided.");
  }
  return normalizePluginArtifactTrustedPublicKeys(
    Object.hasOwn(runtime, "pluginArtifactTrustedPublicKeys")
      ? runtime.pluginArtifactTrustedPublicKeys
      : {}
  );
}

export function resolveDeploymentProfileId(runtimeConfig: Record<string, any> = {}) : any {
  if (!isPlainObject(runtimeConfig)) {
    throw new TypeError("Runtime configuration must be an object.");
  }
  const runtime: any = runtimeConfig.runtime;
  if (runtime === undefined) return null;
  if (!isPlainObject(runtime)) {
    throw new TypeError("runtime must be an object when provided.");
  }
  if (!Object.hasOwn(runtime, "deploymentProfileId")) return null;
  if (typeof runtime.deploymentProfileId !== "string") {
    throw new TypeError("runtime.deploymentProfileId must be a string when provided.");
  }
  const deploymentProfileId: any = runtime.deploymentProfileId.trim();
  if (!/^[a-z][a-z0-9._-]*$/u.test(deploymentProfileId)) {
    throw new Error("runtime.deploymentProfileId must be a lowercase deployment profile id.");
  }
  return deploymentProfileId;
}
