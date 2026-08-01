import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildEnterpriseOfflineBundleInventory,
  validateEnterpriseOfflineBundleInventory,
  assembleEnterpriseOfflineBundle,
  verifyEnterpriseOfflineBundle,
  runEnterpriseOfflineBundleFixture,
  ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
  ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS,
} from "../../../tools/server-scripts/enterprise-single-node-offline-bundle.ts";
import {
  buildReleaseCandidateIdentity,
} from "../../../tools/server-scripts/verify-release-candidate-identity.ts";
import {
  RELEASE_IMAGE_AUTHORITY_SCHEMA,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  buildReleaseImageAuthority,
} from "../../../tools/server-scripts/lib/release-image-evidence.ts";

const SHA256: any = /^[a-f0-9]{64}$/u;
const OCI_LAYER_MEDIA_TYPE: any = "application/vnd.oci.image.layer.v1.tar+gzip";
const OCI_CONFIG_MEDIA_TYPE: any = "application/vnd.oci.image.config.v1+json";

const TMP_ROOTS: any[] = [];

function stableJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key?: any) : any => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function bytes(value?: any) : any {
  return Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
}

async function makeReleaseCandidate() : Promise<any> {
  return buildReleaseCandidateIdentity({
    sourceRevision: "0123456789abcdef0123456789abcdef0123456789".slice(0, 40),
    repositoryTreeDigest: `sha256:${"1".repeat(64)}`,
    releaseDefinitionSha256: `sha256:${"2".repeat(64)}`,
    packageLockSha256: `sha256:${"3".repeat(64)}`,
    releasePackages: [
      {
        manifest_path: "packages/contracts/package.json",
        name: "@meshrix/contracts",
        version: "1.2.3",
        manifest_sha256: "4".repeat(64)
      }
    ],
    supportedProfiles: ["enterprise-single-node"],
    reportInventoryDigest: `sha256:${"5".repeat(64)}`
  });
}

function provenance(platform?: any, sourceCommit?: any) : any {
  return {
    [platform]: {
      SLSA: {
        buildType: "https://mobyproject.org/buildkit@v1",
        builder: {
          id: "https://github.com/Acme/Meshrix/actions"
        },
        invocation: {
          parameters: {
            frontend: "dockerfile.v0",
            args: {
              target: "runtime-ui",
              "build-arg:MESHRIX_SOURCE_REPOSITORY": "Acme/Meshrix",
              "build-arg:MESHRIX_SOURCE_REF": "refs/tags/v1.2.3",
              "build-arg:MESHRIX_SOURCE_COMMIT": sourceCommit
            },
            configPath: "Dockerfile",
          },
          environment: {
            platform
          }
        },
        metadata: {
          reproducible: true,
          completeness: {
            parameters: true,
            environment: true,
            materials: true
          },
          buildInvocationID: `build-${platform}-abc`,
          buildStartedOn: "2026-01-01T00:00:00.000Z",
          buildFinishedOn: "2026-01-01T00:00:01.000Z",
          "https://mobyproject.org/buildkit@v1#metadata": {
            vcs: {
              revision: sourceCommit,
              source: "git+https://github.com/Acme/Meshrix.git"
            },
            parameters: {
              output: "linux/amd64"
            }
          }
        },
        materials: [
          {
            uri: "git+https://github.com/Acme/Meshrix.git",
            digest: { sha256: "f".repeat(64) },
          },
          {
            uri: "docker-image://ghcr.io/licoland/buildkit:latest",
            digest: { sha256: "a".repeat(64) },
          }
        ]
      }
    }
  };
}

function sbom(platform?: any) : any {
  return {
    [platform]: {
      SPDX: {
        spdxVersion: "SPDX-2.3",
        SPDXID: "SPDXRef-DOCUMENT",
        dataLicense: "CC0-1.0",
        documentNamespace: "https://github.com/acme/meshrix/spdx#manifest",
        name: `meshrix-${platform.replace("/", "-")}`,
        creationInfo: {
          creators: ["Tool: fixture"],
        },
        packages: [
          {
            SPDXID: "SPDXRef-Package-acme-meshrix",
            name: "@meshrix/meshrix",
          },
        ],
        relationships: [
          {
            spdxElementId: "SPDXRef-Package-acme-meshrix",
            relatedSpdxElement: "SPDXRef-DOCUMENT",
            relationshipType: "CONTAINS",
          },
        ],
      }
    }
  };
}

function exactKeys(value?: any) : any {
  return Object.keys(value).sort();
}

function reverseObjectEntries(value?: any) : any {
  return Object.fromEntries((Object.entries(value) as [string, any][]).reverse());
}

async function trackedTempRoot(prefix?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  TMP_ROOTS.push(root);
  return root;
}

