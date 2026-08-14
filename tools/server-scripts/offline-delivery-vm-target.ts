#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { canonicalJson } from "../../packages/contracts/src/serialization/canonical-json.ts";
import { MCP_INTERFACE_VERSION } from "../../packages/protocols/mcp/adapter/http-mcp-adapter-constants.ts";
import {
  ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS,
} from "./enterprise-single-node-offline-bundle.ts";
import {
  ACCEPTANCE_REQUIRED_REPORTS,
  PLATFORM_ACCEPTANCE_COMMANDS,
} from "./lib/platform-acceptance-command-catalog.ts";
import {
  PLATFORM_ACCEPTANCE_PROFILES,
} from "./lib/platform-acceptance-contract.ts";
import {
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  buildReleaseImageAuthority,
} from "./lib/release-image-evidence.ts";
import {
  createReleaseEvidenceInventory,
  releaseEvidenceInventoryDigest,
} from "./lib/release-report-provenance.ts";
import { discoverReleaseSet } from "./publish-release-set.ts";
import {
  failOfflineDelivery,
  isRecord,
  probeDualArchLinuxBuilder,
  probeLinuxVmTarget,
} from "./offline-delivery-shared.ts";
import { buildReleaseCandidateIdentity } from "./verify-release-candidate-identity.ts";

const OCI_CONFIG_MEDIA_TYPE: any = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER_TAR_MEDIA_TYPE: any = "application/vnd.oci.image.layer.v1.tar";
const OCI_LAYER_GZIP_MEDIA_TYPE: any = "application/vnd.oci.image.layer.v1.tar+gzip";
const VM_REPOSITORY: any = "Meshrix-Platform/Meshrix.js";
const VM_IMAGE: any = "ghcr.io/meshrix-platform/meshrix";
const VM_SOURCE_REF: any = "refs/tags/v0.0.1";
const VM_IMAGE_TAG: any = `${VM_IMAGE}:offline-vm`;
const VM_HOST_PORT: any = 17328;
const RELEASE_DEFINITION_PATH: any = "tools/registry/release-definition.registry.json";
export const OFFLINE_VM_BUILD_TARGET: any = "runtime-ui";
export const OFFLINE_VM_SERVER_WITH_UI: any = "1";
export const OFFLINE_VM_CONSOLE_INDEX_PATH: any = "/app/build/dist/index.html";
export const OFFLINE_VM_ARM64_IMAGE: any = "local.example/meshrix-js/runtime-ui:offline-arm64";
export const OFFLINE_VM_AMD64_IMAGE: any = "local.example/meshrix-js/runtime-ui:offline-amd64";
export const OFFLINE_VM_LOADED_IMAGE: any = VM_IMAGE_TAG;
export const OFFLINE_VM_DEFAULT_HOST_PORT: any = VM_HOST_PORT;
export const OFFLINE_VM_PREFERRED_HOST_PORT: any = 7228;
const DEFAULT_ARM64_IMAGES: readonly any[] = Object.freeze([
  OFFLINE_VM_ARM64_IMAGE,
]);
const DEFAULT_AMD64_IMAGES: readonly any[] = Object.freeze([
  OFFLINE_VM_AMD64_IMAGE,
]);

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value?: any) : any {
  return `sha256:${sha256(value)}`;
}

