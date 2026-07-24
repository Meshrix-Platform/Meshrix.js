import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createArtifactSignerPort } from "../../../packages/foundation/src/security/artifact-signer-port.mjs";
import {
  initializeLocalSecret,
  revokeLocalSecret
} from "../../../packages/foundation/src/security/secrets/local-secret-store.mjs";

const roots = [];
const secretRef = "secret://fixture/artifact-signing";
const target = Object.freeze({
  provider: "local-signing-key",
  family: "artifact-signing",
  authType: "ed25519",
  secretRef,
  scope: {
    serviceId: "plugin-artifact:sample-plugin",
    scopes: ["artifact:sign"],
    allowedHosts: [],
    allowedProtocols: ["artifact-signing"]
  }
});

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function fixture() {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-artifact-signer-test-"));
  roots.push(dataDir);
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyJwk = privateKey.export({ format: "jwk" });
  await initializeLocalSecret({ dataDir, target, payload: { privateKeyJwk } });
  return { dataDir, privateKeyJwk, port: createArtifactSignerPort({
    dataDir,
    pluginId: "sample-plugin",
    allowedPurposes: ["plugin-artifact.sample-plugin.bundle", "plugin-artifact.sample-plugin.artifact"]
  }) };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("ArtifactSignerPort", () => {
  it("returns only public verification facts and a context-bound receipt", async () => {
    const { port } = await fixture();
    const input = {
      secretRef,
      purpose: "plugin-artifact.sample-plugin.bundle",
      payloadDigest: `sha256:${"a".repeat(64)}`,
      context: { publisherId: "fixture-publisher", releaseChannel: "test" }
    };
    const signed = await port.sign(input);

    expect(signed).toMatchObject({
      ok: true,
      algorithm: "ed25519",
      payloadEncoding: "sha256-digest-utf8",
      purpose: input.purpose,
      payloadDigest: input.payloadDigest,
      receipt: {
        keyId: signed.keyId,
        purpose: input.purpose,
        payloadDigest: input.payloadDigest,
        contextDigest: signed.contextDigest,
        secretRevision: 1
      }
    });
    expect(verify(
      null,
      Buffer.from(stableJson(signed.signedEnvelope)),
      createPublicKey({ key: signed.publicKeyJwk, format: "jwk" }),
      Buffer.from(signed.signature, "base64url")
    )).toBe(true);
    expect(JSON.stringify(signed)).not.toContain(secretRef);
    expect(JSON.stringify(signed)).not.toContain("privateKeyJwk");
  });

  it("binds signatures to context and rejects unsupported purposes", async () => {
    const { port } = await fixture();
    const request = {
      secretRef,
      purpose: "plugin-artifact.sample-plugin.artifact",
      payloadDigest: `sha256:${"b".repeat(64)}`
    };
    const first = await port.sign({ ...request, context: { moduleId: "sample-plugin", version: "one" } });
    const second = await port.sign({ ...request, context: { moduleId: "sample-plugin", version: "two" } });

    expect(second.contextDigest).not.toBe(first.contextDigest);
    expect(second.signature).not.toBe(first.signature);
    expect(verify(
      null,
      Buffer.from(stableJson(second.signedEnvelope)),
      createPublicKey({ key: first.publicKeyJwk, format: "jwk" }),
      Buffer.from(first.signature, "base64url")
    )).toBe(false);
    await expect(port.sign({ ...request, purpose: "plugin-artifact.other-plugin.sign", context: {} }))
      .rejects.toMatchObject({ code: "artifact_signer_purpose_denied" });
  });

  it("fails closed for scope mismatch and revoked custody", async () => {
    const { dataDir } = await fixture();
    const wrongServicePort = createArtifactSignerPort({ dataDir, pluginId: "sample-plugin", serviceId: "different-service", allowedPurposes: ["plugin-artifact.sample-plugin.artifact"] });
    const request = {
      secretRef,
      purpose: "plugin-artifact.sample-plugin.artifact",
      payloadDigest: `sha256:${"c".repeat(64)}`,
      context: { signatureKind: "artifact" }
    };
    await expect(wrongServicePort.sign(request)).rejects.toMatchObject({
      code: "local_secret_scope_denied",
      reasonCode: "service_id_mismatch"
    });

    await revokeLocalSecret({ dataDir, secretRef, expectedRevision: 1 });
    await expect(createArtifactSignerPort({ dataDir, pluginId: "sample-plugin", allowedPurposes: [request.purpose] }).sign(request))
      .rejects.toMatchObject({ code: "local_secret_revoked" });
  });

  it("does not mutate secret payload objects returned by an injected resolver", async () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const sharedPayload = { privateKeyJwk: privateKey.export({ format: "jwk" }) };
    const before = structuredClone(sharedPayload);
    const port = createArtifactSignerPort({
      dataDir: "fixture-data",
      pluginId: "sample-plugin",
      allowedPurposes: ["plugin-artifact.sample-plugin.artifact"],
      resolveSecretPayload: async () => ({ payload: sharedPayload, revision: 7 })
    });
    await port.sign({
      secretRef,
      purpose: "plugin-artifact.sample-plugin.artifact",
      payloadDigest: `sha256:${"d".repeat(64)}`,
      context: { signatureKind: "artifact" }
    });
    expect(sharedPayload).toEqual(before);
  });
});