async function writeTree(root?: any) : Promise<any> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  TMP_ROOTS.push(root);
  const sourceCandidate: any = await makeReleaseCandidate();
  const image: any = "ghcr.io/acme/meshrix";
  const sourceCommit: any = sourceCandidate.source_revision;
  const descriptorEntries: any[] = [];
  const inventoryEntries: any[] = [];
  const attestationEntries: any[] = [];

  async function writeBlob(relativePath?: any, value?: any) : Promise<any> {
    const content: any = bytes(value);
    const digestValue: any = `sha256:${sha256(content)}`;
    const absolutePath: any = path.join(root, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, { mode: 0o600 });
    inventoryEntries.push({
      path: relativePath,
      digest: digestValue,
      size: Buffer.byteLength(content),
      mode: 0o100600
    });
    return { digest: digestValue, size: Buffer.byteLength(content) };
  }

  for (let index: any = 0; index < ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length; index++) {
    const platform: any = ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS[index];
    const architecture: any = platform.split("/")[1];
    const osName: any = platform.split("/")[0];
    const config: Record<string, any> = {
      created: `2026-01-0${index + 1}T00:00:00Z`,
      architecture,
      os: osName,
      rootfs: { type: "layers", diff_ids: ["sha256:" + "0".repeat(64)] }
    };
    const layerContent: any = `${platform}-layer-data-${index}`;
    const [configBlob, layerBlob] = await Promise.all([
      writeBlob(`blobs/sha256/${sha256(stableJson(config))}`, stableJson(config)),
      writeBlob(`blobs/sha256/${sha256(layerContent)}`, layerContent)
    ]);
    const manifest: Record<string, any> = {
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configBlob.digest,
        size: configBlob.size
      },
      layers: [
        {
          mediaType: OCI_LAYER_MEDIA_TYPE,
          digest: layerBlob.digest,
          size: layerBlob.size,
        }
      ],
      platform: { os: osName, architecture }
    };
    const manifestBytes: any = stableJson(manifest);
    const manifestDigest: any = `sha256:${sha256(manifestBytes)}`;
    const manifestPath: any = `blobs/sha256/${manifestDigest.replace("sha256:", "")}`;
    await writeBlob(manifestPath, manifestBytes);
    descriptorEntries.push({
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      digest: manifestDigest,
      size: Buffer.byteLength(manifestBytes),
      platform
    });
    const attestationManifest: Record<string, any> = {
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configBlob.digest,
        size: configBlob.size
      },
      layers: [
        {
          mediaType: OCI_LAYER_MEDIA_TYPE,
          digest: layerBlob.digest,
          size: layerBlob.size,
        }
      ],
      subject: {
        mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        digest: manifestDigest,
        size: Buffer.byteLength(manifestBytes),
      },
      platform: {
        architecture: "unknown",
        os: "unknown"
      }
    };
    const attestationBytes: any = stableJson(attestationManifest);
    const attestationDigest: any = `sha256:${sha256(attestationBytes)}`;
    const attestationPath: any = `blobs/sha256/${attestationDigest.replace("sha256:", "")}`;
    await writeBlob(attestationPath, attestationBytes);
    attestationEntries.push({
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      digest: attestationDigest,
      size: Buffer.byteLength(attestationBytes),
      platform,
      subjectDigest: manifestDigest,
    });
  }

  const index: Record<string, any> = {
    schemaVersion: 2,
    mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    manifests: descriptorEntries.map((entry?: any) : any => ({
      mediaType: entry.mediaType,
      digest: entry.digest,
      size: entry.size,
      platform: {
        architecture: entry.platform.split("/")[1],
        os: entry.platform.split("/")[0]
      },
      annotations: {
        "org.opencontainers.image.platform": entry.platform
      }
    })),
  };
  for (const entry of attestationEntries) {
    index.manifests.push({
      mediaType: entry.mediaType,
      digest: entry.digest,
      size: entry.size,
      platform: {
        architecture: "unknown",
        os: "unknown"
      },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": entry.subjectDigest
      },
    });
  }
  const indexText: any = stableJson(index);
  const indexDigest: any = `sha256:${sha256(indexText)}`;
  const indexPath: any = `index.json`;
  await writeBlob(indexPath, indexText);
  await writeBlob("oci-layout", stableJson({ imageLayoutVersion: "1.0.0" }));

  const platformEvidence: any = ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.map((platform?: any) : any => {
    const subject: any = descriptorEntries.find((entry?: any) : any => entry.platform === platform);
    const attestation: any = attestationEntries.find((entry?: any) : any => entry.platform === platform);
    return {
      platform,
      subjectDigest: subject.digest,
      attestationDigest: attestation.digest,
    };
  });

  const authorityText: Record<string, any> = {
    image,
    digest: indexDigest,
    target: `${image}:1.2.3`,
    candidate: `${image}:candidate-${sourceCommit}`,
    reused: false,
    repository: "Acme/Meshrix",
    sourceRef: "refs/tags/v1.2.3",
    sourceCommit,
    sourceCandidate,
    workflowRef: "Acme/Meshrix/.github/workflows/release.yml@refs/tags/v1.2.3",
    manifestDescriptorText: JSON.stringify({ digest: indexDigest, mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE }),
    manifestText: indexText,
    provenanceText: JSON.stringify({
      ...(provenance(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS[0], sourceCommit)),
      ...(provenance(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS[1], sourceCommit))
    }),
    sbomText: JSON.stringify({
      ...(sbom(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS[0])),
      ...(sbom(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS[1]))
    }),
    platformEvidence
  };
  const releaseImageAuthority: any = buildReleaseImageAuthority(authorityText);
  const releaseImageEvidence: Readonly<Record<string, any>> = Object.freeze({
    target: authorityText.target,
    candidate: authorityText.candidate,
    reused: authorityText.reused,
    manifestDescriptorText: authorityText.manifestDescriptorText,
    manifestText: authorityText.manifestText,
    provenanceText: authorityText.provenanceText,
    sbomText: authorityText.sbomText,
  });

  return Object.freeze({
    root,
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
    sourceCommit,
    image,
    rootDigest: indexDigest,
    descriptors: descriptorEntries,
    inventorySeed: {
      schema_version: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
      candidate_digest: sourceCandidate.candidate_digest,
      image_digest: indexDigest,
      compose: {
        image: `${image}:candidate-${sourceCommit}`,
        pull_policy: "never"
      },
      platforms: [...ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS],
      files: inventoryEntries,
    },
    authorityText,
    ociFiles: descriptorEntries
  });
}