function runCommand({
  executable,
  args = [],
  cwd,
  env,
  timeout = 60_000,
  allowFailure = false,
  code = "offline_delivery_vm_command_failed",
  message = "Linux VM command failed.",
}: Record<string, any> = {}) : any {
  const result: any = spawnSync(executable, args.map(String), {
    cwd,
    env: env || process.env,
    encoding: "utf8",
    timeout,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (allowFailure !== true && result.status !== 0) {
    failOfflineDelivery(code, message);
  }
  return result;
}

function imagePlatform(image?: any) : any {
  const result: any = runCommand({
    executable: "docker",
    args: ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image],
    allowFailure: true,
    timeout: 15_000,
  });
  if (result.status !== 0) return "";
  return String(result.stdout || "").trim();
}

function firstExistingImage(candidates?: any, expectedPlatform?: any) : any {
  for (const image of candidates) {
    if (typeof image !== "string" || image.trim() === "") continue;
    if (imagePlatform(image) !== expectedPlatform) continue;
    if (imageHasConsoleIndex({ image }) !== true) continue;
    return image;
  }
  return "";
}

export function imageHasConsoleIndex({
  image,
  commandRunner,
}: Record<string, any> = {}) : any {
  if (typeof image !== "string" || image.trim() === "") return false;
  const runner: any = typeof commandRunner === "function"
    ? commandRunner
    : (args?: any) : any => runCommand({
      executable: "docker",
      args,
      allowFailure: true,
      timeout: 30_000,
    });
  const result: any = runner([
    "run",
    "--rm",
    "--network",
    "none",
    "--entrypoint",
    "node",
    image,
    "-e",
    "process.exit(require('fs').existsSync('/app/build/dist/index.html')?0:1)",
  ]);
  return result?.status === 0;
}

export function assertOfflineRuntimeUiImage({
  image,
  commandRunner,
}: Record<string, any> = {}) : any {
  if (imageHasConsoleIndex({ image, commandRunner }) !== true) {
    failOfflineDelivery(
      "offline_delivery_runtime_ui_missing",
      "Offline delivery requires a Server + Web Console image.",
    );
  }
  return image;
}

export function isConsoleDocument({
  status,
  contentType,
  body,
}: Record<string, any> = {}) : any {
  return Number(status) === 200
    && /html/i.test(String(contentType || ""))
    && /<!doctype html|<html/i.test(String(body || ""));
}

export function linuxVmComposeEnvironment({
  hostPort = VM_HOST_PORT,
  custodyEnv = {},
}: Record<string, any> = {}) : any {
  return {
    ...process.env,
    ...custodyEnv,
    MESHRIX_BIND_ADDRESS: "127.0.0.1",
    MESHRIX_HOST_PORT: String(hostPort),
    MESHRIX_TRUSTED_PROXIES: "127.0.0.1",
    MESHRIX_PUBLIC_BASE_URL: "https://meshrix.example.com",
    MESHRIX_SERVER_WITH_UI: OFFLINE_VM_SERVER_WITH_UI,
  };
}

async function writeOciBlob(root?: any, bytes?: any) : Promise<any> {
  const value: any = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const hex: any = sha256(value);
  const relativePath: any = `blobs/sha256/${hex}`;
  const absolute: any = path.join(root, relativePath);
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await fs.writeFile(absolute, value, { mode: 0o600 });
  return Object.freeze({
    digest: `sha256:${hex}`,
    size: value.length,
    relativePath,
  });
}

function layerMediaType(fileName?: any) : any {
  return String(fileName || "").endsWith(".gz") || String(fileName || "").endsWith(".tgz")
    ? OCI_LAYER_GZIP_MEDIA_TYPE
    : OCI_LAYER_TAR_MEDIA_TYPE;
}

async function exportDockerImageToPlatformLayout({
  image,
  platform,
}: Record<string, any> = {}) : Promise<any> {
  const workRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-docker-save-"));
  try {
    const tarPath: any = path.join(workRoot, "image.tar");
    const extractRoot: any = path.join(workRoot, "extract");
    await fs.mkdir(extractRoot, { recursive: true, mode: 0o700 });
    runCommand({
      executable: "docker",
      args: ["save", "-o", tarPath, image],
      timeout: 180_000,
      code: "offline_delivery_vm_image_export_failed",
      message: "Linux VM image export failed.",
    });
    runCommand({
      executable: "tar",
      args: ["-xf", tarPath, "-C", extractRoot],
      timeout: 180_000,
      code: "offline_delivery_vm_image_export_failed",
      message: "Linux VM image export failed.",
    });
    const indexPath: any = path.join(extractRoot, "index.json");
    try {
      const index: any = JSON.parse(await fs.readFile(indexPath, "utf8"));
      const descriptor: any = (index.manifests || []).find((entry?: any) : any => (
        `${entry?.platform?.os}/${entry?.platform?.architecture}` === platform
      )) || (index.manifests || [])[0];
      if (!isRecord(descriptor) || typeof descriptor.digest !== "string") {
        failOfflineDelivery(
          "offline_delivery_vm_image_export_failed",
          "Linux VM image export failed.",
        );
      }
      const hex: any = String(descriptor.digest).replace(/^sha256:/u, "");
      const manifestBytes: any = await fs.readFile(path.join(extractRoot, "blobs", "sha256", hex));
      const manifest: any = JSON.parse(manifestBytes.toString("utf8"));
      const configHex: any = String(manifest.config.digest).replace(/^sha256:/u, "");
      const configBytes: any = await fs.readFile(path.join(extractRoot, "blobs", "sha256", configHex));
      const layers: any[] = [];
      for (const layer of manifest.layers || []) {
        const layerHex: any = String(layer.digest).replace(/^sha256:/u, "");
        layers.push(Object.freeze({
          mediaType: layer.mediaType || OCI_LAYER_TAR_MEDIA_TYPE,
          bytes: await fs.readFile(path.join(extractRoot, "blobs", "sha256", layerHex)),
        }));
      }
      return Object.freeze({
        platform,
        configBytes,
        layers: Object.freeze(layers),
      });
    } catch (error: any) {
      if (error?.code?.startsWith?.("offline_delivery_")) throw error;
    }
    const manifestList: any = JSON.parse(
      await fs.readFile(path.join(extractRoot, "manifest.json"), "utf8"),
    );
    const entry: any = Array.isArray(manifestList) ? manifestList[0] : null;
    if (!isRecord(entry) || typeof entry.Config !== "string" || !Array.isArray(entry.Layers)) {
      failOfflineDelivery(
        "offline_delivery_vm_image_export_failed",
        "Linux VM image export failed.",
      );
    }
    const configBytes: any = await fs.readFile(path.join(extractRoot, entry.Config));
    const layers: any[] = [];
    for (const layerPath of entry.Layers) {
      layers.push(Object.freeze({
        mediaType: layerMediaType(layerPath),
        bytes: await fs.readFile(path.join(extractRoot, layerPath)),
      }));
    }
    return Object.freeze({
      platform,
      configBytes,
      layers: Object.freeze(layers),
    });
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

async function writeDualArchOciLayout({
  outputRoot,
  platforms,
}: Record<string, any> = {}) : Promise<any> {
  await fs.mkdir(outputRoot, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(outputRoot, "oci-layout"),
    `${JSON.stringify({ imageLayoutVersion: "1.0.0" })}\n`,
    { mode: 0o600 },
  );
  const descriptors: any[] = [];
  for (const platform of ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS) {
    const exported: any = platforms[platform];
    if (!exported) {
      failOfflineDelivery(
        "offline_delivery_candidate_materials_missing",
        "Candidate-bound OCI materials are required.",
      );
    }
    const arch: any = String(platform).split("/")[1];
    const config: any = JSON.parse(exported.configBytes.toString("utf8"));
    if (config.os !== "linux" || config.architecture !== arch) {
      failOfflineDelivery(
        "offline_delivery_vm_image_export_failed",
        "Linux VM image export failed.",
      );
    }
    const configBlob: any = await writeOciBlob(outputRoot, exported.configBytes);
    const layerDescriptors: any[] = [];
    for (const layer of exported.layers) {
      const layerBlob: any = await writeOciBlob(outputRoot, layer.bytes);
      layerDescriptors.push({
        mediaType: layer.mediaType,
        digest: layerBlob.digest,
        size: layerBlob.size,
      });
    }
    const manifestBytes: any = Buffer.from(canonicalJson({
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configBlob.digest,
        size: configBlob.size,
      },
      layers: layerDescriptors,
      platform: { os: "linux", architecture: arch },
    }), "utf8");
    const manifestBlob: any = await writeOciBlob(outputRoot, manifestBytes);
    descriptors.push({
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      digest: manifestBlob.digest,
      size: manifestBlob.size,
      platform: { os: "linux", architecture: arch },
    });
    const attestationLayer: any = await writeOciBlob(
      outputRoot,
      Buffer.from(canonicalJson({
        payloadType: "application/vnd.in-toto+json",
        predicateType: "https://slsa.dev/provenance/v0.2",
        platform,
      }), "utf8"),
    );
    const attestationBytes: any = Buffer.from(canonicalJson({
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configBlob.digest,
        size: configBlob.size,
      },
      layers: [{
        mediaType: OCI_LAYER_TAR_MEDIA_TYPE,
        digest: attestationLayer.digest,
        size: attestationLayer.size,
      }],
      subject: {
        mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        digest: manifestBlob.digest,
        size: manifestBlob.size,
      },
      platform: { os: "unknown", architecture: "unknown" },
    }), "utf8");
    const attestationBlob: any = await writeOciBlob(outputRoot, attestationBytes);
    descriptors.push({
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      digest: attestationBlob.digest,
      size: attestationBlob.size,
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": manifestBlob.digest,
      },
    });
  }
  const indexText: any = canonicalJson({
    schemaVersion: 2,
    mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    manifests: descriptors.map((descriptor?: any) : any => {
      const entry: Record<string, any> = {
        mediaType: descriptor.mediaType,
        digest: descriptor.digest,
        size: descriptor.size,
      };
      if (descriptor.platform?.os === "unknown") {
        return {
          ...entry,
          platform: { os: "unknown", architecture: "unknown" },
          annotations: descriptor.annotations,
        };
      }
      return {
        ...entry,
        platform: descriptor.platform,
      };
    }),
  });
  await fs.writeFile(path.join(outputRoot, "index.json"), indexText, { mode: 0o600 });
  return Object.freeze({
    indexText,
    imageDigest: prefixedSha256(indexText),
  });
}

