import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createServerCompositionRoot } from "../../../packages/server-runtime/src/composition/composition-root.ts";
import {
  DEPLOYMENT_PROFILE_ID_CONFIG_PATH,
  ENABLED_PLUGINS_CONFIG_PATH,
  PLUGIN_ARTIFACT_TRUST_CONFIG_PATH,
  resolveDeploymentProfileId,
  resolveEnabledPluginSelection,
  resolvePluginArtifactTrustedPublicKeys
} from "../../../tools/server-scripts/lib/runtime-plugin-selection.ts";

const PUBLIC_JWK: Readonly<Record<string, any>> = Object.freeze({ kty: "OKP", crv: "Ed25519", x: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" });

describe("packaged server plugin selection", () : any => {
  it("uses one explicit array-valued deployment field", () : any => {
    expect(ENABLED_PLUGINS_CONFIG_PATH).toBe("runtime.enabledPlugins");
    expect(resolveEnabledPluginSelection({})).toEqual([]);
    expect(resolveEnabledPluginSelection({ runtime: {} })).toEqual([]);
    expect(resolveEnabledPluginSelection({ runtime: { enabledPlugins: [] } })).toEqual([]);
    expect(resolveEnabledPluginSelection({
      runtime: { enabledPlugins: ["alpha", "beta"] }
    })).toEqual(["alpha", "beta"]);
  });

  it("rejects non-arrays, invalid ids, empty values, and duplicates", () : any => {
    for (const config of [
      { runtime: null },
      { runtime: { enabledPlugins: null } },
      { runtime: { enabledPlugins: "alpha" } },
      { runtime: { enabledPlugins: [""] } },
      { runtime: { enabledPlugins: ["Alpha"] } },
      { runtime: { enabledPlugins: ["alpha", " alpha "] } }
    ]) {
      expect(() : any => resolveEnabledPluginSelection(config)).toThrow();
    }
  });

  it("keeps artifact trust empty unless explicit public Ed25519 JWKs are configured", () : any => {
    expect(PLUGIN_ARTIFACT_TRUST_CONFIG_PATH).toBe("runtime.pluginArtifactTrustedPublicKeys");
    expect(resolvePluginArtifactTrustedPublicKeys({})).toEqual({});
    expect(resolvePluginArtifactTrustedPublicKeys({ runtime: {} })).toEqual({});
    expect(resolvePluginArtifactTrustedPublicKeys({
      runtime: { pluginArtifactTrustedPublicKeys: { "ed25519:release": PUBLIC_JWK } }
    })).toEqual({ "ed25519:release": PUBLIC_JWK });

    for (const trust of [
      null,
      [],
      { release: PUBLIC_JWK },
      { "ed25519:release": { ...PUBLIC_JWK, d: "private-material-is-forbidden" } },
      { "ed25519:release": { ...PUBLIC_JWK, x: "short" } }
    ]) {
      expect(() : any => resolvePluginArtifactTrustedPublicKeys({
        runtime: { pluginArtifactTrustedPublicKeys: trust }
      })).toThrow();
    }
  });

  it("fails closed when configured and injected artifact trust conflict", async () : Promise<any> => {
    const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-trust-conflict-"));
    try {
      await expect(createServerCompositionRoot({
        userDataPath,
        runtimeOptions: {
          pluginArtifactTrustedPublicKeys: { "ed25519:configured": PUBLIC_JWK }
        },
        pluginHostPorts: {
          pluginArtifactTrustedPublicKeys: { "ed25519:injected": PUBLIC_JWK }
        }
      })).rejects.toThrow(/conflicts/u);
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("preserves an explicit deployment profile id without synthesizing a default", () : any => {
    expect(DEPLOYMENT_PROFILE_ID_CONFIG_PATH).toBe("runtime.deploymentProfileId");
    expect(resolveDeploymentProfileId({})).toBeNull();
    expect(resolveDeploymentProfileId({ runtime: {} })).toBeNull();
    expect(resolveDeploymentProfileId({
      runtime: { deploymentProfileId: "controlled-plugins" }
    })).toBe("controlled-plugins");
    expect(resolveDeploymentProfileId({
      runtime: { deploymentProfileId: " controlled-plugins " }
    })).toBe("controlled-plugins");

    for (const config of [
      { runtime: { deploymentProfileId: null } },
      { runtime: { deploymentProfileId: "" } },
      { runtime: { deploymentProfileId: "Default" } }
    ]) {
      expect(() : any => resolveDeploymentProfileId(config)).toThrow();
    }
  });
});