async function snapshotRegularFiles(rootPath?: any) : Promise<any> {
  const files: any[] = [];
  const queue: any[] = [rootPath];
  while (queue.length > 0) {
    const entryPath: any = queue.pop();
    const entries: any = await fs.readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      const full: any = path.join(entryPath, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else {
        const stat: any = await fs.stat(full);
        files.push({ path: full, stat });
      }
    }
  }
  return files;
}

function createSigner(seed?: any) : any {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyJwk: any = publicKey.export({ format: "jwk" });
  const keyId: any = `ed25519:${seed}-${sha256(String(seed)).slice(0, 16)}`;
  return {
    keyId,
    privateKey,
    publicKey,
    publicKeyJwk,
    async sign({ purpose, payloadDigest, context }: Record<string, any>) : Promise<any> {
      const contextDigest: any = `sha256:${sha256(stableJson(context || {}))}`;
      const safeReceipt: Readonly<Record<string, any>> = Object.freeze({
        receiptId: `${keyId}:${sha256(payloadDigest)}`,
        keyId,
        purpose,
        payloadDigest,
        signedAt: new Date().toISOString(),
      });
      const receipt: Readonly<Record<string, any>> = Object.freeze({
        ...safeReceipt,
        secretRevision: 1,
      });
      const signedEnvelope: Readonly<Record<string, any>> = Object.freeze({
        purpose,
        payloadDigest,
        contextDigest,
        receiptDigest: `sha256:${sha256(stableJson(safeReceipt))}`,
      });
      const signature: any = crypto.sign(null, Buffer.from(stableJson(signedEnvelope)), privateKey).toString("base64url");
      return Object.freeze({
        ok: true,
        keyId,
        algorithm: "ed25519",
        payloadEncoding: "sha256-digest-utf8",
        purpose,
        payloadDigest,
        contextDigest,
        signedEnvelope,
        signature,
        publicKeyJwk,
        receipt,
      });
    }
  };
}

async function assembleFixtureToDisk(fixture?: any, seed?: any) : Promise<any> {
  const signer: any = createSigner(seed);
  const outputRoot: any = await trackedTempRoot(`meshrix-offline-${seed}-`);
  const bundle: any = await assembleEnterpriseOfflineBundle({
    sourceCandidate: fixture.sourceCandidate,
    releaseImageAuthority: fixture.releaseImageAuthority,
    releaseImageEvidence: fixture.releaseImageEvidence,
    ociLayoutPath: fixture.root,
    artifactSigner: signer,
    trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
    outputRoot,
  });
  return {
    bundle,
    outputRoot,
    signer,
    trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
  };
}

afterEach(async () : Promise<any> => {
  await Promise.all(TMP_ROOTS.splice(0).map((root?: any) : any => fs.rm(root, { recursive: true, force: true })));
});