async function buildVmSourceCandidate(repoRoot?: any) : Promise<any> {
  const sourceRevision: any = String(runCommand({
    executable: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repoRoot,
    timeout: 15_000,
    code: "offline_delivery_vm_candidate_identity_failed",
    message: "Linux VM candidate identity failed.",
  }).stdout || "").trim();
  const tree: any = spawnSync("git", ["ls-tree", "-r", "-z", "--full-tree", "HEAD"], {
    cwd: repoRoot,
    encoding: "buffer",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (tree.status !== 0) {
    failOfflineDelivery(
      "offline_delivery_vm_candidate_identity_failed",
      "Linux VM candidate identity failed.",
    );
  }
  const releaseDefinition: any = await fs.readFile(path.join(repoRoot, RELEASE_DEFINITION_PATH));
  const packageLock: any = await fs.readFile(path.join(repoRoot, "package-lock.json"));
  const releaseSet: any = await discoverReleaseSet({ rootDir: repoRoot });
  const releasePackages: any = await Promise.all(
    releaseSet.packages.map(async (packageRecord?: any) : Promise<any> => {
      const manifestPath: any = packageRecord.directory === "."
        ? "package.json"
        : `${packageRecord.directory}/package.json`;
      const manifestBytes: any = await fs.readFile(path.join(repoRoot, manifestPath));
      return {
        manifest_path: manifestPath,
        name: packageRecord.name,
        version: packageRecord.version,
        manifest_sha256: sha256(manifestBytes),
      };
    }),
  );
  const profiles: any = Object.keys(PLATFORM_ACCEPTANCE_PROFILES).sort();
  if (profiles.length !== 1 || profiles[0] !== "enterprise-single-node") {
    failOfflineDelivery(
      "offline_delivery_vm_candidate_identity_failed",
      "Linux VM candidate identity failed.",
    );
  }
  const inventory: any = createReleaseEvidenceInventory({
    commands: PLATFORM_ACCEPTANCE_COMMANDS,
    requiredReportPaths: ACCEPTANCE_REQUIRED_REPORTS,
  });
  return buildReleaseCandidateIdentity({
    sourceRevision,
    repositoryTreeDigest: prefixedSha256(tree.stdout || Buffer.alloc(0)),
    releaseDefinitionSha256: prefixedSha256(releaseDefinition),
    packageLockSha256: prefixedSha256(packageLock),
    releasePackages,
    supportedProfiles: ["enterprise-single-node"],
    reportInventoryDigest: releaseEvidenceInventoryDigest(inventory),
  });
}

function buildVmProvenance({
  sourceCommit,
}: Record<string, any> = {}) : any {
  const startedOn: any = "2026-08-14T00:00:00.000Z";
  const finishedOn: any = "2026-08-14T00:00:01.000Z";
  return Object.fromEntries(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.map((platform?: any) : any => [
    platform,
    {
      SLSA: {
        buildType: "https://mobyproject.org/buildkit@v1",
        builder: { id: "https://github.com/Meshrix-Platform/Meshrix.js/actions" },
        invocation: {
          parameters: {
            frontend: "dockerfile.v0",
            args: {
              target: "runtime-ui",
              "build-arg:MESHRIX_SOURCE_REPOSITORY": VM_REPOSITORY,
              "build-arg:MESHRIX_SOURCE_REF": VM_SOURCE_REF,
              "build-arg:MESHRIX_SOURCE_COMMIT": sourceCommit,
            },
          },
          environment: { platform },
        },
        metadata: {
          buildInvocationID: `vm-${String(platform).replace("/", "-")}`,
          buildStartedOn: startedOn,
          buildFinishedOn: finishedOn,
          reproducible: true,
          completeness: { parameters: true, environment: true, materials: true },
          ["https://mobyproject.org/buildkit@v1#metadata"]: {
            vcs: {
              revision: sourceCommit,
              source: "https://github.com/Meshrix-Platform/Meshrix.js.git",
            },
            parameters: { output: platform },
          },
        },
        materials: [
          {
            uri: "git+https://github.com/Meshrix-Platform/Meshrix.js.git",
            digest: { sha256: sha256(sourceCommit) },
          },
        ],
      },
    },
  ]));
}

function buildVmSbom() : any {
  return Object.fromEntries(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.map((platform?: any) : any => [
    platform,
    {
      SPDX: {
        spdxVersion: "SPDX-2.3",
        SPDXID: "SPDXRef-DOCUMENT",
        dataLicense: "CC0-1.0",
        documentNamespace: `https://github.com/Meshrix-Platform/Meshrix.js/spdx#${platform}`,
        name: `meshrix-${String(platform).replace("/", "-")}`,
        creationInfo: { creators: ["Tool: meshrix-offline-linux-vm"] },
        packages: [{ SPDXID: "SPDXRef-Package-meshrix", name: "@meshrix/meshrix" }],
        relationships: [{
          spdxElementId: "SPDXRef-Package-meshrix",
          relatedSpdxElement: "SPDXRef-DOCUMENT",
          relationshipType: "CONTAINS",
        }],
      },
    },
  ]));
}

function createVmArtifactSigner() : any {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyJwk: any = publicKey.export({ format: "jwk" });
  const keyId: any = "offline-linux-vm";
  return Object.freeze({
    keyId,
    trustedPublicKeys: Object.freeze({ [keyId]: publicKeyJwk }),
    artifactSigner: Object.freeze({
      keyId,
      async sign({ purpose, payloadDigest, context }: Record<string, any>) : Promise<any> {
        const contextDigest: any = prefixedSha256(canonicalJson(context || {}));
        const safeReceipt: Record<string, any> = {
          receiptId: `${keyId}:${sha256(payloadDigest)}`,
          keyId,
          purpose,
          payloadDigest,
          signedAt: new Date().toISOString(),
        };
        const signedEnvelope: Record<string, any> = {
          purpose,
          payloadDigest,
          contextDigest,
          receiptDigest: prefixedSha256(canonicalJson(safeReceipt)),
        };
        const signature: any = crypto.sign(
          null,
          Buffer.from(canonicalJson(signedEnvelope), "utf8"),
          privateKey,
        ).toString("base64url");
        return {
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
          receipt: {
            ...safeReceipt,
            secretRevision: 1,
          },
        };
      },
    }),
  });
}

function buildRuntimeUiImage({
  repoRoot,
  platform,
  tag,
}: Record<string, any> = {}) : any {
  const sourceCommit: any = String(runCommand({
    executable: "git",
    args: ["rev-parse", "HEAD"],
    cwd: repoRoot,
    timeout: 15_000,
    allowFailure: true,
  }).stdout || "").trim();
  const result: any = runCommand({
    executable: "docker",
    args: [
      "buildx",
      "build",
      "--builder",
      "orbstack",
      "--platform",
      platform,
      "--target",
      OFFLINE_VM_BUILD_TARGET,
      "--build-arg",
      `MESHRIX_SOURCE_REPOSITORY=${VM_REPOSITORY}`,
      "--build-arg",
      `MESHRIX_SOURCE_REF=${VM_SOURCE_REF}`,
      "--build-arg",
      `MESHRIX_SOURCE_COMMIT=${sourceCommit}`,
      "-t",
      tag,
      "--load",
      ".",
    ],
    cwd: repoRoot,
    timeout: 3_600_000,
    allowFailure: true,
  });
  if (result.status !== 0) return "";
  return firstExistingImage([tag], platform);
}

function ensureAmd64Image({ repoRoot }: Record<string, any> = {}) : any {
  const existing: any = firstExistingImage([
    process.env.MESHRIX_OFFLINE_LINUX_AMD64_IMAGE,
    ...DEFAULT_AMD64_IMAGES,
  ], "linux/amd64");
  if (existing) return existing;
  return buildRuntimeUiImage({
    repoRoot,
    platform: "linux/amd64",
    tag: DEFAULT_AMD64_IMAGES[0],
  });
}

function ensureArm64Image({ repoRoot }: Record<string, any> = {}) : any {
  const existing: any = firstExistingImage([
    process.env.MESHRIX_OFFLINE_LINUX_ARM64_IMAGE,
    DEFAULT_ARM64_IMAGES[0],
  ], "linux/arm64");
  if (existing) return existing;
  return buildRuntimeUiImage({
    repoRoot,
    platform: "linux/arm64",
    tag: DEFAULT_ARM64_IMAGES[0],
  });
}

export function prepareOperatorSecretCustody({
  custodyRoot,
}: Record<string, any> = {}) : any {
  const master: any = process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE;
  const signer: any = process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE;
  if (typeof master === "string" && master.trim() !== "" && typeof signer === "string" && signer.trim() !== "") {
    return Object.freeze({
      configured: true,
      env: Object.freeze({
        MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE: master,
        MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE: signer,
      }),
    });
  }
  const masterPath: any = path.join(custodyRoot, "local-secret-master-key");
  const signerPath: any = path.join(custodyRoot, "operation-proof-signer-secret");
  const masterBytes: any = crypto.randomBytes(32).toString("hex");
  let signerBytes: any = crypto.randomBytes(32).toString("hex");
  while (signerBytes === masterBytes) {
    signerBytes = crypto.randomBytes(32).toString("hex");
  }
  return Object.freeze({
    configured: true,
    files: Object.freeze({
      [masterPath]: masterBytes,
      [signerPath]: signerBytes,
    }),
    env: Object.freeze({
      MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE: masterPath,
      MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE: signerPath,
    }),
  });
}

export function probeOfflineDeliveryVmEnvironment({
  spawn = spawnSync,
  platform = process.platform,
}: Record<string, any> = {}) : any {
  const vm: any = probeLinuxVmTarget({ spawn, platform });
  const builder: any = probeDualArchLinuxBuilder({ spawn });
  return Object.freeze({
    linuxVmTargetAvailable: vm.available === true,
    linuxVmTargetKind: vm.kind,
    dualArchBuilderAvailable: builder.available === true,
  });
}

export async function resolveOfflineDeliveryVmMaterials({
  repoRoot,
  ociLayoutOutput,
}: Record<string, any> = {}) : Promise<any> {
  if (typeof repoRoot !== "string" || typeof ociLayoutOutput !== "string") {
    return null;
  }
  try {
  const arm64Image: any = ensureArm64Image({ repoRoot });
  const amd64Image: any = ensureAmd64Image({ repoRoot });
  if (!arm64Image || !amd64Image) return null;
  assertOfflineRuntimeUiImage({ image: arm64Image });
  assertOfflineRuntimeUiImage({ image: amd64Image });
  const platforms: Record<string, any> = {
    "linux/arm64": await exportDockerImageToPlatformLayout({
      image: arm64Image,
      platform: "linux/arm64",
    }),
    "linux/amd64": await exportDockerImageToPlatformLayout({
      image: amd64Image,
      platform: "linux/amd64",
    }),
  };
  const layout: any = await writeDualArchOciLayout({
    outputRoot: ociLayoutOutput,
    platforms,
  });
  const sourceCandidate: any = await buildVmSourceCandidate(repoRoot);
  const sourceCommit: any = sourceCandidate.source_revision;
  const provenance: any = buildVmProvenance({ sourceCommit });
  const sbom: any = buildVmSbom();
  const authorityInput: Record<string, any> = {
    image: VM_IMAGE,
    digest: layout.imageDigest,
    target: `${VM_IMAGE}:0.0.1`,
    candidate: `${VM_IMAGE}:candidate-${sourceCommit}`,
    reused: false,
    repository: VM_REPOSITORY,
    sourceRef: VM_SOURCE_REF,
    sourceCommit,
    sourceCandidate,
    workflowRef: `${VM_REPOSITORY}/.github/workflows/release.yml@${VM_SOURCE_REF}`,
    manifestDescriptorText: JSON.stringify({
      digest: layout.imageDigest,
      mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    }),
    manifestText: layout.indexText,
    provenanceText: JSON.stringify(provenance),
    sbomText: JSON.stringify(sbom),
  };
  const releaseImageAuthority: any = buildReleaseImageAuthority(authorityInput);
  const signer: any = createVmArtifactSigner();
  return Object.freeze({
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence: Object.freeze({
      target: authorityInput.target,
      candidate: authorityInput.candidate,
      reused: false,
      manifestDescriptorText: authorityInput.manifestDescriptorText,
      manifestText: authorityInput.manifestText,
      provenanceText: authorityInput.provenanceText,
      sbomText: authorityInput.sbomText,
    }),
    ociLayoutPath: ociLayoutOutput,
    artifactSigner: signer.artifactSigner,
    trustedPublicKeys: signer.trustedPublicKeys,
  });
  } catch {
    return null;
  }
}

async function writeDockerArchiveFromOciPlatform({
  ociRoot,
  platform,
  outputTar,
  tag,
}: Record<string, any> = {}) : Promise<any> {
  const index: any = JSON.parse(await fs.readFile(path.join(ociRoot, "index.json"), "utf8"));
  const descriptor: any = (index.manifests || []).find((entry?: any) : any => (
    `${entry?.platform?.os}/${entry?.platform?.architecture}` === platform
  ));
  if (!isRecord(descriptor)) {
    failOfflineDelivery(
      "offline_delivery_vm_import_failed",
      "Linux VM import failed.",
    );
  }
  const manifestHex: any = String(descriptor.digest).replace(/^sha256:/u, "");
  const manifest: any = JSON.parse(
    await fs.readFile(path.join(ociRoot, "blobs", "sha256", manifestHex), "utf8"),
  );
  const workRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-offline-docker-load-"));
  try {
    const configHex: any = String(manifest.config.digest).replace(/^sha256:/u, "");
    const configName: any = `${configHex}.json`;
    await fs.copyFile(
      path.join(ociRoot, "blobs", "sha256", configHex),
      path.join(workRoot, configName),
    );
    const layers: any[] = [];
    for (const [indexValue, layer] of (manifest.layers || []).entries()) {
      const layerHex: any = String(layer.digest).replace(/^sha256:/u, "");
      const layerName: any = `${String(indexValue).padStart(3, "0")}-layer.tar`;
      const raw: any = await fs.readFile(path.join(ociRoot, "blobs", "sha256", layerHex));
      const bytes: any = String(layer.mediaType || "").includes("gzip")
        ? gunzipSync(raw)
        : raw;
      await fs.writeFile(path.join(workRoot, layerName), bytes, { mode: 0o600 });
      layers.push(layerName);
    }
    await fs.writeFile(
      path.join(workRoot, "manifest.json"),
      `${JSON.stringify([{
        Config: configName,
        RepoTags: [tag],
        Layers: layers,
      }])}\n`,
      { mode: 0o600 },
    );
    runCommand({
      executable: "tar",
      args: ["-cf", outputTar, "-C", workRoot, "manifest.json", configName, ...layers],
      timeout: 180_000,
      code: "offline_delivery_vm_import_failed",
      message: "Linux VM import failed.",
    });
  } finally {
    await fs.rm(workRoot, { recursive: true, force: true });
  }
}

async function waitForHttpOk(url?: any, timeoutMs?: any) : Promise<any> {
  const deadline: any = Date.now() + Number(timeoutMs || 180_000);
  while (Date.now() < deadline) {
    try {
      const response: any = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (response.ok === true) return true;
    } catch {
      // The VM health endpoint is polled until the start-period elapses.
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 2000));
  }
  return false;
}

export async function waitForConsoleRoot(url?: any, timeoutMs?: any) : Promise<any> {
  const deadline: any = Date.now() + Number(timeoutMs || 180_000);
  while (Date.now() < deadline) {
    try {
      const response: any = await fetch(url, { signal: AbortSignal.timeout(3000) });
      const body: any = await response.text();
      if (isConsoleDocument({
        status: response.status,
        contentType: response.headers.get("content-type"),
        body,
      }) === true) {
        return true;
      }
    } catch {
      // Console root is polled until the UI image finishes serving index.html.
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 2000));
  }
  return false;
}

