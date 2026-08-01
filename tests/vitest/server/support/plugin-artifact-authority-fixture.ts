import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createPluginArtifactAuthority } from "../../../../packages/foundation/src/module-system/plugin-artifact-authority.ts";
import { createPluginLifecycleStatePort } from "../../../../packages/foundation/src/module-system/plugin-lifecycle-state-port.ts";

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function stagePluginArtifactFixture({
  sourcePluginRoot,
  fixtureParent = os.tmpdir(),
  lifecycleDataRoot = null
}: Record<string, any>) : Promise<any> {
  const fixtureRoot: any = await fs.mkdtemp(path.join(fixtureParent, ".plugin-artifact-fixture-"));
  const artifactRoot: any = path.join(fixtureRoot, "artifacts");
  const dataRoot: any = lifecycleDataRoot || path.join(fixtureRoot, "data");
  await Promise.all([
    fs.mkdir(artifactRoot, { mode: 0o700 }),
    fs.mkdir(dataRoot, { recursive: true, mode: 0o700 })
  ]);
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const keyId: any = "ed25519:test-plugin-artifact-authority";
  const signer: Readonly<Record<string, any>> = Object.freeze({
    id: "ArtifactSignerPort",
    async sign({ purpose, payloadDigest, context }: Record<string, any>) : Promise<any> {
      const contextDigest: any = `sha256:${crypto.createHash("sha256").update(canonicalJson(context)).digest("hex")}`;
      const signedEnvelope: Readonly<Record<string, any>> = Object.freeze({ purpose, payloadDigest, contextDigest });
      return Object.freeze({
        ok: true,
        algorithm: "ed25519",
        payloadEncoding: "sha256-digest-utf8",
        keyId,
        payloadDigest,
        contextDigest,
        signedEnvelope,
        signature: crypto.sign(null, Buffer.from(canonicalJson(signedEnvelope)), privateKey).toString("base64url")
      });
    }
  });
  const authority: any = await createPluginArtifactAuthority({
    artifactRoot,
    trustedPublicKeys: { [keyId]: publicKey.export({ format: "jwk" }) },
    artifactSigner: signer,
    secretRef: "secret://fixture/plugin-artifact",
    coreContractDigest: `sha256:${"f".repeat(64)}`
  });
  const manifests: any = new Map<any, any>();
  for (const entry of await fs.readdir(sourcePluginRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const sourceRoot: any = path.join(sourcePluginRoot, entry.name);
    const manifest: any = JSON.parse(await fs.readFile(path.join(sourceRoot, "plugin.json"), "utf8"));
    manifests.set(manifest.id, { manifest, sourceRoot });
  }
  const installed: any = new Map<any, any>();
  async function stage(id?: any) : Promise<any> {
    if (installed.has(id)) return installed.get(id);
    const source: any = manifests.get(id);
    if (!source) throw new Error(`Fixture plugin dependency ${id} is unavailable.`);
    const dependencyClosure: any[] = [];
    for (const dependencyId of [...(source.manifest.dependencies || [])].sort()) {
      const dependency: any = await stage(dependencyId);
      dependencyClosure.push({
        pluginId: dependencyId,
        version: dependency.version,
        artifactDigest: dependency.artifactDigest,
        generation: dependency.generation
      });
    }
    const lifecycleStatePort: any = await createPluginLifecycleStatePort({ userDataPath: dataRoot, pluginId: id });
    const port: any = authority.forPlugin({ pluginId: id, lifecycleStatePort });
    const published: any = await port.publish({
      sourceRoot: source.sourceRoot,
      version: source.manifest.version,
      generation: 1,
      dependencyClosure
    });
    await port.install(published);
    const result: Readonly<Record<string, any>> = Object.freeze({ ...published, version: source.manifest.version, lifecycleStatePort, port });
    installed.set(id, result);
    return result;
  }
  for (const id of [...manifests.keys()].sort()) await stage(id);
  return Object.freeze({
    authority,
    dataRoot,
    installed,
    async close() : Promise<any> { await fs.rm(fixtureRoot, { recursive: true, force: true }); }
  });
}