describe("enterprise single-node offline bundle frozen acceptance", () : any => {
  it("builds deterministic exact-key inventory and exact same digest for duplicate builds", async () : Promise<any> => {
    const outputA: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-a-")));
    const outputB: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-b-")));

    const [inventoryA, inventoryB] = await Promise.all([
      buildEnterpriseOfflineBundleInventory({
        sourceCandidate: outputA.sourceCandidate,
        releaseImageAuthority: outputA.releaseImageAuthority,
        releaseImageEvidence: outputA.releaseImageEvidence,
        ociLayoutPath: outputA.root,
      }),
      buildEnterpriseOfflineBundleInventory({
        sourceCandidate: reverseObjectEntries(outputB.sourceCandidate),
        releaseImageAuthority: reverseObjectEntries(outputB.releaseImageAuthority),
        releaseImageEvidence: reverseObjectEntries(outputB.releaseImageEvidence),
        ociLayoutPath: outputB.root,
      })
    ]);

    expect(inventoryA).toEqual(inventoryB);
    await Promise.all([
      validateEnterpriseOfflineBundleInventory({
        inventory: inventoryA,
        ociLayoutPath: outputA.root,
        sourceCandidate: outputA.sourceCandidate,
        releaseImageAuthority: outputA.releaseImageAuthority,
        releaseImageEvidence: outputA.releaseImageEvidence,
      }),
      validateEnterpriseOfflineBundleInventory({
        inventory: inventoryB,
        ociLayoutPath: outputB.root,
        sourceCandidate: reverseObjectEntries(outputB.sourceCandidate),
        releaseImageAuthority: reverseObjectEntries(outputB.releaseImageAuthority),
        releaseImageEvidence: reverseObjectEntries(outputB.releaseImageEvidence),
      }),
    ]);
    expect(inventoryA.inventory_digest).toMatch(SHA256);
    expect(inventoryA).toEqual(expect.objectContaining({
      schema_version: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
      image_digest: outputA.rootDigest,
      candidate_digest: outputA.sourceCandidate.candidate_digest,
      platforms: ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS,
      compose: expect.any(Object),
      files: expect.any(Array),
      inventory_digest: expect.stringMatching(SHA256),
    }));
    expect(exactKeys(inventoryA)).toEqual([
      "compose",
      "candidate_digest",
      "files",
      "image_digest",
      "inventory_digest",
      "platforms",
      "schema_version",
    ].sort());
  });

  it("requires real release authority fields and image-release consistency", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    expect(fixture.releaseImageAuthority.schemaVersion).toBe(RELEASE_IMAGE_AUTHORITY_SCHEMA);
    expect(fixture.releaseImageAuthority.candidateDigest).toMatch(SHA256);
    expect(fixture.releaseImageAuthority.sourceCommit).toBe(fixture.sourceCandidate.source_revision);
    expect(fixture.releaseImageAuthority.platforms).toEqual(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS);
    expect(fixture.releaseImageAuthority.platformEvidence).toHaveLength(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length);

    const inventory: any = await buildEnterpriseOfflineBundleInventory({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
    });
    expect(inventory.image_digest).toBe(fixture.rootDigest);
    expect(inventory.compose.image).toBe(`${fixture.image}@${fixture.rootDigest}`);
  });

  it("builds descriptor closure with exact platform digests/sizes/media for amd64 and arm64", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const inventory: any = await buildEnterpriseOfflineBundleInventory({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
    });

    expect(inventory.compose).toMatchObject({
      descriptor_closure: expect.arrayContaining(
        ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.map((platform?: any) : any => {
          const closure: any = fixture.descriptors.find((entry?: any) : any => entry.platform === platform);
          return {
            platform,
            mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
            digest: closure.digest,
            size: closure.size,
          };
        })
      )
    });
    expect(inventory.compose.descriptor_closure).toHaveLength(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length);
  });

  it("validates deterministic file inventory and rejects path traversal", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const base: Record<string, any> = {
      schema_version: "v0.0.1:meshrix:enterprise-single-node-offline-bundle-1",
      candidate_digest: fixture.sourceCandidate.candidate_digest,
      image_digest: fixture.rootDigest,
      compose: {
        descriptor_closure: [],
        pull_policy: "never",
      },
      platforms: [...ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS],
      files: [{ path: "../../etc/passwd", digest: `sha256:${"f".repeat(64)}`, size: 1 }],
    };
    await expect(validateEnterpriseOfflineBundleInventory({
      inventory: base,
      ociLayoutPath: fixture.root,
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
    })).rejects.toMatchObject({ code: "enterprise_offline_bundle_inventory_traversal_path" });
  });

  it("rejects extra file, symlink traversal, case collision, and executable files", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const base: Record<string, any> = {
      schema_version: "v0.0.1:meshrix:enterprise-single-node-offline-bundle-1",
      candidate_digest: fixture.sourceCandidate.candidate_digest,
      image_digest: fixture.rootDigest,
      compose: { descriptor_closure: [], pull_policy: "never" },
      platforms: [...ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS],
      files: [],
    };

    await fs.writeFile(path.join(fixture.root, "unexpected.txt"), "x", "utf8");
    await expect(validateEnterpriseOfflineBundleInventory({
      inventory: base,
      ociLayoutPath: fixture.root,
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
    })).rejects.toMatchObject({ code: "enterprise_offline_bundle_unexpected_file" });

    const symlinkFixture: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-symlink-"));
    const linkTarget: any = path.join(symlinkFixture, "real.txt");
    await fs.writeFile(linkTarget, "ok", "utf8");
    await fs.symlink(linkTarget, path.join(symlinkFixture, "linked.txt"));
    const symlinkInventory: Record<string, any> = {
      ...base,
      files: [{ path: "linked.txt", digest: `sha256:${sha256("ok")}`, size: 2, symlink: true }],
    };
    await expect(validateEnterpriseOfflineBundleInventory({
      inventory: symlinkInventory,
      ociLayoutPath: symlinkFixture,
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
    })).rejects.toMatchObject({ code: "enterprise_offline_bundle_symlink_denied" });

    const collisionInventory: Record<string, any> = {
      ...base,
      files: [
        { path: "Config.json", digest: `sha256:${"1".repeat(64)}`, size: 1 },
        { path: "config.json", digest: `sha256:${"2".repeat(64)}`, size: 1 },
      ],
    };
    await expect(validateEnterpriseOfflineBundleInventory({
      inventory: collisionInventory,
      ociLayoutPath: fixture.root,
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
    })).rejects.toMatchObject({ code: "enterprise_offline_bundle_case_collision" });

    const executableInventory: Record<string, any> = {
      ...base,
      files: [{ path: "scripts/run.sh", digest: `sha256:${"3".repeat(64)}`, size: 1, mode: 0o755 }],
    };
    await expect(validateEnterpriseOfflineBundleInventory({
      inventory: executableInventory,
      ociLayoutPath: fixture.root,
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
    })).rejects.toMatchObject({ code: "enterprise_offline_bundle_executable_file" });
  });

  it("assembles compose for immutable offline pull never and no build with optional service disabled", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const signer: any = createSigner("assemble");
    const outputRoot: any = await trackedTempRoot("meshrix-offline-compose-");

    const result: any = await assembleEnterpriseOfflineBundle({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
      optionalServiceEnabled: false,
      outputRoot,
    });

    expect(result.compose).toMatchObject({
      image: `${fixture.image}@${fixture.rootDigest}`,
      pull_policy: "never",
    });
    expect(result.compose.args).toEqual([
      "-f",
      "compose/compose.yaml",
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "meshrix-server",
    ]);
    expect(result.compose.optional_service).toBe(false);
    expect(result.signature.keyId).toBe(signer.keyId);
    expect(result.signature.publicKeyJwk).toBeUndefined();

    const composeText: any = await fs.readFile(
      path.join(outputRoot, "compose", "compose.yaml"),
      "utf8",
    );
    expect(composeText).toContain(`${fixture.image}@${fixture.rootDigest}`);
    expect(composeText).toMatch(/^services:\s*$/mu);
    expect(composeText).toMatch(/^  meshrix-server:\s*$/mu);
    expect(composeText).toMatch(/^\s*pull_policy:\s*["']?never["']?\s*$/mu);
    expect(composeText.match(/^\s*image\s*:/gmu) || []).toHaveLength(1);
    expect(composeText).not.toMatch(/^\s*build\s*:/mu);
    expect(composeText).not.toMatch(/^\s*profiles\s*:/mu);

    await expect(assembleEnterpriseOfflineBundle({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
      optionalServiceEnabled: true,
      outputRoot: await trackedTempRoot("meshrix-offline-optional-service-"),
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_optional_service_denied",
    });
  });

  it("generates signature without private/public material and verifier uses external keyring only", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const signer: any = createSigner("ring");
    const trustedPublicKeys: Record<string, any> = {
      [signer.keyId]: signer.publicKeyJwk
    };

    const assembled: any = await assembleEnterpriseOfflineBundle({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys,
      outputRoot: await trackedTempRoot("meshrix-offline-assembled-"),
    });

    expect(assembled.signature).toMatchObject({
      keyId: signer.keyId,
      algorithm: "ed25519",
      payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u)
    });
    expect(assembled.signature.publicKeyJwk).toBeUndefined();
    expect(assembled.signature.privateKeyJwk).toBeUndefined();

    await expect(verifyEnterpriseOfflineBundle({
      bundle: assembled,
      trustedPublicKeys
    })).resolves.toMatchObject({
      ok: true,
      keyId: signer.keyId
    });

    const wrongTrust: Record<string, any> = {
      [`${signer.keyId}-wrong`]: createSigner("wrong").publicKey.export({ format: "jwk" })
    };
    await expect(verifyEnterpriseOfflineBundle({ bundle: assembled, trustedPublicKeys: wrongTrust }))
      .rejects.toMatchObject({ code: "enterprise_offline_bundle_unknown_key" });
  });

  it("rejects wrong purpose, replay, and signature mismatch", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const signer: any = createSigner("reject");
    const trusted: Record<string, any> = {
      [signer.keyId]: signer.publicKeyJwk
    };
    const assembled: any = await assembleEnterpriseOfflineBundle({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys: trusted,
      outputRoot: await trackedTempRoot("meshrix-offline-assembled-"),
    });

    const wrongPurpose: Record<string, any> = {
      ...assembled,
      signature: {
        ...assembled.signature,
        purpose: "other-purpose"
      }
    };
    await expect(verifyEnterpriseOfflineBundle({ bundle: wrongPurpose, trustedPublicKeys: trusted }))
      .rejects.toMatchObject({ code: "enterprise_offline_bundle_signature_purpose_invalid" });

    const badSignature: Record<string, any> = {
      ...assembled,
      signature: {
        ...assembled.signature,
        signature: `bad-${assembled.signature.signature}`
      }
    };
    await expect(verifyEnterpriseOfflineBundle({ bundle: badSignature, trustedPublicKeys: trusted }))
      .rejects.toMatchObject({ code: "enterprise_offline_bundle_signature_invalid" });

    const replayGuard: Record<string, any> = {
      history: new Set<any>(),
      consume: async ({ signatureId }: Record<string, any>) : Promise<any> => {
        if (replayGuard.history.has(signatureId)) return false;
        replayGuard.history.add(signatureId);
        return true;
      }
    };
    const first: any = await verifyEnterpriseOfflineBundle({
      bundle: assembled,
      trustedPublicKeys: trusted,
      replayGuard
    });
    expect(first.ok).toBe(true);
    await expect(verifyEnterpriseOfflineBundle({
      bundle: assembled,
      trustedPublicKeys: trusted,
      replayGuard
    })).rejects.toMatchObject({ code: "enterprise_offline_bundle_signature_replay" });
  });

  it("returns only fixed receipt keys that are digest-bound into the signature", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const signer: any = createSigner("receipt");
    const assembled: any = await assembleEnterpriseOfflineBundle({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
      outputRoot: await trackedTempRoot("meshrix-offline-assembled-"),
    });

    const verified: any = await verifyEnterpriseOfflineBundle({
      bundle: assembled,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk }
    });
    expect(verified.receipt).toMatchObject({
      receiptId: expect.any(String),
      payloadDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      keyId: signer.keyId,
      purpose: "enterprise-offline-bundle",
      signedAt: expect.any(String),
    });
    expect(Object.keys(verified.receipt).sort()).toEqual([
      "keyId",
      "payloadDigest",
      "purpose",
      "receiptId",
      "signedAt"
    ]);
    expect(assembled.signature).not.toHaveProperty("ok");
    expect(assembled.signature.receipt).not.toHaveProperty("secretRevision");
    expect(assembled.signature.signedEnvelope.receiptDigest)
      .toMatch(/^sha256:[a-f0-9]{64}$/u);

    const changedReceipt: Record<string, any> = {
      ...assembled,
      signature: {
        ...assembled.signature,
        receipt: {
          ...assembled.signature.receipt,
          signedAt: "2026-01-02T00:00:00.000Z",
        },
      },
    };
    await expect(verifyEnterpriseOfflineBundle({
      bundle: changedReceipt,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_signature_invalid",
    });
  });

  it("runs deterministic no-network fixture verification with non-executable outputs", async () : Promise<any> => {
    const fixture: any = await writeTree(await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-bundle-")));
    const signer: any = createSigner("run");
    const networkClient: Record<string, any> = { request: vi.fn(async () : Promise<any> => { throw new Error("network should not be called"); }) };
    const processRunner: any = vi.fn(async () : Promise<any> => { throw new Error("process should not be called"); });
    const outputRoot: any = await trackedTempRoot("meshrix-offline-output-");
    const secondOutputRoot: any = await trackedTempRoot("meshrix-offline-output-second-");
    const replayGuard: Record<string, any> = {
      consume: vi.fn(async () : Promise<any> => true),
    };
    const secondReplayGuard: Record<string, any> = {
      consume: vi.fn(async () : Promise<any> => true),
    };

    const runResult: any = await runEnterpriseOfflineBundleFixture({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
      outputRoot,
      networkClient,
      processRunner,
      replayGuard,
    });
    const secondRunResult: any = await runEnterpriseOfflineBundleFixture({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: fixture.releaseImageEvidence,
      ociLayoutPath: fixture.root,
      artifactSigner: signer,
      trustedPublicKeys: { [signer.keyId]: signer.publicKeyJwk },
      outputRoot: secondOutputRoot,
      networkClient,
      processRunner,
      replayGuard: secondReplayGuard,
    });

    const files: any[] = [
      ...(await snapshotRegularFiles(outputRoot)),
      ...(await snapshotRegularFiles(secondOutputRoot)),
    ];
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((entry?: any) : any => entry.stat.isFile())).toBe(true);
    expect(files.every((entry?: any) : any => (entry.stat.mode & 0o111) === 0)).toBe(true);
    expect(networkClient.request).not.toHaveBeenCalled();
    expect(processRunner).not.toHaveBeenCalled();
    expect(replayGuard.consume).toHaveBeenCalled();
    expect(secondReplayGuard.consume).toHaveBeenCalled();
    expect(runResult.verified).toMatchObject({
      ok: true,
      filesystemVerified: true,
    });
    expect({
      schema_version: secondRunResult.schema_version,
      candidate_digest: secondRunResult.candidate_digest,
      image_digest: secondRunResult.image_digest,
      inventory_digest: secondRunResult.inventory_digest,
      keyId: secondRunResult.verified.keyId,
      payloadDigest: secondRunResult.verified.payloadDigest,
      purpose: secondRunResult.verified.purpose,
    }).toEqual({
      schema_version: runResult.schema_version,
      candidate_digest: runResult.candidate_digest,
      image_digest: runResult.image_digest,
      inventory_digest: runResult.inventory_digest,
      keyId: runResult.verified.keyId,
      payloadDigest: runResult.verified.payloadDigest,
      purpose: runResult.verified.purpose,
    });
    expect(runResult).not.toHaveProperty("outputRoot");
    expect(secondRunResult).not.toHaveProperty("outputRoot");
    expect(JSON.stringify([runResult, secondRunResult])).not.toContain(outputRoot);
    expect(JSON.stringify([runResult, secondRunResult])).not.toContain(secondOutputRoot);
    expect(JSON.stringify([runResult, secondRunResult])).not.toContain("secretRevision");
  });

  it("rejects changed release evidence bytes and evidence that cannot rebuild its authority", async () : Promise<any> => {
    const fixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-evidence-")),
    );
    const reformattedProvenance: any = JSON.stringify(
      JSON.parse(fixture.releaseImageEvidence.provenanceText),
      null,
      2,
    );

    await expect(buildEnterpriseOfflineBundleInventory({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: {
        ...fixture.releaseImageEvidence,
        provenanceText: reformattedProvenance,
      },
      ociLayoutPath: fixture.root,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_release_authority_evidence",
    });

    await expect(buildEnterpriseOfflineBundleInventory({
      sourceCandidate: fixture.sourceCandidate,
      releaseImageAuthority: fixture.releaseImageAuthority,
      releaseImageEvidence: {
        ...fixture.releaseImageEvidence,
        provenanceText: "{}",
      },
      ociLayoutPath: fixture.root,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_release_evidence_invalid",
    });
  });

  it("rejects same-size blob substitution, unreferenced blobs, and duplicate OCI descriptors", async () : Promise<any> => {
    const digestFixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-digest-")),
    );
    const runtimeDescriptor: any = digestFixture.descriptors[0];
    const manifestPath: any = path.join(
      digestFixture.root,
      "blobs",
      "sha256",
      runtimeDescriptor.digest.replace("sha256:", ""),
    );
    const manifest: any = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const layerPath: any = path.join(
      digestFixture.root,
      "blobs",
      "sha256",
      manifest.layers[0].digest.replace("sha256:", ""),
    );
    const originalLayer: any = await fs.readFile(layerPath);
    const replacedLayer: any = Buffer.from(originalLayer);
    replacedLayer[0] ^= 0x01;
    expect(replacedLayer.length).toBe(originalLayer.length);
    await fs.writeFile(layerPath, replacedLayer);

    await expect(buildEnterpriseOfflineBundleInventory({
      sourceCandidate: digestFixture.sourceCandidate,
      releaseImageAuthority: digestFixture.releaseImageAuthority,
      releaseImageEvidence: digestFixture.releaseImageEvidence,
      ociLayoutPath: digestFixture.root,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_oci_layer_digest",
    });

    const unreferencedFixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-unreferenced-")),
    );
    const unreferencedBytes: any = Buffer.from("unreferenced-blob", "utf8");
    const unreferencedPath: any = path.join(
      unreferencedFixture.root,
      "blobs",
      "sha256",
      sha256(unreferencedBytes),
    );
    await fs.writeFile(unreferencedPath, unreferencedBytes, { mode: 0o600 });

    await expect(buildEnterpriseOfflineBundleInventory({
      sourceCandidate: unreferencedFixture.sourceCandidate,
      releaseImageAuthority: unreferencedFixture.releaseImageAuthority,
      releaseImageEvidence: unreferencedFixture.releaseImageEvidence,
      ociLayoutPath: unreferencedFixture.root,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_unexpected_file",
    });

    const duplicateFixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-duplicate-")),
    );
    const indexPath: any = path.join(duplicateFixture.root, "index.json");
    const duplicateIndex: any = JSON.parse(await fs.readFile(indexPath, "utf8"));
    duplicateIndex.manifests.push({
      ...duplicateIndex.manifests[0],
      platform: { ...duplicateIndex.manifests[0].platform },
      annotations: { ...duplicateIndex.manifests[0].annotations },
    });
    const duplicateIndexText: any = stableJson(duplicateIndex);
    const duplicateDigest: any = `sha256:${sha256(duplicateIndexText)}`;
    const duplicateDescriptorText: any = JSON.stringify({
      digest: duplicateDigest,
      mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    });
    await fs.writeFile(indexPath, duplicateIndexText);

    await expect(buildEnterpriseOfflineBundleInventory({
      sourceCandidate: duplicateFixture.sourceCandidate,
      releaseImageAuthority: {
        ...duplicateFixture.releaseImageAuthority,
        digest: duplicateDigest,
        manifestDescriptorSha256: sha256(duplicateDescriptorText),
        manifestSha256: sha256(duplicateIndexText),
      },
      releaseImageEvidence: {
        ...duplicateFixture.releaseImageEvidence,
        manifestDescriptorText: duplicateDescriptorText,
        manifestText: duplicateIndexText,
      },
      ociLayoutPath: duplicateFixture.root,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_release_evidence_invalid",
    });
  });

  it("requires an external public-only Ed25519 JWK and rejects bundled or private key material", async () : Promise<any> => {
    const fixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-private-jwk-")),
    );
    const assembled: any = await assembleFixtureToDisk(fixture, "private-jwk");
    const privateKeyJwk: any = assembled.signer.privateKey.export({ format: "jwk" });

    await expect(verifyEnterpriseOfflineBundle({
      bundle: assembled.bundle,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_unknown_key",
    });

    await expect(verifyEnterpriseOfflineBundle({
      bundle: {
        ...assembled.bundle,
        signature: {
          ...assembled.bundle.signature,
          publicKeyJwk: assembled.signer.publicKeyJwk,
        },
      },
      trustedPublicKeys: {},
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_signature_invalid",
    });

    await expect(verifyEnterpriseOfflineBundle({
      bundle: assembled.bundle,
      trustedPublicKeys: {
        [assembled.signer.keyId]: privateKeyJwk,
      },
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_unknown_key",
    });
  });

  it("does not consume replay state for a cryptographically invalid signature", async () : Promise<any> => {
    const fixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-replay-order-")),
    );
    const assembled: any = await assembleFixtureToDisk(fixture, "replay-order");
    const invalidSignatureBytes: any = Buffer.from(
      assembled.bundle.signature.signature,
      "base64url",
    );
    invalidSignatureBytes[0] ^= 0x01;
    const invalidBundle: Record<string, any> = {
      ...assembled.bundle,
      signature: {
        ...assembled.bundle.signature,
        signature: invalidSignatureBytes.toString("base64url"),
      },
    };
    const replayGuard: Record<string, any> = {
      consume: vi.fn(async () : Promise<any> => true),
    };

    await expect(verifyEnterpriseOfflineBundle({
      bundle: invalidBundle,
      trustedPublicKeys: assembled.trustedPublicKeys,
      replayGuard,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_signature_invalid",
    });
    expect(replayGuard.consume).not.toHaveBeenCalled();
  });

  it("rejects deleted, modified, and appended files under bundleRoot", async () : Promise<any> => {
    const fixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-disk-mutation-")),
    );

    const deleted: any = await assembleFixtureToDisk(fixture, "disk-delete");
    await fs.rm(path.join(deleted.outputRoot, "evidence", "sbom.json"));
    await expect(verifyEnterpriseOfflineBundle({
      bundleRoot: deleted.outputRoot,
      trustedPublicKeys: deleted.trustedPublicKeys,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_file_unavailable",
    });

    const modified: any = await assembleFixtureToDisk(fixture, "disk-modify");
    await fs.writeFile(
      path.join(modified.outputRoot, "compose", "compose.json"),
      "{}\n",
      "utf8",
    );
    await expect(verifyEnterpriseOfflineBundle({
      bundleRoot: modified.outputRoot,
      trustedPublicKeys: modified.trustedPublicKeys,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_output_metadata_mismatch",
    });

    const appended: any = await assembleFixtureToDisk(fixture, "disk-append");
    await fs.writeFile(
      path.join(appended.outputRoot, "unexpected.txt"),
      "unexpected",
      { mode: 0o600 },
    );
    await expect(verifyEnterpriseOfflineBundle({
      bundleRoot: appended.outputRoot,
      trustedPublicKeys: appended.trustedPublicKeys,
    })).rejects.toMatchObject({
      code: "enterprise_offline_bundle_unexpected_file",
    });
  });

  it("writes an exact seven-key disk inventory and non-executable authority evidence", async () : Promise<any> => {
    const fixture: any = await writeTree(
      await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-disk-contract-")),
    );
    const assembled: any = await assembleFixtureToDisk(fixture, "disk-contract");
    const inventory: any = JSON.parse(
      await fs.readFile(
        path.join(assembled.outputRoot, "inventory", "inventory.json"),
        "utf8",
      ),
    );
    expect(exactKeys(inventory)).toEqual([
      "candidate_digest",
      "compose",
      "files",
      "image_digest",
      "inventory_digest",
      "platforms",
      "schema_version",
    ]);

    const authorityEvidencePaths: any[] = [
      "authorities/source-candidate.json",
      "authorities/release-image-authority.json",
      "evidence/coordinates.json",
      "evidence/manifest-descriptor.json",
      "evidence/manifest.json",
      "evidence/provenance.json",
      "evidence/sbom.json",
    ];
    const authorityEvidenceStats: any = await Promise.all(
      authorityEvidencePaths.map((relativePath?: any) : any => (
        fs.lstat(path.join(assembled.outputRoot, relativePath))
      )),
    );
    expect(authorityEvidenceStats.every((stat?: any) : any => stat.isFile())).toBe(true);
    expect(
      authorityEvidenceStats.every((stat?: any) : any => (stat.mode & 0o111) === 0),
    ).toBe(true);
    expect(
      await fs.readFile(
        path.join(assembled.outputRoot, "evidence", "manifest.json"),
        "utf8",
      ),
    ).toBe(fixture.releaseImageEvidence.manifestText);
    expect(
      await fs.readFile(
        path.join(assembled.outputRoot, "evidence", "provenance.json"),
        "utf8",
      ),
    ).toBe(fixture.releaseImageEvidence.provenanceText);
    expect(
      await fs.readFile(
        path.join(assembled.outputRoot, "evidence", "sbom.json"),
        "utf8",
      ),
    ).toBe(fixture.releaseImageEvidence.sbomText);
    await expect(verifyEnterpriseOfflineBundle({
      bundle: assembled.bundle,
      bundleRoot: assembled.outputRoot,
      trustedPublicKeys: assembled.trustedPublicKeys,
    })).resolves.toMatchObject({
      ok: true,
      filesystemVerified: true,
    });
  });
});