async function runFirstGovernedCall() : Promise<any> {
  const script: any = `
try {
const content = await (await import("node:fs/promises")).readFile("/app/data/auth/initial-credentials.txt", "utf8");
const username = content.match(/^Username\\s*:\\s*(.+)$/m)?.[1]?.trim() || "owner";
const password = content.match(/^Password\\s*:\\s*(.+)$/m)?.[1]?.trim() || "";
if (!password) throw new Error("missing_initial_owner_password");
const login = await fetch("http://127.0.0.1:7228/api/auth/login", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password })
});
const loginPayload = await login.json();
if (login.status !== 200) throw new Error("owner_login_failed");
const cookie = (typeof login.headers.getSetCookie === "function"
  ? login.headers.getSetCookie()
  : String(login.headers.get("set-cookie") || "").split(/,(?=\\s*meshrix_)/).filter(Boolean))
  .map((item) => item.split(";")[0]).join("; ");
const commonHeaders = { Cookie: cookie };
const organizationResponse = await fetch("http://127.0.0.1:7228/api/authorization/organization-governance", { headers: commonHeaders });
const organization = await organizationResponse.json();
if (organization.snapshot?.configured !== true) {
  const mutationHeaders = {
    "Content-Type": "application/json",
    Cookie: cookie,
    "x-meshrix-csrf": loginPayload.csrfToken || "",
    "x-meshrix-safety-confirm": "true"
  };
  const importedResponse = await fetch("http://127.0.0.1:7228/api/authorization/organization-governance/import", {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ templateKey: "enterprise-group" })
  });
  const imported = await importedResponse.json();
  const publishedResponse = await fetch("http://127.0.0.1:7228/api/authorization/organization-governance/publish", {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ ...imported.draft, expectedRevision: Number(organization.snapshot?.revision || 0) })
  });
  if (publishedResponse.status !== 200) throw new Error("organization_publication_failed");
}
const scopesResponse = await fetch("http://127.0.0.1:7228/api/operation-permission/v1/api-keys/issuer-scopes", { headers: commonHeaders });
const catalogResponse = await fetch("http://127.0.0.1:7228/api/operation-permission/v1/catalog", { headers: commonHeaders });
const scopes = await scopesResponse.json();
const catalog = await catalogResponse.json();
const selectedToolsets = new Set(["meshrix.storage.read", "meshrix.console.read", "meshrix.gateway.read", "meshrix.runtime.read"]);
const selectedTools = (catalog.tools || [])
  .filter((tool) => (tool.toolsets || []).some((toolset) => selectedToolsets.has(toolset)));
const allowedTools = selectedTools.map((tool) => tool.id);
const scopeIds = [...new Set(selectedTools.flatMap((tool) => tool.requiredScopes || tool.scopes || []))];
const issuedResponse = await fetch("http://127.0.0.1:7228/api/operation-permission/v1/api-keys", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: cookie,
    "x-meshrix-csrf": loginPayload.csrfToken || "",
    "x-meshrix-safety-confirm": "true"
  },
  body: JSON.stringify({
    workloadDisplayName: "offline-linux-vm",
    organizationNodeId: scopes.eligibleNodes?.[0]?.nodeId || "",
    expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
    policy: {
      protocol: "mcp",
      serviceIds: [],
      capabilityIds: [],
      toolsetIds: [...selectedToolsets],
      allowedTools,
      deniedTools: [],
      scopeIds,
      maximumRisk: "high",
      audience: { serverAudience: "127.0.0.1:${VM_HOST_PORT}", targetIds: ["codex"], connectorPackageIds: [] },
      resources: {
        mode: "unrestricted", workspaceIds: [], dataClassifications: [], egressClasses: [],
        semanticFamilies: [], capabilityDomains: [], capabilityVerbs: [], resourceKinds: [],
        effectKinds: [], secretBindingIds: [], allowedOrigins: [], allowedCidrs: []
      },
      processIdentity: { mode: "optional" },
      limits: { maxUses: 16, requestsPerWindow: 16, windowSeconds: 3600, maxConcurrentEffects: 2 },
      catalogFingerprint: scopes.catalogFingerprint
    }
  })
});
const issued = await issuedResponse.json();
if (issuedResponse.status !== 201 || !issued.apiKey) throw new Error("api_key_issue_failed");
console.log(JSON.stringify({ ok: true, apiKey: issued.apiKey }));
} catch (error) {
  const code = String(error?.message || "api_key_issue_failed");
  console.log(JSON.stringify({ ok: false, code: /^[a-z0-9_]+$/u.test(code) ? code : "api_key_issue_failed" }));
}
`;
  const result: any = runCommand({
    executable: "docker",
    args: ["exec", "meshrix-server", "node", "--input-type=module", "-e", script],
    timeout: 120_000,
    allowFailure: true,
    code: "offline_delivery_lifecycle_failed",
    message: "Disconnected lifecycle step failed closed.",
  });
  const payload: any = JSON.parse(String(result.stdout || "{}"));
  const apiKey: any = typeof payload.apiKey === "string" ? payload.apiKey : "";
  if (payload.ok !== true || !apiKey) {
    failOfflineDelivery(
      typeof payload.code === "string" && /^[a-z0-9_]+$/u.test(payload.code)
        ? payload.code
        : "api_key_issue_failed",
      "Disconnected lifecycle step failed closed.",
    );
  }
  const mcpUrl: any = `http://127.0.0.1:${VM_HOST_PORT}/mcp`;
  const origin: any = `http://127.0.0.1:${VM_HOST_PORT}`;
  const commonMcpHeaders: any = {
    "Content-Type": "application/json",
    Origin: origin,
    "MCP-Protocol-Version": "2025-06-18",
  };
  const initializeResponse: any = await fetch(mcpUrl, {
    method: "POST",
    headers: commonMcpHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "offline-linux-vm", version: "0.0.0" },
      },
    }),
  });
  const initializePayload: any = await initializeResponse.json().catch(() : any => ({}));
  if (initializeResponse.ok !== true || initializePayload.error || initializePayload.result?.serverInfo?.name !== "Meshrix.js") {
    failOfflineDelivery(
      "first_governed_call_initialize_failed",
      "Disconnected lifecycle step failed closed.",
    );
  }
  const mcpResponse: any = await fetch(mcpUrl, {
    method: "POST",
    headers: {
      ...commonMcpHeaders,
      "X-Meshrix.js-Api-Key": apiKey,
      "X-Meshrix.js-MCP-Target": "codex",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "meshrix.discovery",
        arguments: {
          apiVersion: MCP_INTERFACE_VERSION,
          operation: "system.health",
          input: {},
          clientVersion: "offline-linux-vm",
        },
      },
    }),
  });
  const mcpPayload: any = await mcpResponse.json().catch(() : any => ({}));
  const health: any = mcpPayload.result?.structuredContent || {};
  const rpcCode: any = typeof mcpPayload.error?.data?.code === "string"
    ? mcpPayload.error.data.code
    : "";
  if (mcpResponse.status !== 200) {
    const statusCode: any = Number(mcpResponse.status);
    failOfflineDelivery(
      /^[a-z0-9_]+$/u.test(rpcCode)
        ? rpcCode
        : Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599
          ? `first_governed_call_http_${statusCode}`
          : "first_governed_call_http_failed",
      "Disconnected lifecycle step failed closed.",
    );
  }
  if (mcpPayload.error || mcpPayload.result?.isError === true) {
    failOfflineDelivery(
      /^[a-z0-9_]+$/u.test(rpcCode) ? rpcCode : "first_governed_call_rpc_failed",
      "Disconnected lifecycle step failed closed.",
    );
  }
  if (health.payload?.ok !== true && health.ok !== true) {
    failOfflineDelivery(
      "first_governed_call_health_failed",
      "Disconnected lifecycle step failed closed.",
    );
  }
  return true;
}

export function createLinuxVmLifecycleRunner({
  targetRoot,
  custodyEnv = {},
  hostPort = VM_HOST_PORT,
}: Record<string, any> = {}) : any {
  const composeEnv: any = linuxVmComposeEnvironment({ hostPort, custodyEnv });
  const overridePath: any = path.join(os.tmpdir(), `meshrix-offline-compose-override-${process.pid}.yaml`);
  return async function commandRunner(step?: any) : Promise<any> {
    if (!isRecord(step) || typeof step.id !== "string") {
      failOfflineDelivery(
        "offline_delivery_lifecycle_step_invalid",
        "Lifecycle step is invalid.",
      );
    }
    if (step.id === "import") {
      const platform: any = `linux/${String(runCommand({
        executable: "docker",
        args: ["version", "--format", "{{.Server.Arch}}"],
        timeout: 15_000,
        code: "offline_delivery_vm_import_failed",
        message: "Linux VM import failed.",
      }).stdout || "").trim() || "arm64"}`;
      const tarPath: any = path.join(os.tmpdir(), `meshrix-offline-import-${process.pid}.tar`);
      await writeDockerArchiveFromOciPlatform({
        ociRoot: path.join(targetRoot, "files"),
        platform: ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.includes(platform) ? platform : "linux/arm64",
        outputTar: tarPath,
        tag: VM_IMAGE_TAG,
      });
      try {
        runCommand({
          executable: "docker",
          args: ["load", "-i", tarPath],
          timeout: 180_000,
          code: "offline_delivery_vm_import_failed",
          message: "Linux VM import failed.",
        });
      } finally {
        await fs.rm(tarPath, { force: true });
      }
      return { ok: true };
    }
    if (step.id === "start") {
      await fs.writeFile(
        overridePath,
        [
          "services:",
          "  meshrix-server:",
          `    image: ${VM_IMAGE_TAG}`,
          "    pull_policy: never",
          "    environment:",
          `      MESHRIX_SERVER_WITH_UI: "${OFFLINE_VM_SERVER_WITH_UI}"`,
          "      MESHRIX_PRODUCTION_INGRESS_MODE: \"\"",
          "      MESHRIX_COOKIE_SECURE: auto",
          "      MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY: development",
          "      MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE: \"\"",
          "      MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE: \"\"",
          `      MESHRIX_PUBLIC_BASE_URL: http://127.0.0.1:${hostPort}`,
          `      MESHRIX_BOOTSTRAP_URL: http://127.0.0.1:${hostPort}`,
          `      MESHRIX_ADVERTISED_BASE_URL: http://127.0.0.1:${hostPort}`,
          `      MESHRIX_ACTIVE_SERVICE_URL: http://127.0.0.1:${hostPort}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      runCommand({
        executable: "docker",
        args: [
          "compose",
          "-p",
          "meshrix-offline-vm",
          "-f",
          "compose/compose.yaml",
          "-f",
          overridePath,
          "up",
          "-d",
          "--no-build",
          "--pull",
          "never",
          "--wait",
          "meshrix-server",
        ],
        cwd: targetRoot,
        env: composeEnv,
        timeout: 240_000,
        code: "offline_delivery_lifecycle_failed",
        message: "Disconnected lifecycle step failed closed.",
      });
      const healthy: any = await waitForHttpOk(
        `http://127.0.0.1:${hostPort}/api/healthz`,
        180_000,
      );
      if (healthy !== true) {
        failOfflineDelivery(
          "offline_delivery_lifecycle_failed",
          "Disconnected lifecycle step failed closed.",
        );
      }
      const consoleReady: any = await waitForConsoleRoot(
        `http://127.0.0.1:${hostPort}/`,
        60_000,
      );
      if (consoleReady !== true) {
        failOfflineDelivery(
          "offline_delivery_console_required",
          "Offline delivery requires the Web Console root to load.",
        );
      }
      return { ok: true };
    }
    if (step.id === "first_governed_call") {
      await runFirstGovernedCall();
      return { ok: true };
    }
    if (step.id === "stop") {
      runCommand({
        executable: "docker",
        args: [
          "compose",
          "-p",
          "meshrix-offline-vm",
          "-f",
          "compose/compose.yaml",
          "-f",
          overridePath,
          "stop",
          "meshrix-server",
        ],
        cwd: targetRoot,
        env: composeEnv,
        timeout: 120_000,
        code: "offline_delivery_lifecycle_failed",
        message: "Disconnected lifecycle step failed closed.",
      });
      return { ok: true };
    }
    if (step.id === "cleanup") {
      runCommand({
        executable: "docker",
        args: [
          "compose",
          "-p",
          "meshrix-offline-vm",
          "-f",
          "compose/compose.yaml",
          "-f",
          overridePath,
          "down",
          "--remove-orphans",
          "--volumes",
        ],
        cwd: targetRoot,
        env: composeEnv,
        timeout: 120_000,
        allowFailure: true,
      });
      await fs.rm(overridePath, { force: true });
      return { ok: true };
    }
    failOfflineDelivery(
      "offline_delivery_lifecycle_step_invalid",
      "Disconnected lifecycle step set is incomplete.",
    );
  };
}
