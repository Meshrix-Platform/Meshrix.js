#!/usr/bin/env node
import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../../packages/contracts/src/serialization/canonical-json.ts";
import {
  validateReleaseCandidateIdentity,
  buildReleaseCandidateIdentity,
} from "./verify-release-candidate-identity.ts";
import {
  RELEASE_IMAGE_AUTHORITY_SCHEMA,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  buildReleaseImageAuthority,
} from "./lib/release-image-evidence.ts";

export const ENTERPRISE_OFFLINE_BUNDLE_SCHEMA: any =
  "v0.0.1:meshrix:enterprise-single-node-offline-bundle-1";
export const ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS: readonly any[] = Object.freeze([
  "linux/amd64",
  "linux/arm64",
]);

const SIGNING_PURPOSE: any = "enterprise-offline-bundle";
const DIGEST_PATTERN: any = /^[a-f0-9]{64}$/u;
const DIGEST_WITH_ALGO_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const INVENTORY_KEYS: readonly any[] = Object.freeze([
  "schema_version",
  "candidate_digest",
  "image_digest",
  "platforms",
  "compose",
  "files",
  "inventory_digest",
]);
const INVENTORY_FILE_NAME: any = "inventory.json";
const BUNDLE_FILE_NAME: any = "bundle.json";
const COMPOSE_FILE_NAME: any = "compose.json";
const SIGNATURE_FILE_NAME: any = "signature.json";
const OCI_CONFIG_MEDIA_TYPE: any = "application/vnd.oci.image.config.v1+json";
const OCI_LAYER_MEDIA_TYPE: any = "application/vnd.oci.image.layer.v1.tar+gzip";
const OCI_LAYER_MEDIA_TYPES: any = new Set<any>([
  OCI_LAYER_MEDIA_TYPE,
  "application/vnd.oci.image.layer.v1.tar",
  "application/vnd.oci.image.layer.v1.tar+zstd",
]);
const SIGNATURE_ALGORITHM: any = "ed25519";
const SIGNATURE_PAYLOAD_ENCODING: any = "sha256-digest-utf8";
const SAFE_RECEIPT_FIELDS: readonly any[] = Object.freeze([
  "receiptId",
  "payloadDigest",
  "keyId",
  "purpose",
  "signedAt",
]);
const SIGNER_RECEIPT_KEYS: readonly any[] = Object.freeze([
  ...SAFE_RECEIPT_FIELDS,
  "secretRevision",
]);
const OFFLINE_COMPOSE_ARGS: readonly any[] = Object.freeze([
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
const SIGNATURE_KEYS: readonly any[] = Object.freeze([
  "keyId",
  "algorithm",
  "payloadEncoding",
  "purpose",
  "payloadDigest",
  "contextDigest",
  "signedEnvelope",
  "signature",
  "receipt",
]);
const BUNDLE_KEYS: readonly any[] = Object.freeze([
  "schema_version",
  "candidate_digest",
  "image_digest",
  "platforms",
  "compose",
  "files",
  "inventory_digest",
  "authorities",
  "signature",
]);
const UNSIGNED_BUNDLE_KEYS: any = Object.freeze(
  BUNDLE_KEYS.filter((key?: any) : any => key !== "signature"),
);
const RELEASE_AUTHORITY_KEYS: readonly any[] = Object.freeze([
  "schemaVersion",
  "repository",
  "sourceCommit",
  "sourceRef",
  "candidateDigest",
  "workflowRef",
  "image",
  "digest",
  "platforms",
  "platformEvidence",
  "provenancePredicateType",
  "provenanceBuildType",
  "sbomFormat",
  "manifestDescriptorSha256",
  "manifestSha256",
  "provenanceSha256",
  "sbomSha256",
  "provenanceVerified",
  "sbomVerified",
]);
const RELEASE_EVIDENCE_KEYS: readonly any[] = Object.freeze([
  "target",
  "candidate",
  "reused",
  "manifestDescriptorText",
  "manifestText",
  "provenanceText",
  "sbomText",
]);
const KEY_ID_PATTERN: any = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u;
const BASE64URL_PATTERN: any = /^[A-Za-z0-9_-]+$/u;
const IMAGE_NAME_PATTERN: any =
  /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+$/u;
const MAX_BUNDLE_FILES: any = 100_000;
const MAX_BUNDLE_ENTRIES: any = 200_000;
const MAX_BUNDLE_DEPTH: any = 32;
const MAX_SINGLE_FILE_BYTES: any = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: any = 64 * 1024 * 1024 * 1024;
const MAX_JSON_BYTES: any = 16 * 1024 * 1024;
const MAX_RELEASE_EVIDENCE_BYTES: any = 128 * 1024 * 1024;
const MAX_BUNDLE_METADATA_BYTES: any = 256 * 1024 * 1024;

function fail(code?: any, message?: any) : any {
  const error: Error & Record<string, any> = new Error(message);
  error.code = code;
  throw error;
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function prefixedSha256(value?: any) : any {
  return `sha256:${sha256(value)}`;
}

function isObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value?: any, expected?: any) : any {
  return (
    isObject(value)
    && JSON.stringify(Object.keys(value).sort())
      === JSON.stringify([...expected].sort())
  );
}

function compareText(left?: any, right?: any) : any {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isPathWithin(root?: any, candidate?: any) : any {
  const relative: any = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".."
    && !path.isAbsolute(relative);
}

function buildOfflineComposeYaml(image?: any) : any {
  requireString(
    image,
    new RegExp(`${IMAGE_NAME_PATTERN.source.slice(1, -1)}@${DIGEST_WITH_ALGO_PATTERN.source.slice(1, -1)}`, "u"),
    "enterprise_offline_bundle_compose_invalid",
    "Offline Compose image is invalid.",
  );
  return [
    "services:",
    "  meshrix-server:",
    `    image: ${image}`,
    "    pull_policy: never",
    "    container_name: meshrix-server",
    "    restart: unless-stopped",
    "    init: true",
    '    user: "10001:10001"',
    "    read_only: true",
    "    security_opt:",
    "      - no-new-privileges:true",
    "    cap_drop:",
    "      - ALL",
    "    stop_signal: SIGTERM",
    "    stop_grace_period: 90s",
    "    tmpfs:",
    "      - /tmp:rw,noexec,nosuid,nodev,mode=1777",
    "    healthcheck:",
    "      test: [\"CMD\", \"node\", \"-e\", \"fetch('http://127.0.0.1:7228/api/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))\"]",
    "      interval: 30s",
    "      timeout: 5s",
    "      retries: 5",
    "      start_period: 60s",
    "    ports:",
    '      - "${MESHRIX_BIND_ADDRESS:-127.0.0.1}:${MESHRIX_HOST_PORT:-7228}:7228"',
    "    environment:",
    "      MESHRIX_SERVER_HOST: 0.0.0.0",
    "      MESHRIX_SERVER_PORT: 7228",
    "      MESHRIX_SERVER_DATA_DIR: data",
    '      MESHRIX_SERVER_WITH_UI: "${MESHRIX_SERVER_WITH_UI:-1}"',
    "      MESHRIX_RUNTIME_CONFIG: ${MESHRIX_RUNTIME_CONFIG:-}",
    "      MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE: /run/secrets/meshrix-local-secret-master-key",
    "      MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY: production",
    "      MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE: /run/secrets/meshrix-operation-proof-signer-secret",
    "      MESHRIX_PRODUCTION_INGRESS_MODE: trusted-proxy",
    "      MESHRIX_TRUSTED_PROXIES: ${MESHRIX_TRUSTED_PROXIES:?MESHRIX_TRUSTED_PROXIES is required}",
    "      MESHRIX_COOKIE_SECURE: always",
    "      MESHRIX_BACKUP_ROOT: /app/backups",
    '      MESHRIX_REQUIRE_INDEPENDENT_BACKUP_ROOT: "1"',
    "      MESHRIX_BOOTSTRAP_URL: ${MESHRIX_PUBLIC_BASE_URL:?MESHRIX_PUBLIC_BASE_URL is required}",
    "      MESHRIX_ADVERTISED_BASE_URL: ${MESHRIX_PUBLIC_BASE_URL:?MESHRIX_PUBLIC_BASE_URL is required}",
    "      MESHRIX_ACTIVE_SERVICE_URL: ${MESHRIX_PUBLIC_BASE_URL:?MESHRIX_PUBLIC_BASE_URL is required}",
    "    secrets:",
    "      - source: meshrix-local-secret-master-key",
    "        target: meshrix-local-secret-master-key",
    "      - source: meshrix-operation-proof-signer-secret",
    "        target: meshrix-operation-proof-signer-secret",
    "    volumes:",
    "      - meshrix-server-data:/app/data",
    "      - meshrix-server-backups:/app/backups",
    "      - meshrix-codex-home:/codex-home",
    "    networks:",
    "      - meshrix-core",
    "secrets:",
    "  meshrix-local-secret-master-key:",
    "    file: ${MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE:?MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE is required}",
    "  meshrix-operation-proof-signer-secret:",
    "    file: ${MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE:?MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE is required}",
    "volumes:",
    "  meshrix-server-data:",
    "  meshrix-server-backups:",
    "  meshrix-codex-home:",
    "networks:",
    "  meshrix-core: {}",
    "",
  ].join("\n");
}

function safeRelativePath(candidate?: any) : any {
  if (
    typeof candidate !== "string" ||
    candidate === "" ||
    candidate.includes("\\") ||
    /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(candidate)
  ) {
    return null;
  }
  if (path.isAbsolute(candidate)) {
    return null;
  }
  const segments: any = candidate.split("/");
  if (
    segments.some(
      (segment?: any) : any => (
        segment === ""
        || segment === "."
        || segment === ".."
        || segment.trim() !== segment
      ),
    )
  ) {
    return null;
  }
  const normalized: any = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("../") ||
    normalized.includes("/../") ||
    normalized.endsWith("/..")
  ) {
    return null;
  }
  const normalizedNfc: any = normalized.normalize("NFC");
  if (normalized !== normalizedNfc) {
    return null;
  }
  return normalized;
}

function parseJsonText(text?: any, code?: any) : any {
  const payload: any = String(text || "").trim();
  if (!payload) {
    fail(code || "enterprise_offline_bundle_payload_missing", "Payload is missing.");
  }
  try {
    return JSON.parse(payload);
  } catch {
    fail(code || "enterprise_offline_bundle_payload_invalid", "Payload is not valid JSON.");
  }
}

function requireString(value?: any, pattern?: any, code?: any, message?: any) : any {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(code, message);
  }
  return value;
}

function parseDigest(input?: any) : any {
  return requireString(
    input,
    DIGEST_WITH_ALGO_PATTERN,
    "enterprise_offline_bundle_digest_invalid",
    "A digest must be a prefixed sha256 value.",
  );
}

function validateInventoryPaths(entries?: any) : any {
  if (!Array.isArray(entries)) {
    fail("enterprise_offline_bundle_files_invalid", "Inventory files must be an array.");
  }
  const rawKeys: any = new Set<any>();
  const canonicalKeys: any = new Set<any>();
  const canonicalPrefixes: any = new Map<any, any>();
  const out: any[] = [];
  for (const item of entries) {
    if (!isObject(item)) {
      fail("enterprise_offline_bundle_file_entry_invalid", "Inventory file entry is invalid.");
    }
    const normalized: any = safeRelativePath(item.path);
    if (!normalized) {
      fail(
        "enterprise_offline_bundle_inventory_traversal_path",
        "Inventory file path is invalid.",
      );
    }
    if (rawKeys.has(normalized)) {
      fail("enterprise_offline_bundle_file_duplicate", "Inventory contains duplicated path.");
    }
    rawKeys.add(normalized);
    const folded: any = normalized.toLowerCase();
    if (canonicalKeys.has(folded)) {
      fail(
        "enterprise_offline_bundle_case_collision",
        "Inventory contains a case/Unicode collision.",
      );
    }
    canonicalKeys.add(folded);
    const segments: any = normalized.split("/");
    for (let indexValue: any = 1; indexValue <= segments.length; indexValue += 1) {
      const rawPrefix: any = segments.slice(0, indexValue).join("/");
      const foldedPrefix: any = rawPrefix.toLowerCase();
      const priorPrefix: any = canonicalPrefixes.get(foldedPrefix);
      if (priorPrefix !== undefined && priorPrefix !== rawPrefix) {
        fail(
          "enterprise_offline_bundle_case_collision",
          "Inventory contains a case/Unicode path-prefix collision.",
        );
      }
      canonicalPrefixes.set(foldedPrefix, rawPrefix);
    }
    out.push({
      ...item,
      path: normalized,
    });
  }
  return Object.freeze(out);
}

function assertNoSymlinkOrSpecial(stat?: any, label?: any) : any {
  if (stat.isSymbolicLink()) {
    fail("enterprise_offline_bundle_symlink_denied", `${label} is a symlink.`);
  }
  if (!stat.isFile()) {
    fail("enterprise_offline_bundle_special_file", `${label} is not a regular file.`);
  }
  if ((stat.mode & 0o111) !== 0) {
    fail("enterprise_offline_bundle_executable_file", `${label} is executable.`);
  }
}

async function readRegularFileNoFollow(
  root?: any,
  relativePath?: any,
  {
    captureBytes = true,
    maxCaptureBytes = MAX_JSON_BYTES,
    destinationPath,
    expectedMode,
  }: Record<string, any> = {},
) : Promise<any> {
  const normalized: any = safeRelativePath(relativePath);
  if (!normalized) {
    fail(
      "enterprise_offline_bundle_inventory_traversal_path",
      "Bundle file path is invalid.",
    );
  }
  const rootRealPath: any = await fs.realpath(root);
  const absolutePath: any = path.resolve(root, normalized.split("/").join(path.sep));
  if (!isPathWithin(path.resolve(root), absolutePath)) {
    fail(
      "enterprise_offline_bundle_inventory_traversal_path",
      "Bundle file escapes its root.",
    );
  }

  let resolvedPath: any;
  try {
    resolvedPath = await fs.realpath(absolutePath);
  } catch {
    fail("enterprise_offline_bundle_file_unavailable", "Bundle file is unavailable.");
  }
  if (!isPathWithin(rootRealPath, resolvedPath)) {
    fail("enterprise_offline_bundle_symlink_denied", "Bundle file resolves outside its root.");
  }

  let handle: any;
  let destinationHandle: any;
  try {
    handle = await fs.open(
      absolutePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0),
    );
    const before: any = await handle.stat();
    assertNoSymlinkOrSpecial(before, normalized);
    if (
      expectedMode !== undefined
      && (before.mode & 0o777) !== expectedMode
    ) {
      fail(
        "enterprise_offline_bundle_file_mode_invalid",
        "Bundle file mode is invalid.",
      );
    }
    if (before.nlink !== 1) {
      fail("enterprise_offline_bundle_hardlink_denied", "Hard-linked bundle files are denied.");
    }
    if (before.size > MAX_SINGLE_FILE_BYTES) {
      fail("enterprise_offline_bundle_file_budget_exceeded", "Bundle file exceeds its size budget.");
    }
    if (captureBytes && before.size > maxCaptureBytes) {
      fail(
        "enterprise_offline_bundle_file_budget_exceeded",
        "Bundle metadata exceeds its in-memory byte budget.",
      );
    }
    if (destinationPath !== undefined) {
      destinationHandle = await fs.open(
        destinationPath,
        fsConstants.O_WRONLY
          | fsConstants.O_CREAT
          | fsConstants.O_EXCL
          | (fsConstants.O_NOFOLLOW || 0),
        0o600,
      );
    }
    const digest: any = crypto.createHash("sha256");
    const chunks: any[] = [];
    let bytesRead: any = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      bytesRead += chunk.length;
      if (bytesRead > before.size || bytesRead > MAX_SINGLE_FILE_BYTES) {
        fail(
          "enterprise_offline_bundle_file_changed_during_read",
          "Bundle file exceeded its validated size while being read.",
        );
      }
      digest.update(chunk);
      if (captureBytes) {
        chunks.push(chunk);
      }
      if (destinationHandle) {
        let offset: any = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await destinationHandle.write(
            chunk,
            offset,
            chunk.length - offset,
          );
          if (bytesWritten <= 0) {
            fail(
              "enterprise_offline_bundle_output_write_failed",
              "Bundle output write did not make progress.",
            );
          }
          offset += bytesWritten;
        }
      }
    }
    const after: any = await handle.stat();
    if (
      before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || bytesRead !== after.size
    ) {
      fail(
        "enterprise_offline_bundle_file_changed_during_read",
        "Bundle file changed while it was being read.",
      );
    }
    if (destinationHandle) {
      await destinationHandle.chmod(0o600);
      await destinationHandle.sync();
      const destinationStat: any = await destinationHandle.stat();
      if (
        !destinationStat.isFile()
        || destinationStat.nlink !== 1
        || destinationStat.size !== bytesRead
        || (destinationStat.mode & 0o777) !== 0o600
      ) {
        fail(
          "enterprise_offline_bundle_output_write_failed",
          "Bundle output file is invalid.",
        );
      }
    }
    const digestValue: any = `sha256:${digest.digest("hex")}`;
    return Object.freeze({
      bytes: captureBytes ? Buffer.concat(chunks, bytesRead) : undefined,
      digest: digestValue,
      size: bytesRead,
      stat: after,
      path: normalized,
    });
  } catch (error: any) {
    if (error?.code?.startsWith?.("enterprise_offline_bundle_")) {
      throw error;
    }
    fail(
      destinationPath
        ? "enterprise_offline_bundle_output_write_failed"
        : "enterprise_offline_bundle_file_unavailable",
      destinationPath
        ? "Bundle output could not be written."
        : "Bundle file is unavailable.",
    );
  } finally {
    await destinationHandle?.close();
    await handle?.close();
  }
}

async function collectRegularFiles(root?: any, { expectedMode }: Record<string, any> = {}) : Promise<any> {
  const rootStat: any = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("enterprise_offline_bundle_oci_layout_invalid", "OCI layout root must be a real directory.");
  }
  const stack: any[] = [{ directory: root, depth: 0 }];
  const files: any[] = [];
  let totalBytes: any = 0;
  let totalEntries: any = 0;
  while (stack.length > 0) {
    const { directory: current, depth } = stack.pop();
    if (depth > MAX_BUNDLE_DEPTH) {
      fail("enterprise_offline_bundle_depth_budget_exceeded", "Bundle directory depth exceeds its budget.");
    }
    const entries: any[] = [];
    const directoryHandle: any = await fs.opendir(current);
    for await (const entry of directoryHandle) {
      totalEntries += 1;
      if (totalEntries > MAX_BUNDLE_ENTRIES) {
        fail(
          "enterprise_offline_bundle_entry_count_exceeded",
          "Bundle exceeds its directory-entry budget.",
        );
      }
      entries.push(entry);
    }
    entries.sort((left?: any, right?: any) : any => compareText(left.name, right.name));
    for (const entry of entries) {
      const absolutePath: any = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const directoryStat: any = await fs.lstat(absolutePath);
        if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
          fail("enterprise_offline_bundle_special_file", "Bundle directory entry is unsafe.");
        }
        stack.push({ directory: absolutePath, depth: depth + 1 });
        continue;
      }
      const rel: any = path.relative(root, absolutePath).split(path.sep).join("/");
      const normalized: any = safeRelativePath(rel);
      if (!normalized) {
        fail(
          "enterprise_offline_bundle_inventory_traversal_path",
          "Encountered illegal file path.",
        );
      }
      const inspected: any = await readRegularFileNoFollow(root, normalized, {
        captureBytes: false,
        expectedMode,
      });
      totalBytes += inspected.size;
      if (totalBytes > MAX_TOTAL_BYTES) {
        fail("enterprise_offline_bundle_total_budget_exceeded", "Bundle exceeds its total byte budget.");
      }
      if (files.length >= MAX_BUNDLE_FILES) {
        fail("enterprise_offline_bundle_file_count_exceeded", "Bundle exceeds its file-count budget.");
      }
      files.push({
        path: normalized,
        digest: inspected.digest,
        size: inspected.size,
        mode: 0o600,
      });
    }
  }
  files.sort((a?: any, b?: any) : any => compareText(a.path, b.path));
  return files;
}

function toBlobRelativePath(digest?: any) : any {
  const normalized: any = parseDigest(digest);
  return `blobs/sha256/${normalized.replace("sha256:", "")}`;
}

function assertDescriptorShape(
  descriptor?: any,
  {
    allowedMediaTypes,
    code = "enterprise_offline_bundle_oci_descriptor_invalid",
  }: Record<string, any> = {},
) : any {
  if (
    !isObject(descriptor)
    || typeof descriptor.mediaType !== "string"
    || descriptor.mediaType.length === 0
    || descriptor.mediaType.length > 255
    || /[\u0000-\u0020\u007f]/u.test(descriptor.mediaType)
  ) {
    fail(code, "OCI descriptor media type is invalid.");
  }
  if (allowedMediaTypes && !allowedMediaTypes.has(descriptor.mediaType)) {
    fail(code, "OCI descriptor media type is not allowed.");
  }
  parseDigest(descriptor.digest);
  if (
    !Number.isSafeInteger(descriptor.size)
    || descriptor.size < 0
    || descriptor.size > MAX_SINGLE_FILE_BYTES
  ) {
    fail(code, "OCI descriptor size is invalid.");
  }
  return descriptor;
}

async function readVerifiedDescriptorBlob(
  ociLayoutPath?: any,
  descriptor?: any,
  options: Record<string, any> = {},
) : Promise<any> {
  assertDescriptorShape(descriptor, options);
  const relativePath: any = toBlobRelativePath(descriptor.digest);
  const inspected: any = await readRegularFileNoFollow(
    ociLayoutPath,
    relativePath,
    {
      captureBytes: options.captureBytes !== false,
      maxCaptureBytes: options.maxCaptureBytes || MAX_JSON_BYTES,
    },
  );
  if (inspected.size !== descriptor.size) {
    fail(
      options.sizeCode || "enterprise_offline_bundle_oci_descriptor_size",
      "OCI descriptor size does not match its blob.",
    );
  }
  if (inspected.digest !== descriptor.digest) {
    fail(
      options.digestCode || "enterprise_offline_bundle_oci_descriptor_digest",
      "OCI descriptor digest does not match its blob.",
    );
  }
  return Object.freeze({
    bytes: inspected.bytes,
    relativePath,
  });
}

async function assertManifestForPlatform(ociLayoutPath?: any, platform?: any, descriptor?: any) : Promise<any> {
  const [expectedOs, expectedArchitecture] = String(platform).split("/");
  if (
    expectedOs !== "linux"
    || !ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.includes(platform)
    || descriptor.platform?.os !== expectedOs
    || descriptor.platform?.architecture !== expectedArchitecture
  ) {
    fail(
      "enterprise_offline_bundle_oci_platform_invalid",
      "Runtime manifest platform is invalid.",
    );
  }

  const manifestBlob: any = await readVerifiedDescriptorBlob(ociLayoutPath, descriptor, {
    allowedMediaTypes: new Set<any>([OCI_IMAGE_MANIFEST_MEDIA_TYPE]),
    code: "enterprise_offline_bundle_oci_manifest_media_type",
    sizeCode: "enterprise_offline_bundle_oci_manifest_size",
    digestCode: "enterprise_offline_bundle_oci_manifest_digest",
  });
  const manifest: any = parseJsonText(
    manifestBlob.bytes.toString("utf8"),
    "enterprise_offline_bundle_oci_manifest_invalid",
  );
  if (
    manifest.schemaVersion !== 2
    || manifest.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE
    || !isObject(manifest.config)
    || !Array.isArray(manifest.layers)
    || manifest.layers.length === 0
  ) {
    fail("enterprise_offline_bundle_oci_manifest_invalid", "Runtime manifest is malformed.");
  }
  if (manifest.config.mediaType !== OCI_CONFIG_MEDIA_TYPE) {
    fail(
      "enterprise_offline_bundle_oci_config_media_type",
      "Runtime config media type is malformed.",
    );
  }

  const configBlob: any = await readVerifiedDescriptorBlob(ociLayoutPath, manifest.config, {
    allowedMediaTypes: new Set<any>([OCI_CONFIG_MEDIA_TYPE]),
    code: "enterprise_offline_bundle_oci_config_media_type",
    sizeCode: "enterprise_offline_bundle_oci_config_size",
    digestCode: "enterprise_offline_bundle_oci_config_digest",
  });
  const config: any = parseJsonText(
    configBlob.bytes.toString("utf8"),
    "enterprise_offline_bundle_oci_config_invalid",
  );
  if (
    config.os !== expectedOs
    || config.architecture !== expectedArchitecture
    || !isObject(config.rootfs)
    || config.rootfs.type !== "layers"
    || !Array.isArray(config.rootfs.diff_ids)
    || config.rootfs.diff_ids.length !== manifest.layers.length
    || config.rootfs.diff_ids.some(
      (digest?: any) : any => !DIGEST_WITH_ALGO_PATTERN.test(String(digest || "")),
    )
  ) {
    fail(
      "enterprise_offline_bundle_oci_config_platform_mismatch",
      "Runtime config platform does not match its index descriptor.",
    );
  }

  const reachablePaths: any = new Set<any>([
    manifestBlob.relativePath,
    configBlob.relativePath,
  ]);
  for (const layer of manifest.layers) {
    const layerBlob: any = await readVerifiedDescriptorBlob(ociLayoutPath, layer, {
      allowedMediaTypes: OCI_LAYER_MEDIA_TYPES,
      code: "enterprise_offline_bundle_oci_layer_media_type",
      sizeCode: "enterprise_offline_bundle_oci_layer_size",
      digestCode: "enterprise_offline_bundle_oci_layer_digest",
      captureBytes: false,
    });
    reachablePaths.add(layerBlob.relativePath);
  }
  return Object.freeze({ manifest, reachablePaths });
}

async function assertAttestationManifest(
  ociLayoutPath?: any,
  descriptor?: any,
  runtimeDescriptor?: any,
) : Promise<any> {
  const attestationBlob: any = await readVerifiedDescriptorBlob(ociLayoutPath, descriptor, {
    allowedMediaTypes: new Set<any>([OCI_IMAGE_MANIFEST_MEDIA_TYPE]),
    code: "enterprise_offline_bundle_attestation_media_type",
    sizeCode: "enterprise_offline_bundle_attestation_size",
    digestCode: "enterprise_offline_bundle_attestation_digest",
  });
  const manifest: any = parseJsonText(
    attestationBlob.bytes.toString("utf8"),
    "enterprise_offline_bundle_attestation_invalid",
  );
  if (
    manifest.schemaVersion !== 2
    || manifest.mediaType !== OCI_IMAGE_MANIFEST_MEDIA_TYPE
    || !isObject(manifest.config)
    || !Array.isArray(manifest.layers)
    || manifest.layers.length === 0
  ) {
    fail(
      "enterprise_offline_bundle_attestation_invalid",
      "Attestation manifest is malformed.",
    );
  }
  if (
    !isObject(manifest.subject)
    || manifest.subject.digest !== runtimeDescriptor.digest
    || manifest.subject.size !== runtimeDescriptor.size
    || manifest.subject.mediaType !== runtimeDescriptor.mediaType
  ) {
    fail(
      "enterprise_offline_bundle_attestation_binding",
      "Attestation subject is mismatched.",
    );
  }

  const configBlob: any = await readVerifiedDescriptorBlob(ociLayoutPath, manifest.config, {
    code: "enterprise_offline_bundle_attestation_config_invalid",
    sizeCode: "enterprise_offline_bundle_attestation_config_size",
    digestCode: "enterprise_offline_bundle_attestation_config_digest",
    captureBytes: false,
  });
  const reachablePaths: any = new Set<any>([
    attestationBlob.relativePath,
    configBlob.relativePath,
  ]);
  for (const layer of manifest.layers) {
    const layerBlob: any = await readVerifiedDescriptorBlob(ociLayoutPath, layer, {
      code: "enterprise_offline_bundle_attestation_layer_invalid",
      sizeCode: "enterprise_offline_bundle_attestation_layer_size",
      digestCode: "enterprise_offline_bundle_attestation_layer_digest",
      captureBytes: false,
    });
    reachablePaths.add(layerBlob.relativePath);
  }
  return Object.freeze({ manifest, reachablePaths });
}

function normalizeReleaseImageEvidence(releaseImageEvidence?: any) : any {
  if (
    !isObject(releaseImageEvidence)
    || !exactKeys(releaseImageEvidence, RELEASE_EVIDENCE_KEYS)
    || typeof releaseImageEvidence.target !== "string"
    || typeof releaseImageEvidence.candidate !== "string"
    || typeof releaseImageEvidence.reused !== "boolean"
  ) {
    fail(
      "enterprise_offline_bundle_release_evidence_invalid",
      "Release image evidence is invalid.",
    );
  }
  const normalized: Record<string, any> = {
    target: releaseImageEvidence.target,
    candidate: releaseImageEvidence.candidate,
    reused: releaseImageEvidence.reused,
  };
  let totalBytes: any = 0;
  for (const key of [
    "manifestDescriptorText",
    "manifestText",
    "provenanceText",
    "sbomText",
  ]) {
    if (typeof releaseImageEvidence[key] !== "string") {
      fail(
        "enterprise_offline_bundle_release_evidence_invalid",
        "Release image evidence text is invalid.",
      );
    }
    const value: any = releaseImageEvidence[key].trim();
    const byteLength: any = Buffer.byteLength(value, "utf8");
    totalBytes += byteLength;
    if (
      value.length === 0
      || byteLength > MAX_RELEASE_EVIDENCE_BYTES
      || totalBytes > MAX_RELEASE_EVIDENCE_BYTES
    ) {
      fail(
        "enterprise_offline_bundle_release_evidence_invalid",
        "Release image evidence exceeds its byte budget.",
      );
    }
    parseJsonText(
      value,
      "enterprise_offline_bundle_release_evidence_invalid",
    );
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

function validateReleaseAuthority({
  sourceCandidate,
  releaseImageAuthority,
  releaseImageEvidence,
}: Record<string, any>) : any {
  const candidate: any = validateReleaseCandidateIdentity(sourceCandidate);
  if (!isObject(releaseImageAuthority)) {
    fail("enterprise_offline_bundle_release_authority_invalid", "Release authority is invalid.");
  }
  if (!exactKeys(releaseImageAuthority, RELEASE_AUTHORITY_KEYS)) {
    fail(
      "enterprise_offline_bundle_release_authority_invalid",
      "Release authority keys are invalid.",
    );
  }
  if (releaseImageAuthority.schemaVersion !== RELEASE_IMAGE_AUTHORITY_SCHEMA) {
    fail(
      "enterprise_offline_bundle_release_authority_schema",
      "Release authority schema is invalid.",
    );
  }
  if (releaseImageAuthority.candidateDigest !== candidate.candidate_digest) {
    fail(
      "enterprise_offline_bundle_candidate_mismatch",
      "Release authority does not bind to source candidate.",
    );
  }
  if (releaseImageAuthority.sourceCommit !== candidate.source_revision) {
    fail(
      "enterprise_offline_bundle_source_commit_mismatch",
      "Release authority source commit does not match its candidate.",
    );
  }
  requireString(
    releaseImageAuthority.image,
    IMAGE_NAME_PATTERN,
    "enterprise_offline_bundle_release_authority_image",
    "Release authority image name is invalid.",
  );
  for (const key of [
    "repository",
    "sourceRef",
    "workflowRef",
    "provenancePredicateType",
    "provenanceBuildType",
    "sbomFormat",
  ]) {
    requireString(
      releaseImageAuthority[key],
      /^[^\u0000-\u001f\u007f]{1,512}$/u,
      "enterprise_offline_bundle_release_authority_invalid",
      "Release authority text field is invalid.",
    );
  }
  const platforms: any = releaseImageAuthority.platforms;
  if (JSON.stringify(platforms) !== JSON.stringify(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS)) {
    fail(
      "enterprise_offline_bundle_platform_mismatch",
      "Release authority platform set is invalid.",
    );
  }
  const imageDigest: any = requireString(
    releaseImageAuthority.digest,
    DIGEST_WITH_ALGO_PATTERN,
    "enterprise_offline_bundle_release_authority_digest",
    "Release authority image digest is invalid.",
  );
  if (
    !Array.isArray(releaseImageAuthority.platformEvidence)
    || releaseImageAuthority.platformEvidence.length !== ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length
    || releaseImageAuthority.provenanceVerified !== true
    || releaseImageAuthority.sbomVerified !== true
  ) {
    fail(
      "enterprise_offline_bundle_release_authority_evidence",
      "Release authority evidence is incomplete.",
    );
  }
  for (const key of [
    "manifestDescriptorSha256",
    "manifestSha256",
    "provenanceSha256",
    "sbomSha256",
  ]) {
    requireString(
      releaseImageAuthority[key],
      DIGEST_PATTERN,
      "enterprise_offline_bundle_release_authority_evidence",
      "Release authority evidence digest is invalid.",
    );
  }
  const evidence: any = normalizeReleaseImageEvidence(releaseImageEvidence);
  let rebuiltAuthority: any;
  try {
    rebuiltAuthority = buildReleaseImageAuthority({
      image: releaseImageAuthority.image,
      digest: releaseImageAuthority.digest,
      target: evidence.target,
      candidate: evidence.candidate,
      reused: evidence.reused,
      repository: releaseImageAuthority.repository,
      sourceRef: releaseImageAuthority.sourceRef,
      sourceCommit: releaseImageAuthority.sourceCommit,
      sourceCandidate: candidate,
      workflowRef: releaseImageAuthority.workflowRef,
      manifestDescriptorText: evidence.manifestDescriptorText,
      manifestText: evidence.manifestText,
      provenanceText: evidence.provenanceText,
      sbomText: evidence.sbomText,
    });
  } catch {
    fail(
      "enterprise_offline_bundle_release_evidence_invalid",
      "Release image evidence cannot rebuild its authority.",
    );
  }
  if (canonicalJson(rebuiltAuthority) !== canonicalJson(releaseImageAuthority)) {
    fail(
      "enterprise_offline_bundle_release_authority_evidence",
      "Release image evidence does not reproduce its authority.",
    );
  }
  return { candidate, imageDigest, evidence };
}

function computeInventoryDigest(inventory?: any) : any {
  const payload: Record<string, any> = {
    schema_version: inventory.schema_version,
    candidate_digest: inventory.candidate_digest,
    image_digest: inventory.image_digest,
    platforms: inventory.platforms,
    compose: inventory.compose,
    files: inventory.files,
  };
  return sha256(canonicalJson(payload));
}

function buildDescriptorClosureFromIndex(index?: any) : any {
  if (
    !isObject(index)
    || !Array.isArray(index.manifests)
    || index.manifests.length !== ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length * 2
  ) {
    fail(
      "enterprise_offline_bundle_oci_manifest_set_mismatch",
      "OCI index must contain the exact runtime and attestation descriptor set.",
    );
  }
  const runtimeMap: any = new Map<any, any>();
  const attestBySubject: any = new Map<any, any>();
  for (const entry of index.manifests) {
    if (!isObject(entry)) {
      fail(
        "enterprise_offline_bundle_oci_manifest_invalid",
        "OCI index descriptor is malformed.",
      );
    }
    const platform: any = `${entry.platform?.os || ""}/${entry.platform?.architecture || ""}`;
    if (
      !entry.platform?.os ||
      !entry.platform?.architecture ||
      !entry.mediaType
      || !entry.digest
      || !Number.isSafeInteger(entry.size)
      || entry.size <= 0
    ) {
      fail(
        "enterprise_offline_bundle_oci_manifest_invalid",
        "OCI index descriptor is malformed.",
      );
    }
    parseDigest(entry.digest);

    if (platform === "unknown/unknown") {
      const annotations: any = isObject(entry.annotations) ? entry.annotations : {};
      if (annotations["vnd.docker.reference.type"] !== "attestation-manifest") {
        fail(
          "enterprise_offline_bundle_oci_attestation_invalid",
          "Attestation descriptor annotations are missing.",
        );
      }
      const subjectDigest: any = String(annotations["vnd.docker.reference.digest"] || "");
      if (!DIGEST_WITH_ALGO_PATTERN.test(subjectDigest)) {
        fail(
          "enterprise_offline_bundle_oci_attestation_subject",
          "Attestation subject digest invalid.",
        );
      }
      if (attestBySubject.has(subjectDigest)) {
        fail(
          "enterprise_offline_bundle_oci_attestation_invalid",
          "Attestation subject is duplicated.",
        );
      }
      attestBySubject.set(subjectDigest, entry);
      continue;
    }
    if (!ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.includes(platform)) {
      fail(
        "enterprise_offline_bundle_oci_platform_set_mismatch",
        "OCI index contains an unsupported runtime platform.",
      );
    }
    if (runtimeMap.has(platform)) {
      fail(
        "enterprise_offline_bundle_oci_platform_set_mismatch",
        "OCI index contains a duplicate runtime platform.",
      );
    }
    runtimeMap.set(platform, entry);
  }
  if (
    runtimeMap.size !== ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length
    || attestBySubject.size !== ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length
  ) {
    fail(
      "enterprise_offline_bundle_oci_manifest_set_mismatch",
      "OCI index descriptor coverage is incomplete.",
    );
  }
  return { runtimeMap, attestBySubject };
}

async function inspectAuthoritativeOciLayout({
  ociLayoutPath,
  imageDigest,
  releaseImageAuthority,
  precollectedFiles,
}: Record<string, any>) : Promise<any> {
  let rootStat: any;
  try {
    rootStat = await fs.lstat(ociLayoutPath);
  } catch {
    fail("enterprise_offline_bundle_oci_layout_invalid", "OCI layout root is unavailable.");
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail("enterprise_offline_bundle_oci_layout_invalid", "OCI layout root must be a real directory.");
  }

  const layoutFile: any = await readRegularFileNoFollow(ociLayoutPath, "oci-layout");
  const layout: any = parseJsonText(
    layoutFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_oci_layout_invalid",
  );
  if (
    !exactKeys(layout, ["imageLayoutVersion"])
    || layout.imageLayoutVersion !== "1.0.0"
  ) {
    fail(
      "enterprise_offline_bundle_oci_layout_invalid",
      "OCI layout marker is invalid.",
    );
  }

  const indexFile: any = await readRegularFileNoFollow(ociLayoutPath, "index.json");
  if (prefixedSha256(indexFile.bytes) !== imageDigest) {
    fail(
      "enterprise_offline_bundle_image_digest_mismatch",
      "OCI index digest is not authoritative.",
    );
  }
  const indexText: any = indexFile.bytes.toString("utf8");
  if (sha256(indexText.trim()) !== releaseImageAuthority.manifestSha256) {
    fail(
      "enterprise_offline_bundle_release_authority_evidence",
      "OCI index does not match the release authority evidence.",
    );
  }
  const index: any = parseJsonText(
    indexText,
    "enterprise_offline_bundle_oci_index_invalid",
  );
  if (index.mediaType !== OCI_IMAGE_INDEX_MEDIA_TYPE || index.schemaVersion !== 2) {
    fail(
      "enterprise_offline_bundle_oci_index_invalid",
      "OCI index mediaType or schemaVersion is invalid.",
    );
  }

  const { runtimeMap, attestBySubject } = buildDescriptorClosureFromIndex(index);
  const evidenceByPlatform: any = new Map<any, any>();
  for (const evidence of releaseImageAuthority.platformEvidence) {
    if (
      !isObject(evidence)
      || !ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.includes(evidence.platform)
      || evidenceByPlatform.has(evidence.platform)
    ) {
      fail(
        "enterprise_offline_bundle_release_authority_evidence",
        "Release authority platform evidence is invalid.",
      );
    }
    evidenceByPlatform.set(evidence.platform, evidence);
  }

  const reachablePaths: any = new Set<any>(["oci-layout", "index.json"]);
  const descriptorClosure: any[] = [];
  for (const platform of ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS) {
    const descriptor: any = runtimeMap.get(platform);
    if (!descriptor) {
      fail(
        "enterprise_offline_bundle_oci_platform_missing",
        "Runtime platform manifest is missing.",
      );
    }
    const runtime: any = await assertManifestForPlatform(
      ociLayoutPath,
      platform,
      descriptor,
    );
    for (const relativePath of runtime.reachablePaths) {
      reachablePaths.add(relativePath);
    }

    const attestation: any = attestBySubject.get(descriptor.digest);
    if (!attestation) {
      fail(
        "enterprise_offline_bundle_attestation_missing",
        "Runtime attestation manifest is missing.",
      );
    }
    const inspectedAttestation: any = await assertAttestationManifest(
      ociLayoutPath,
      attestation,
      descriptor,
    );
    for (const relativePath of inspectedAttestation.reachablePaths) {
      reachablePaths.add(relativePath);
    }

    const evidence: any = evidenceByPlatform.get(platform);
    if (
      !evidence
      || evidence.subjectDigest !== descriptor.digest
      || evidence.attestationDigest !== attestation.digest
      || !exactKeys(evidence, ["platform", "subjectDigest", "attestationDigest"])
    ) {
      fail(
        "enterprise_offline_bundle_release_authority_evidence",
        "Release authority platform evidence does not match the OCI closure.",
      );
    }

    descriptorClosure.push({
      platform,
      mediaType: descriptor.mediaType,
      digest: descriptor.digest,
      size: descriptor.size,
    });
  }

  if (evidenceByPlatform.size !== ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS.length) {
    fail(
      "enterprise_offline_bundle_release_authority_evidence",
      "Release authority platform evidence coverage is incomplete.",
    );
  }

  const files: any = precollectedFiles || await collectRegularFiles(ociLayoutPath);
  const actualPaths: any = files.map((entry?: any) : any => entry.path);
  const expectedPaths: any = [...reachablePaths].sort(compareText);
  if (
    actualPaths.length !== expectedPaths.length
    || actualPaths.some((entry?: any, indexValue?: any) : any => entry !== expectedPaths[indexValue])
  ) {
    fail(
      "enterprise_offline_bundle_unexpected_file",
      "OCI layout must contain exactly the reachable descriptor closure.",
    );
  }

  return Object.freeze({
    descriptorClosure: Object.freeze(descriptorClosure),
    files: Object.freeze(files),
    index,
  });
}

export async function buildEnterpriseOfflineBundleInventory({
  sourceCandidate,
  releaseImageAuthority,
  releaseImageEvidence,
  ociLayoutPath,
}: Record<string, any> = {}) : Promise<any> {
  const { candidate, imageDigest } = validateReleaseAuthority({
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
  });
  if (typeof ociLayoutPath !== "string" || ociLayoutPath.trim() === "") {
    fail("enterprise_offline_bundle_oci_layout_invalid", "OCI layout path is required.");
  }

  const inspectedLayout: any = await inspectAuthoritativeOciLayout({
    ociLayoutPath,
    imageDigest,
    releaseImageAuthority,
  });
  const normalizedFiles: any = validateInventoryPaths(inspectedLayout.files);
  const inventory: Readonly<Record<string, any>> = Object.freeze({
    schema_version: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
    candidate_digest: candidate.candidate_digest,
    image_digest: imageDigest,
    platforms: [...ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS],
    compose: {
      image: `${releaseImageAuthority.image}@${imageDigest}`,
      pull_policy: "never",
      args: [...OFFLINE_COMPOSE_ARGS],
      descriptor_closure: inspectedLayout.descriptorClosure,
      optional_service: false,
    },
    files: normalizedFiles,
  });
  const inventory_digest: any = computeInventoryDigest(inventory);
  const finalInventory: Readonly<Record<string, any>> = Object.freeze({
    ...inventory,
    inventory_digest,
  });
  if (!DIGEST_PATTERN.test(finalInventory.inventory_digest)) {
    fail("enterprise_offline_bundle_inventory_digest_invalid", "Inventory digest is malformed.");
  }
  return finalInventory;
}

export async function validateEnterpriseOfflineBundleInventory({
  inventory,
  ociLayoutPath,
  sourceCandidate,
  releaseImageAuthority,
  releaseImageEvidence,
}: Record<string, any> = {}) : Promise<any> {
  if (!isObject(inventory)) {
    fail("enterprise_offline_bundle_inventory_invalid", "Inventory is invalid.");
  }
  const files: any = validateInventoryPaths(inventory.files || []);
  for (const entry of files) {
    if (entry.symlink === true) {
      fail("enterprise_offline_bundle_symlink_denied", "Inventory declares a symlink.");
    }
    if (typeof entry.mode === "number" && (entry.mode & 0o111) !== 0) {
      fail("enterprise_offline_bundle_executable_file", "Inventory declares an executable file.");
    }
  }
  const actualFiles: any = await collectRegularFiles(ociLayoutPath);
  if (actualFiles.length !== files.length) {
    fail("enterprise_offline_bundle_unexpected_file", "Inventory file count mismatch.");
  }
  if (!exactKeys(inventory, INVENTORY_KEYS)) {
    fail("enterprise_offline_bundle_inventory_invalid", "Inventory keys are invalid.");
  }
  if (inventory.schema_version !== ENTERPRISE_OFFLINE_BUNDLE_SCHEMA) {
    fail("enterprise_offline_bundle_schema_invalid", "Inventory schema is invalid.");
  }
  if (
    JSON.stringify(inventory.platforms)
    !== JSON.stringify(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS)
  ) {
    fail(
      "enterprise_offline_bundle_platform_mismatch",
      "Inventory platform set is invalid.",
    );
  }
  for (const entry of files) {
    if (!exactKeys(entry, ["path", "digest", "size", "mode"])) {
      fail(
        "enterprise_offline_bundle_file_entry_invalid",
        "Inventory file entry keys are invalid.",
      );
    }
    requireString(
      entry.digest,
      DIGEST_WITH_ALGO_PATTERN,
      "enterprise_offline_bundle_file_digest_invalid",
      "Inventory file digest is invalid.",
    );
    if (
      !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || entry.size > MAX_SINGLE_FILE_BYTES
    ) {
      fail(
        "enterprise_offline_bundle_file_size_mismatch",
        "Inventory file size is invalid.",
      );
    }
  }
  const { candidate, imageDigest } = validateReleaseAuthority({
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
  });
  if (candidate.candidate_digest !== inventory.candidate_digest) {
    fail(
      "enterprise_offline_bundle_candidate_mismatch",
      "Inventory candidate digest is not authoritative.",
    );
  }
  if (imageDigest !== inventory.image_digest) {
    fail("enterprise_offline_bundle_image_digest_mismatch", "Inventory image digest mismatch.");
  }

  const expectedComposeImage: any = `${releaseImageAuthority.image}@${imageDigest}`;
  if (
    !isObject(inventory.compose) ||
    !exactKeys(inventory.compose, [
      "image",
      "pull_policy",
      "args",
      "descriptor_closure",
      "optional_service",
    ]) ||
    inventory.compose.image !== expectedComposeImage ||
    inventory.compose.pull_policy !== "never" ||
    canonicalJson(inventory.compose.args)
      !== canonicalJson(OFFLINE_COMPOSE_ARGS) ||
    !Array.isArray(inventory.compose.descriptor_closure) ||
    inventory.compose.optional_service !== false
  ) {
    fail("enterprise_offline_bundle_compose_invalid", "Inventory compose shape is invalid.");
  }

  const inspectedLayout: any = await inspectAuthoritativeOciLayout({
    ociLayoutPath,
    imageDigest,
    releaseImageAuthority,
    precollectedFiles: actualFiles,
  });
  if (
    canonicalJson(inspectedLayout.descriptorClosure)
    !== canonicalJson(inventory.compose.descriptor_closure)
  ) {
    fail("enterprise_offline_bundle_descriptor_closure_mismatch", "Descriptor closure is not authoritative.");
  }

  const actualMap: any = new Map<any, any>();
  const canonicalSet: any = new Set<any>();
  for (const entry of actualFiles) {
    const lower: any = entry.path.toLowerCase();
    if (canonicalSet.has(lower)) {
      fail("enterprise_offline_bundle_case_collision", "OCI filesystem contains case collision.");
    }
    canonicalSet.add(lower);
    actualMap.set(entry.path, entry);
  }

  for (const entry of files) {
    const actual: any = actualMap.get(entry.path);
    if (!actual) {
      fail("enterprise_offline_bundle_unexpected_file", "Inventory references missing file.");
    }
    if (entry.size !== actual.size) {
      fail("enterprise_offline_bundle_file_size_mismatch", "File size mismatch.");
    }
    if (actual.digest !== entry.digest) {
      fail("enterprise_offline_bundle_file_digest_invalid", "File digest mismatch.");
    }
    if (typeof entry.mode !== "number" || (entry.mode & 0o111)) {
      fail("enterprise_offline_bundle_executable_file", "Inventory file is invalid.");
    }
  }

  const expectedInventory: Record<string, any> = {
    schema_version: inventory.schema_version,
    candidate_digest: inventory.candidate_digest,
    image_digest: inventory.image_digest,
    platforms: inventory.platforms,
    compose: inventory.compose,
    files,
  };
  if (computeInventoryDigest(expectedInventory) !== inventory.inventory_digest) {
    fail("enterprise_offline_bundle_inventory_digest_invalid", "Inventory digest mismatch.");
  }

  return Object.freeze({ ok: true, inventory_digest: inventory.inventory_digest });
}

async function copyOciFilesToOutput({ sourceRoot, outputRoot, files }: Record<string, any>) : Promise<any> {
  for (const entry of files) {
    const dst: any = path.join(outputRoot, entry.path);
    await fs.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
    const source: any = await readRegularFileNoFollow(
      sourceRoot,
      entry.path,
      {
        captureBytes: false,
        destinationPath: dst,
      },
    );
    if (
      source.size !== entry.size
      || source.digest !== entry.digest
    ) {
      fail(
        "enterprise_offline_bundle_source_changed",
        "OCI source changed after inventory validation.",
      );
    }
  }
}

function stripSignatureKeys(signature?: any) : any {
  return {
    keyId: signature.keyId,
    algorithm: signature.algorithm,
    payloadEncoding: signature.payloadEncoding,
    purpose: signature.purpose,
    payloadDigest: signature.payloadDigest,
    contextDigest: signature.contextDigest,
    signedEnvelope: signature.signedEnvelope,
    signature: signature.signature,
  };
}

function snapshotJson(value?: any, code?: any) : any {
  try {
    return JSON.parse(canonicalJson(value));
  } catch {
    fail(code, "Authority payload cannot be serialized canonically.");
  }
}

function buildAuthorities(
  sourceCandidate?: any,
  releaseImageAuthority?: any,
  releaseImageEvidence?: any,
) : any {
  const sourceCandidateSnapshot: any = snapshotJson(
    sourceCandidate,
    "enterprise_offline_bundle_candidate_invalid",
  );
  const releaseAuthoritySnapshot: any = snapshotJson(
    releaseImageAuthority,
    "enterprise_offline_bundle_release_authority_invalid",
  );
  const releaseEvidenceSnapshot: any = snapshotJson(
    normalizeReleaseImageEvidence(releaseImageEvidence),
    "enterprise_offline_bundle_release_evidence_invalid",
  );
  const authorities: Record<string, any> = {
    source_candidate: sourceCandidateSnapshot,
    release_image_authority: releaseAuthoritySnapshot,
    release_image_evidence: releaseEvidenceSnapshot,
    source_candidate_sha256: sha256(canonicalJson(sourceCandidateSnapshot)),
    release_image_authority_sha256: sha256(canonicalJson(releaseAuthoritySnapshot)),
  };
  return Object.freeze(authorities);
}

function buildPayloadDigest(inventory?: any, compose?: any, authorities?: any) : any {
  return `sha256:${sha256(canonicalJson({
    schema_version: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
    candidate_digest: inventory.candidate_digest,
    image_digest: inventory.image_digest,
    platforms: [...inventory.platforms],
    compose,
    files: inventory.files,
    inventory_digest: inventory.inventory_digest,
    authorities,
  }))}`;
}

function validateSignerResponse({
  signature,
  payloadDigest,
  contextDigest,
  purpose,
  expectedKeyId,
}: Record<string, any>) : any {
  if (!isObject(signature)) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer returned an invalid response.",
    );
  }
  requireString(
    signature.keyId,
    KEY_ID_PATTERN,
    "enterprise_offline_bundle_signature_invalid",
    "Signer key id is invalid.",
  );
  if (
    signature.algorithm !== SIGNATURE_ALGORITHM
    || signature.payloadEncoding !== SIGNATURE_PAYLOAD_ENCODING
    || signature.keyId !== expectedKeyId
    || signature.purpose !== purpose
    || signature.payloadDigest !== payloadDigest
    || signature.contextDigest !== contextDigest
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer response does not match its request.",
    );
  }
  if (
    typeof signature.signature !== "string"
    || !BASE64URL_PATTERN.test(signature.signature)
    || Buffer.from(signature.signature, "base64url").length !== 64
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer response signature is invalid.",
    );
  }
  const receipt: any = signature.receipt;
  if (
    !isObject(receipt)
    || !exactKeys(receipt, SIGNER_RECEIPT_KEYS)
    || typeof receipt.receiptId !== "string"
    || receipt.receiptId.length === 0
    || receipt.receiptId.length > 512
    || /[\u0000-\u001f\u007f]/u.test(receipt.receiptId)
    || receipt.keyId !== signature.keyId
    || receipt.purpose !== purpose
    || receipt.payloadDigest !== payloadDigest
    || typeof receipt.signedAt !== "string"
    || !Number.isFinite(Date.parse(receipt.signedAt))
    || !Number.isSafeInteger(receipt.secretRevision)
    || receipt.secretRevision < 1
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer receipt is invalid.",
    );
  }
  const safeReceipt: any = Object.freeze(
    Object.fromEntries(
      SAFE_RECEIPT_FIELDS.map((key?: any) : any => [key, receipt[key]]),
    ),
  );
  const expectedSignedEnvelope: Record<string, any> = {
    purpose,
    payloadDigest,
    contextDigest,
    receiptDigest: `sha256:${sha256(canonicalJson(safeReceipt))}`,
  };
  if (
    !isObject(signature.signedEnvelope)
    || !exactKeys(signature.signedEnvelope, [
      "purpose",
      "payloadDigest",
      "contextDigest",
      "receiptDigest",
    ])
    || canonicalJson(signature.signedEnvelope)
      !== canonicalJson(expectedSignedEnvelope)
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer response envelope is invalid.",
    );
  }
  return Object.freeze({ signedEnvelope: expectedSignedEnvelope, safeReceipt });
}

function verifySignerResponseWithExternalTrust(
  signature?: any,
  signedEnvelope?: any,
  trustedPublicKeys?: any,
) : any {
  const keyJwk: any = (
    isObject(trustedPublicKeys)
    && Object.prototype.hasOwnProperty.call(
      trustedPublicKeys,
      signature.keyId,
    )
  )
    ? trustedPublicKeys[signature.keyId]
    : undefined;
  if (!isTrustedEd25519PublicJwk(keyJwk, signature.keyId)) {
    fail(
      "enterprise_offline_bundle_signer_trust_missing",
      "Signer response requires an external public trust anchor.",
    );
  }
  let publicKey: any;
  try {
    publicKey = crypto.createPublicKey({ key: keyJwk, format: "jwk" });
  } catch {
    fail(
      "enterprise_offline_bundle_signer_trust_missing",
      "Signer response trust anchor is invalid.",
    );
  }
  const signatureBytes: any = Buffer.from(signature.signature, "base64url");
  let valid: any = false;
  try {
    valid = crypto.verify(
      null,
      Buffer.from(canonicalJson(signedEnvelope), "utf8"),
      publicKey,
      signatureBytes,
    );
  } catch {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer response verification failed.",
    );
  }
  if (!valid) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signer response signature is invalid.",
    );
  }
}

async function prepareAtomicOutput(outputRoot?: any) : Promise<any> {
  const target: any = path.resolve(outputRoot);
  const parent: any = path.dirname(target);
  const parentStat: any = await fs.lstat(parent);
  if (
    parentStat.isSymbolicLink()
    || !parentStat.isDirectory()
  ) {
    fail(
      "enterprise_offline_bundle_output_root_invalid",
      "Output parent must be a real directory.",
    );
  }

  let targetExists: any = false;
  try {
    const targetStat: any = await fs.lstat(target);
    targetExists = true;
    if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
      fail(
        "enterprise_offline_bundle_output_root_invalid",
        "Output root must be a real directory.",
      );
    }
    if ((await fs.readdir(target)).length !== 0) {
      fail(
        "enterprise_offline_bundle_output_not_empty",
        "Output root must be empty.",
      );
    }
  } catch (error: any) {
    if (error?.code?.startsWith?.("enterprise_offline_bundle_")) {
      throw error;
    }
    if (error?.code !== "ENOENT") {
      fail(
        "enterprise_offline_bundle_output_root_invalid",
        "Output root is unavailable.",
      );
    }
  }

  const stage: any = await fs.mkdtemp(
    path.join(parent, ".meshrix-offline-bundle-stage-"),
  );
  await fs.chmod(stage, 0o700);
  return Object.freeze({ target, targetExists, stage });
}

async function commitAtomicOutput({ target, targetExists, stage }: Record<string, any>) : Promise<any> {
  try {
    if (targetExists) {
      const targetStat: any = await fs.lstat(target);
      if (
        targetStat.isSymbolicLink()
        || !targetStat.isDirectory()
        || (await fs.readdir(target)).length !== 0
      ) {
        fail(
          "enterprise_offline_bundle_output_root_changed",
          "Output root changed during assembly.",
        );
      }
      await fs.rmdir(target);
    }
    await fs.rename(stage, target);
  } catch (error: any) {
    if (error?.code?.startsWith?.("enterprise_offline_bundle_")) {
      throw error;
    }
    fail(
      "enterprise_offline_bundle_output_commit_failed",
      "Offline bundle output could not be committed atomically.",
    );
  }
}

async function writeBytesExclusive(filePath?: any, value?: any) : Promise<any> {
  let handle: any;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_WRONLY
        | fsConstants.O_CREAT
        | fsConstants.O_EXCL
        | (fsConstants.O_NOFOLLOW || 0),
      0o600,
    );
    await handle.writeFile(value);
    await handle.chmod(0o600);
    await handle.sync();
    const stat: any = await handle.stat();
    if (
      !stat.isFile()
      || stat.nlink !== 1
      || (stat.mode & 0o777) !== 0o600
    ) {
      fail(
        "enterprise_offline_bundle_output_write_failed",
        "Bundle metadata output is invalid.",
      );
    }
  } catch (error: any) {
    if (error?.code?.startsWith?.("enterprise_offline_bundle_")) {
      throw error;
    }
    fail(
      "enterprise_offline_bundle_output_write_failed",
      "Bundle metadata output could not be written.",
    );
  } finally {
    await handle?.close();
  }
}

async function writeJsonExclusive(filePath?: any, value?: any) : Promise<any> {
  await writeBytesExclusive(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

async function writeTextExclusive(filePath?: any, value?: any) : Promise<any> {
  await writeBytesExclusive(filePath, value);
}

export async function assembleEnterpriseOfflineBundle({
  sourceCandidate,
  releaseImageAuthority,
  releaseImageEvidence,
  ociLayoutPath,
  artifactSigner,
  trustedPublicKeys,
  optionalServiceEnabled = false,
  outputRoot,
}: Record<string, any> = {}) : Promise<any> {
  if (typeof artifactSigner?.sign !== "function") {
    fail("enterprise_offline_bundle_signer_missing", "artifactSigner.sign is required.");
  }
  requireString(
    artifactSigner.keyId,
    KEY_ID_PATTERN,
    "enterprise_offline_bundle_signer_missing",
    "artifactSigner.keyId is required.",
  );
  if (typeof outputRoot !== "string" || outputRoot.trim() === "") {
    fail("enterprise_offline_bundle_output_root_missing", "outputRoot is required.");
  }
  if (optionalServiceEnabled !== false) {
    fail(
      "enterprise_offline_bundle_optional_service_denied",
      "Optional services are disabled in the enterprise single-node bundle.",
    );
  }

  const inventory: any = await buildEnterpriseOfflineBundleInventory({
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
    ociLayoutPath,
  });
  await validateEnterpriseOfflineBundleInventory({
    inventory,
    ociLayoutPath,
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
  });

  const compose: any = snapshotJson(
    inventory.compose,
    "enterprise_offline_bundle_compose_invalid",
  );

  const authorities: any = buildAuthorities(
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
  );
  const payloadDigest: any = buildPayloadDigest(inventory, compose, authorities);
  const context: Record<string, any> = {
    schema: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
    inventory_digest: inventory.inventory_digest,
    compose,
    authority_digests: {
      source_candidate_sha256: authorities.source_candidate_sha256,
      release_image_authority_sha256: authorities.release_image_authority_sha256,
    },
    signing: {
      keyId: artifactSigner.keyId,
      algorithm: SIGNATURE_ALGORITHM,
      payloadEncoding: SIGNATURE_PAYLOAD_ENCODING,
    },
  };
  const contextDigest: any = `sha256:${sha256(canonicalJson(context))}`;

  const signature: any = await artifactSigner.sign({
    purpose: SIGNING_PURPOSE,
    payloadDigest,
    context,
  });
  const validatedSignerResponse: any = validateSignerResponse({
    signature,
    payloadDigest,
    contextDigest,
    purpose: SIGNING_PURPOSE,
    expectedKeyId: artifactSigner.keyId,
  });
  verifySignerResponseWithExternalTrust(
    signature,
    validatedSignerResponse.signedEnvelope,
    trustedPublicKeys,
  );
  const safeSignature: any = stripSignatureKeys(signature);

  safeSignature.receipt = validatedSignerResponse.safeReceipt;

  const bundle: Readonly<Record<string, any>> = Object.freeze({
    schema_version: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
    candidate_digest: inventory.candidate_digest,
    image_digest: inventory.image_digest,
    platforms: [...inventory.platforms],
    compose,
    files: inventory.files,
    inventory_digest: inventory.inventory_digest,
    authorities,
    signature: Object.freeze(safeSignature),
  });
  const unsignedBundle: any = Object.freeze(
    Object.fromEntries(
      UNSIGNED_BUNDLE_KEYS.map((key?: any) : any => [key, bundle[key]]),
    ),
  );

  const sourceRealPath: any = await fs.realpath(ociLayoutPath);
  const outputPath: any = path.resolve(outputRoot);
  if (
    sourceRealPath === outputPath
    || isPathWithin(sourceRealPath, outputPath)
    || isPathWithin(outputPath, sourceRealPath)
  ) {
    fail(
      "enterprise_offline_bundle_output_source_overlap",
      "Output root must not overlap the OCI source.",
    );
  }
  const atomicOutput: any = await prepareAtomicOutput(outputRoot);
  try {
    await Promise.all([
      fs.mkdir(path.join(atomicOutput.stage, "files"), {
        recursive: true,
        mode: 0o700,
      }),
      fs.mkdir(path.join(atomicOutput.stage, "inventory"), {
        recursive: true,
        mode: 0o700,
      }),
      fs.mkdir(path.join(atomicOutput.stage, "bundle"), {
        recursive: true,
        mode: 0o700,
      }),
      fs.mkdir(path.join(atomicOutput.stage, "compose"), {
        recursive: true,
        mode: 0o700,
      }),
      fs.mkdir(path.join(atomicOutput.stage, "signature"), {
        recursive: true,
        mode: 0o700,
      }),
      fs.mkdir(path.join(atomicOutput.stage, "authorities"), {
        recursive: true,
        mode: 0o700,
      }),
      fs.mkdir(path.join(atomicOutput.stage, "evidence"), {
        recursive: true,
        mode: 0o700,
      }),
    ]);
    await copyOciFilesToOutput({
      sourceRoot: ociLayoutPath,
      outputRoot: path.join(atomicOutput.stage, "files"),
      files: inventory.files,
    });
    await Promise.all([
      writeJsonExclusive(
        path.join(atomicOutput.stage, "inventory", INVENTORY_FILE_NAME),
        inventory,
      ),
      writeJsonExclusive(
        path.join(atomicOutput.stage, "bundle", BUNDLE_FILE_NAME),
        unsignedBundle,
      ),
      writeJsonExclusive(
        path.join(atomicOutput.stage, "compose", COMPOSE_FILE_NAME),
        compose,
      ),
      writeTextExclusive(
        path.join(atomicOutput.stage, "compose", "compose.yaml"),
        buildOfflineComposeYaml(compose.image),
      ),
      writeJsonExclusive(
        path.join(atomicOutput.stage, "signature", SIGNATURE_FILE_NAME),
        safeSignature,
      ),
      writeJsonExclusive(
        path.join(atomicOutput.stage, "authorities", "source-candidate.json"),
        authorities.source_candidate,
      ),
      writeJsonExclusive(
        path.join(
          atomicOutput.stage,
          "authorities",
          "release-image-authority.json",
        ),
        authorities.release_image_authority,
      ),
      writeJsonExclusive(
        path.join(atomicOutput.stage, "evidence", "coordinates.json"),
        {
          target: authorities.release_image_evidence.target,
          candidate: authorities.release_image_evidence.candidate,
          reused: authorities.release_image_evidence.reused,
        },
      ),
      writeTextExclusive(
        path.join(atomicOutput.stage, "evidence", "manifest-descriptor.json"),
        authorities.release_image_evidence.manifestDescriptorText,
      ),
      writeTextExclusive(
        path.join(atomicOutput.stage, "evidence", "manifest.json"),
        authorities.release_image_evidence.manifestText,
      ),
      writeTextExclusive(
        path.join(atomicOutput.stage, "evidence", "provenance.json"),
        authorities.release_image_evidence.provenanceText,
      ),
      writeTextExclusive(
        path.join(atomicOutput.stage, "evidence", "sbom.json"),
        authorities.release_image_evidence.sbomText,
      ),
    ]);
    await loadEnterpriseOfflineBundle(atomicOutput.stage);
    await commitAtomicOutput(atomicOutput);
  } catch (error: any) {
    await fs.rm(atomicOutput.stage, { recursive: true, force: true });
    throw error;
  }

  return bundle;
}

function validateBundleAuthorities(bundle?: any) : any {
  const authorities: any = bundle.authorities;
  if (
    !isObject(authorities)
    || !exactKeys(authorities, [
      "source_candidate",
      "release_image_authority",
      "release_image_evidence",
      "source_candidate_sha256",
      "release_image_authority_sha256",
    ])
    || !DIGEST_PATTERN.test(String(authorities.source_candidate_sha256 || ""))
    || !DIGEST_PATTERN.test(
      String(authorities.release_image_authority_sha256 || ""),
    )
  ) {
    fail(
      "enterprise_offline_bundle_authorities_invalid",
      "Bundle authorities are invalid.",
    );
  }
  if (
    sha256(canonicalJson(authorities.source_candidate))
      !== authorities.source_candidate_sha256
    || sha256(canonicalJson(authorities.release_image_authority))
      !== authorities.release_image_authority_sha256
  ) {
    fail(
      "enterprise_offline_bundle_authorities_invalid",
      "Bundle authority digest is invalid.",
    );
  }
  const { candidate, imageDigest } = validateReleaseAuthority({
    sourceCandidate: authorities.source_candidate,
    releaseImageAuthority: authorities.release_image_authority,
    releaseImageEvidence: authorities.release_image_evidence,
  });
  if (
    candidate.candidate_digest !== bundle.candidate_digest
    || imageDigest !== bundle.image_digest
    || bundle.compose.image
      !== `${authorities.release_image_authority.image}@${imageDigest}`
  ) {
    fail(
      "enterprise_offline_bundle_authorities_invalid",
      "Bundle authorities do not match its identity.",
    );
  }
  return authorities;
}

function isTrustedEd25519PublicJwk(keyJwk?: any, keyId?: any) : any {
  if (!isObject(keyJwk) || Object.prototype.hasOwnProperty.call(keyJwk, "d")) {
    return false;
  }
  const allowedKeys: any = new Set<any>([
    "kty",
    "crv",
    "x",
    "kid",
    "alg",
    "use",
    "key_ops",
  ]);
  if (Object.keys(keyJwk).some((key?: any) : any => !allowedKeys.has(key))) {
    return false;
  }
  if (
    keyJwk.kty !== "OKP"
    || keyJwk.crv !== "Ed25519"
    || typeof keyJwk.x !== "string"
    || !BASE64URL_PATTERN.test(keyJwk.x)
  ) {
    return false;
  }
  const publicBytes: any = Buffer.from(keyJwk.x, "base64url");
  if (
    publicBytes.length !== 32
    || publicBytes.toString("base64url") !== keyJwk.x
    || (keyJwk.kid !== undefined && keyJwk.kid !== keyId)
    || (keyJwk.alg !== undefined && keyJwk.alg !== "EdDSA")
    || (keyJwk.use !== undefined && keyJwk.use !== "sig")
  ) {
    return false;
  }
  if (
    keyJwk.key_ops !== undefined
    && (
      !Array.isArray(keyJwk.key_ops)
      || keyJwk.key_ops.length !== 1
      || keyJwk.key_ops[0] !== "verify"
    )
  ) {
    return false;
  }
  return true;
}

function validateReceipt(signature?: any) : any {
  const receipt: any = signature.receipt;
  if (
    !isObject(receipt)
    || !exactKeys(receipt, SAFE_RECEIPT_FIELDS)
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signature receipt is invalid.",
    );
  }
  if (
    receipt.keyId !== signature.keyId
    || receipt.purpose !== signature.purpose
    || receipt.payloadDigest !== signature.payloadDigest
    || (
      typeof receipt.receiptId !== "string"
      || receipt.receiptId.length === 0
      || receipt.receiptId.length > 512
      || /[\u0000-\u001f\u007f]/u.test(receipt.receiptId)
    )
    || (
      typeof receipt.signedAt !== "string"
      || !Number.isFinite(Date.parse(receipt.signedAt))
    )
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signature receipt does not match its envelope.",
    );
  }
}

export async function loadEnterpriseOfflineBundle(bundleRoot?: any) : Promise<any> {
  const rootStat: any = await fs.lstat(bundleRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(
      "enterprise_offline_bundle_output_root_invalid",
      "Bundle root must be a real directory.",
    );
  }

  const [
    unsignedFile,
    signatureFile,
    inventoryFile,
    composeFile,
    composeYamlFile,
    candidateFile,
    authorityFile,
    evidenceCoordinatesFile,
    manifestDescriptorFile,
    manifestFile,
    provenanceFile,
    sbomFile,
  ] =
    await Promise.all([
      readRegularFileNoFollow(
        bundleRoot,
        `bundle/${BUNDLE_FILE_NAME}`,
        { maxCaptureBytes: MAX_BUNDLE_METADATA_BYTES },
      ),
      readRegularFileNoFollow(bundleRoot, `signature/${SIGNATURE_FILE_NAME}`),
      readRegularFileNoFollow(
        bundleRoot,
        `inventory/${INVENTORY_FILE_NAME}`,
        { maxCaptureBytes: MAX_BUNDLE_METADATA_BYTES },
      ),
      readRegularFileNoFollow(bundleRoot, `compose/${COMPOSE_FILE_NAME}`),
      readRegularFileNoFollow(bundleRoot, "compose/compose.yaml"),
      readRegularFileNoFollow(bundleRoot, "authorities/source-candidate.json"),
      readRegularFileNoFollow(
        bundleRoot,
        "authorities/release-image-authority.json",
      ),
      readRegularFileNoFollow(bundleRoot, "evidence/coordinates.json"),
      readRegularFileNoFollow(bundleRoot, "evidence/manifest-descriptor.json"),
      readRegularFileNoFollow(bundleRoot, "evidence/manifest.json"),
      readRegularFileNoFollow(
        bundleRoot,
        "evidence/provenance.json",
        { maxCaptureBytes: MAX_RELEASE_EVIDENCE_BYTES },
      ),
      readRegularFileNoFollow(
        bundleRoot,
        "evidence/sbom.json",
        { maxCaptureBytes: MAX_RELEASE_EVIDENCE_BYTES },
      ),
    ]);
  const unsignedBundle: any = parseJsonText(
    unsignedFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  const signature: any = parseJsonText(
    signatureFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  const inventory: any = parseJsonText(
    inventoryFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  const compose: any = parseJsonText(
    composeFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  const sourceCandidate: any = parseJsonText(
    candidateFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  const releaseImageAuthority: any = parseJsonText(
    authorityFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  const evidenceCoordinates: any = parseJsonText(
    evidenceCoordinatesFile.bytes.toString("utf8"),
    "enterprise_offline_bundle_output_metadata_invalid",
  );
  if (!isObject(unsignedBundle) || !exactKeys(unsignedBundle, UNSIGNED_BUNDLE_KEYS)) {
    fail(
      "enterprise_offline_bundle_output_metadata_invalid",
      "Stored bundle manifest is invalid.",
    );
  }
  const bundle: Record<string, any> = {
    ...unsignedBundle,
    signature,
  };
  validateBundleAuthorities(bundle);
  const storedEvidence: Record<string, any> = {
    ...evidenceCoordinates,
    manifestDescriptorText: manifestDescriptorFile.bytes.toString("utf8"),
    manifestText: manifestFile.bytes.toString("utf8"),
    provenanceText: provenanceFile.bytes.toString("utf8"),
    sbomText: sbomFile.bytes.toString("utf8"),
  };
  if (
    canonicalJson(compose) !== canonicalJson(bundle.compose)
    || composeYamlFile.bytes.toString("utf8")
      !== buildOfflineComposeYaml(bundle.compose?.image)
    || canonicalJson(sourceCandidate)
      !== canonicalJson(bundle.authorities?.source_candidate)
    || canonicalJson(releaseImageAuthority)
      !== canonicalJson(bundle.authorities?.release_image_authority)
    || canonicalJson(storedEvidence)
      !== canonicalJson(bundle.authorities?.release_image_evidence)
  ) {
    fail(
      "enterprise_offline_bundle_output_metadata_mismatch",
      "Stored bundle metadata is inconsistent.",
    );
  }

  const expectedInventory: Record<string, any> = {
    schema_version: bundle.schema_version,
    candidate_digest: bundle.candidate_digest,
    image_digest: bundle.image_digest,
    platforms: bundle.platforms,
    compose: bundle.compose,
    files: bundle.files,
    inventory_digest: bundle.inventory_digest,
  };
  if (canonicalJson(inventory) !== canonicalJson(expectedInventory)) {
    fail(
      "enterprise_offline_bundle_output_metadata_mismatch",
      "Stored inventory is inconsistent.",
    );
  }

  const expectedPaths: any = [
    `bundle/${BUNDLE_FILE_NAME}`,
    `signature/${SIGNATURE_FILE_NAME}`,
    `inventory/${INVENTORY_FILE_NAME}`,
    `compose/${COMPOSE_FILE_NAME}`,
    "compose/compose.yaml",
    "authorities/source-candidate.json",
    "authorities/release-image-authority.json",
    "evidence/coordinates.json",
    "evidence/manifest-descriptor.json",
    "evidence/manifest.json",
    "evidence/provenance.json",
    "evidence/sbom.json",
    ...validateInventoryPaths(bundle.files || []).map(
      (entry?: any) : any => `files/${entry.path}`,
    ),
  ].sort(compareText);
  const actualPaths: any = (await collectRegularFiles(
    bundleRoot,
    { expectedMode: 0o600 },
  ))
    .map((entry?: any) : any => entry.path);
  if (
    expectedPaths.length !== actualPaths.length
    || expectedPaths.some((entry?: any, indexValue?: any) : any => entry !== actualPaths[indexValue])
  ) {
    fail(
      "enterprise_offline_bundle_unexpected_file",
      "Stored bundle contains an unexpected file set.",
    );
  }

  const authorities: any = validateBundleAuthorities(bundle);
  await validateEnterpriseOfflineBundleInventory({
    inventory,
    ociLayoutPath: path.join(bundleRoot, "files"),
    sourceCandidate: authorities.source_candidate,
    releaseImageAuthority: authorities.release_image_authority,
    releaseImageEvidence: authorities.release_image_evidence,
  });
  return Object.freeze(bundle);
}

export async function verifyEnterpriseOfflineBundle({
  bundle,
  bundleRoot,
  trustedPublicKeys = Object.freeze({}),
  replayGuard,
  receiptAllowlist = SAFE_RECEIPT_FIELDS,
}: Record<string, any> = {}) : Promise<any> {
  if (bundleRoot !== undefined) {
    if (typeof bundleRoot !== "string" || bundleRoot.trim() === "") {
      fail(
        "enterprise_offline_bundle_output_root_invalid",
        "Bundle root is invalid.",
      );
    }
    const stored: any = await loadEnterpriseOfflineBundle(bundleRoot);
    if (bundle && canonicalJson(bundle) !== canonicalJson(stored)) {
      fail(
        "enterprise_offline_bundle_output_metadata_mismatch",
        "Stored bundle metadata does not match the supplied bundle.",
      );
    }
    bundle = stored;
  }
  if (!isObject(bundle) || !isObject(bundle.signature)) {
    fail("enterprise_offline_bundle_signature_missing", "Bundle signature missing.");
  }
  if (!exactKeys(bundle, BUNDLE_KEYS)) {
    fail(
      "enterprise_offline_bundle_invalid",
      "Bundle keys are invalid.",
    );
  }
  if (
    bundle.schema_version !== ENTERPRISE_OFFLINE_BUNDLE_SCHEMA
    || !DIGEST_PATTERN.test(String(bundle.candidate_digest || ""))
    || !DIGEST_WITH_ALGO_PATTERN.test(String(bundle.image_digest || ""))
    || !DIGEST_PATTERN.test(String(bundle.inventory_digest || ""))
    || JSON.stringify(bundle.platforms)
      !== JSON.stringify(ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS)
  ) {
    fail("enterprise_offline_bundle_invalid", "Bundle identity is invalid.");
  }
  if (
    !isObject(bundle.compose)
    || !exactKeys(bundle.compose, [
      "image",
      "pull_policy",
      "args",
      "descriptor_closure",
      "optional_service",
    ])
    || bundle.compose.pull_policy !== "never"
    || canonicalJson(bundle.compose.args)
      !== canonicalJson(OFFLINE_COMPOSE_ARGS)
    || bundle.compose.optional_service !== false
    || !Array.isArray(bundle.compose.descriptor_closure)
    || !Array.isArray(bundle.files)
  ) {
    fail(
      "enterprise_offline_bundle_compose_invalid",
      "Bundle compose contract is invalid.",
    );
  }

  const authorities: any = validateBundleAuthorities(bundle);
  const files: any = validateInventoryPaths(bundle.files);
  for (const entry of files) {
    if (
      !exactKeys(entry, ["path", "digest", "size", "mode"])
      || !DIGEST_WITH_ALGO_PATTERN.test(String(entry.digest || ""))
      || !Number.isSafeInteger(entry.size)
      || entry.size < 0
      || entry.size > MAX_SINGLE_FILE_BYTES
      || entry.mode !== 0o600
    ) {
      fail(
        "enterprise_offline_bundle_file_entry_invalid",
        "Bundle file inventory is invalid.",
      );
    }
  }
  if (
    computeInventoryDigest({
      schema_version: bundle.schema_version,
      candidate_digest: bundle.candidate_digest,
      image_digest: bundle.image_digest,
      platforms: bundle.platforms,
      compose: bundle.compose,
      files,
    }) !== bundle.inventory_digest
  ) {
    fail(
      "enterprise_offline_bundle_inventory_digest_invalid",
      "Bundle inventory digest is invalid.",
    );
  }

  const { signature } = bundle;
  if (!exactKeys(signature, SIGNATURE_KEYS)) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Bundle signature keys are invalid.",
    );
  }
  if (signature.purpose !== SIGNING_PURPOSE) {
    fail("enterprise_offline_bundle_signature_purpose_invalid", "Bundle signature purpose is invalid.");
  }
  requireString(
    signature.keyId,
    KEY_ID_PATTERN,
    "enterprise_offline_bundle_signature_missing_key",
    "Signature keyId missing.",
  );
  if (
    signature.algorithm !== SIGNATURE_ALGORITHM
    || signature.payloadEncoding !== SIGNATURE_PAYLOAD_ENCODING
    || !DIGEST_WITH_ALGO_PATTERN.test(String(signature.payloadDigest || ""))
    || !DIGEST_WITH_ALGO_PATTERN.test(String(signature.contextDigest || ""))
    || typeof signature.signature !== "string"
    || !BASE64URL_PATTERN.test(signature.signature)
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Bundle signature metadata is invalid.",
    );
  }

  const keyJwk: any = (
    isObject(trustedPublicKeys)
    && Object.prototype.hasOwnProperty.call(
      trustedPublicKeys,
      signature.keyId,
    )
  )
    ? trustedPublicKeys[signature.keyId]
    : undefined;
  if (!isTrustedEd25519PublicJwk(keyJwk, signature.keyId)) {
    fail("enterprise_offline_bundle_unknown_key", "Unknown signature key.");
  }
  let publicKey: any;
  try {
    publicKey = crypto.createPublicKey({ key: keyJwk, format: "jwk" });
  } catch {
    fail("enterprise_offline_bundle_unknown_key", "Unknown signature key.");
  }

  const context: Record<string, any> = {
    schema: ENTERPRISE_OFFLINE_BUNDLE_SCHEMA,
    inventory_digest: bundle.inventory_digest,
    compose: bundle.compose,
    authority_digests: {
      source_candidate_sha256: authorities.source_candidate_sha256,
      release_image_authority_sha256:
        authorities.release_image_authority_sha256,
    },
    signing: {
      keyId: signature.keyId,
      algorithm: signature.algorithm,
      payloadEncoding: signature.payloadEncoding,
    },
  };
  const expectedContextDigest: any = `sha256:${sha256(canonicalJson(context))}`;
  if (signature.contextDigest !== expectedContextDigest) {
    fail("enterprise_offline_bundle_signature_invalid", "Signature context digest is invalid.");
  }

  validateReceipt(signature);
  const expectedSignedEnvelope: Record<string, any> = {
    purpose: SIGNING_PURPOSE,
    payloadDigest: signature.payloadDigest,
    contextDigest: signature.contextDigest,
    receiptDigest: `sha256:${sha256(canonicalJson(signature.receipt))}`,
  };
  if (canonicalJson(signature.signedEnvelope) !== canonicalJson(expectedSignedEnvelope)) {
    fail("enterprise_offline_bundle_signature_invalid", "Signed envelope mismatch.");
  }

  const expectedPayloadDigest: any = `sha256:${sha256(canonicalJson({
    schema_version: bundle.schema_version,
    candidate_digest: bundle.candidate_digest,
    image_digest: bundle.image_digest,
    platforms: [...(bundle.platforms || [])],
    compose: {
      image: bundle.compose.image,
      pull_policy: bundle.compose.pull_policy,
      args: bundle.compose.args,
      descriptor_closure: bundle.compose.descriptor_closure,
      optional_service: bundle.compose.optional_service,
    },
    files: bundle.files,
    inventory_digest: bundle.inventory_digest,
    authorities: bundle.authorities,
  }))}`;
  if (expectedPayloadDigest !== signature.payloadDigest) {
    fail("enterprise_offline_bundle_signature_invalid", "Payload digest mismatch.");
  }

  const packedEnvelope: any = Buffer.from(canonicalJson(expectedSignedEnvelope), "utf8");
  const signatureBytes: any = Buffer.from(signature.signature, "base64url");
  if (
    signatureBytes.length !== 64
    || signatureBytes.toString("base64url") !== signature.signature
  ) {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signature encoding is invalid.",
    );
  }
  let valid: any = false;
  try {
    valid = crypto.verify(null, packedEnvelope, publicKey, signatureBytes);
  } catch {
    fail(
      "enterprise_offline_bundle_signature_invalid",
      "Signature verification failed.",
    );
  }
  if (!valid) {
    fail("enterprise_offline_bundle_signature_invalid", "Invalid signature.");
  }

  if (replayGuard !== undefined && typeof replayGuard?.consume !== "function") {
    fail(
      "enterprise_offline_bundle_replay_guard_invalid",
      "Replay guard is invalid.",
    );
  }
  if (replayGuard?.consume) {
    const signatureId: any = sha256(canonicalJson({
      keyId: signature.keyId,
      purpose: signature.purpose,
      payloadDigest: signature.payloadDigest,
      signature: signature.signature,
    }));
    let consumed: any;
    try {
      consumed = await replayGuard.consume({ signatureId });
    } catch {
      fail(
        "enterprise_offline_bundle_replay_guard_failed",
        "Replay guard failed closed.",
      );
    }
    if (consumed !== true) {
      fail("enterprise_offline_bundle_signature_replay", "Signature replay detected.");
    }
  }

  const requestedReceiptFields: any = new Set<any>(
    Array.isArray(receiptAllowlist) ? receiptAllowlist : [],
  );
  const receipt: any = Object.fromEntries(
    SAFE_RECEIPT_FIELDS
      .filter((key?: any) : any => requestedReceiptFields.has(key))
      .map((key?: any) : any => [key, signature.receipt?.[key]])
      .filter((entry?: any) : any => entry[1] !== undefined),
  );
  return Object.freeze({
    ok: true,
    keyId: signature.keyId,
    payloadDigest: signature.payloadDigest,
    purpose: signature.purpose,
    algorithm: signature.algorithm,
    filesystemVerified: bundleRoot !== undefined,
    receipt: Object.freeze(receipt),
  });
}

async function writeBlob(root?: any, bytes?: any) : Promise<any> {
  const value: any = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), "utf8");
  const hex: any = sha256(value);
  const digest: any = `sha256:${hex}`;
  const absolute: any = path.join(root, "blobs", "sha256", hex);
  await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
  await fs.writeFile(absolute, value, { mode: 0o600 });
  return { digest, size: value.length };
}

async function createMinimalFixtureOci(root?: any) : Promise<any> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  const descriptors: any[] = [];

  for (const platform of ENTERPRISE_OFFLINE_BUNDLE_PLATFORMS) {
    const arch: any = platform.split("/")[1];
    const config: any = canonicalJson({
      os: "linux",
      architecture: arch,
      created: "2026-01-01T00:00:00Z",
      rootfs: { type: "layers", diff_ids: [`sha256:${"0".repeat(64)}`] },
    });
    const configBlob: any = await writeBlob(root, config);
    const layerBlob: any = await writeBlob(root, `${platform}-layer`);

    const manifest: any = canonicalJson({
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configBlob.digest,
        size: configBlob.size,
      },
      layers: [
        {
          mediaType: OCI_LAYER_MEDIA_TYPE,
          digest: layerBlob.digest,
          size: layerBlob.size,
        },
      ],
      platform: { os: "linux", architecture: arch },
    });
    const manifestBlob: any = await writeBlob(root, manifest);
    descriptors.push({
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      digest: manifestBlob.digest,
      size: manifestBlob.size,
      platform: { os: "linux", architecture: arch },
    });

    const attestation: any = canonicalJson({
      schemaVersion: 2,
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      config: {
        mediaType: OCI_CONFIG_MEDIA_TYPE,
        digest: configBlob.digest,
        size: configBlob.size,
      },
      layers: [{ mediaType: OCI_LAYER_MEDIA_TYPE, digest: layerBlob.digest, size: layerBlob.size }],
      subject: {
        mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
        digest: manifestBlob.digest,
        size: manifestBlob.size,
      },
      platform: { os: "unknown", architecture: "unknown" },
    });
    const attBlob: any = await writeBlob(root, attestation);
    descriptors.push({
      mediaType: OCI_IMAGE_MANIFEST_MEDIA_TYPE,
      digest: attBlob.digest,
      size: attBlob.size,
      platform: { os: "unknown", architecture: "unknown" },
      annotations: {
        "vnd.docker.reference.type": "attestation-manifest",
        "vnd.docker.reference.digest": manifestBlob.digest,
      },
    });
  }

  const index: any = canonicalJson({
    schemaVersion: 2,
    mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    manifests: descriptors.map((descriptor?: any) : any => {
      const entry: Record<string, any> = {
        mediaType: descriptor.mediaType,
        digest: descriptor.digest,
        size: descriptor.size,
      };
      if (descriptor.platform?.os === "unknown" && descriptor.platform?.architecture === "unknown") {
        return {
          ...entry,
          platform: {
            os: "unknown",
            architecture: "unknown",
          },
          annotations: descriptor.annotations,
        };
      }
      return {
        ...entry,
        platform: descriptor.platform,
      };
    }),
  });
  await fs.writeFile(path.join(root, "index.json"), index);
}

async function buildFixture(root?: any) : Promise<any> {
  const sourceCommit: any = "0123456789abcdef0123456789abcdef0123456789".slice(0, 40);
  await createMinimalFixtureOci(root);

  const sourceCandidate: any = buildReleaseCandidateIdentity({
    sourceRevision: sourceCommit,
    repositoryTreeDigest: `sha256:${"1".repeat(64)}`,
    releaseDefinitionSha256: `sha256:${"2".repeat(64)}`,
    packageLockSha256: `sha256:${"3".repeat(64)}`,
    reportInventoryDigest: `sha256:${"4".repeat(64)}`,
    releasePackages: [
      {
        manifest_path: "packages/contracts/package.json",
        name: "@meshrix/contracts",
        version: "1.2.3",
        manifest_sha256: "5".repeat(64),
      },
    ],
    supportedProfiles: ["enterprise-single-node"],
  });

  const indexText: any = await fs.readFile(path.join(root, "index.json"), "utf8");
  const image: any = "ghcr.io/acme/meshrix";
  const authorityInput: Record<string, any> = {
    image,
    digest: `sha256:${sha256(indexText)}`,
    target: `${image}:1.2.3`,
    candidate: `${image}:candidate-${sourceCommit}`,
    reused: false,
    repository: "Acme/Meshrix.js",
    sourceRef: "refs/tags/v1.2.3",
    sourceCommit,
    sourceCandidate,
    workflowRef: "Acme/Meshrix.js/.github/workflows/release.yml@refs/tags/v1.2.3",
    manifestDescriptorText: JSON.stringify({
      digest: `sha256:${sha256(indexText)}`,
      mediaType: OCI_IMAGE_INDEX_MEDIA_TYPE,
    }),
    manifestText: indexText,
    provenanceText: JSON.stringify({
      "linux/amd64": {
        SLSA: {
          buildType: "https://mobyproject.org/buildkit@v1",
          builder: { id: "https://github.com/Acme/Meshrix.js/actions" },
          invocation: {
            parameters: {
              frontend: "dockerfile.v0",
              args: {
                target: "runtime-ui",
                "build-arg:MESHRIX_SOURCE_REPOSITORY": "Acme/Meshrix.js",
                "build-arg:MESHRIX_SOURCE_REF": "refs/tags/v1.2.3",
                "build-arg:MESHRIX_SOURCE_COMMIT": sourceCommit,
              },
            },
            environment: { platform: "linux/amd64" },
          },
          metadata: {
            buildInvocationID: "build-amd64",
            buildStartedOn: "2026-01-01T00:00:00.000Z",
            buildFinishedOn: "2026-01-01T00:00:01.000Z",
            reproducible: true,
            completeness: { parameters: true, environment: true, materials: true },
            ["https://mobyproject.org/buildkit@v1#metadata"]: {
              vcs: { revision: sourceCommit, source: "https://github.com/Acme/Meshrix.js.git" },
              parameters: { output: "linux/amd64" },
            },
          },
          materials: [
            {
              uri: "git+https://github.com/Acme/Meshrix.js.git",
              digest: { sha256: sha256(sourceCommit) },
            },
          ],
        },
      },
      "linux/arm64": {
        SLSA: {
          buildType: "https://mobyproject.org/buildkit@v1",
          builder: { id: "https://github.com/Acme/Meshrix.js/actions" },
          invocation: {
            parameters: {
              frontend: "dockerfile.v0",
              args: {
                target: "runtime-ui",
                "build-arg:MESHRIX_SOURCE_REPOSITORY": "Acme/Meshrix.js",
                "build-arg:MESHRIX_SOURCE_REF": "refs/tags/v1.2.3",
                "build-arg:MESHRIX_SOURCE_COMMIT": sourceCommit,
              },
            },
            environment: { platform: "linux/arm64" },
          },
          metadata: {
            buildInvocationID: "build-arm64",
            buildStartedOn: "2026-01-01T00:00:00.000Z",
            buildFinishedOn: "2026-01-01T00:00:01.000Z",
            reproducible: true,
            completeness: { parameters: true, environment: true, materials: true },
            ["https://mobyproject.org/buildkit@v1#metadata"]: {
              vcs: { revision: sourceCommit, source: "https://github.com/Acme/Meshrix.js.git" },
              parameters: { output: "linux/arm64" },
            },
          },
          materials: [
            {
              uri: "git+https://github.com/Acme/Meshrix.js.git",
              digest: { sha256: sha256(sourceCommit) },
            },
          ],
        },
      },
    }),
    sbomText: JSON.stringify({
      "linux/amd64": {
        SPDX: {
          spdxVersion: "SPDX-2.3",
          SPDXID: "SPDXRef-DOCUMENT",
          dataLicense: "CC0-1.0",
          documentNamespace: "https://github.com/acme/meshrix/spdx#manifest",
          name: "meshrix-linux-amd64",
          creationInfo: { creators: ["Tool: fixture"] },
          packages: [{ SPDXID: "SPDXRef-Package-acme-meshrix", name: "@meshrix/meshrix" }],
          relationships: [{ spdxElementId: "SPDXRef-Package-acme-meshrix", relatedSpdxElement: "SPDXRef-DOCUMENT", relationshipType: "CONTAINS" }],
        },
      },
      "linux/arm64": {
        SPDX: {
          spdxVersion: "SPDX-2.3",
          SPDXID: "SPDXRef-DOCUMENT",
          dataLicense: "CC0-1.0",
          documentNamespace: "https://github.com/acme/meshrix/spdx#manifest",
          name: "meshrix-linux-arm64",
          creationInfo: { creators: ["Tool: fixture"] },
          packages: [{ SPDXID: "SPDXRef-Package-acme-meshrix", name: "@meshrix/meshrix" }],
          relationships: [{ spdxElementId: "SPDXRef-Package-acme-meshrix", relatedSpdxElement: "SPDXRef-DOCUMENT", relationshipType: "CONTAINS" }],
        },
      },
    }),
  };
  const authority: any = buildReleaseImageAuthority(authorityInput);
  const releaseImageEvidence: any = Object.freeze(
    Object.fromEntries(
      RELEASE_EVIDENCE_KEYS.map((key?: any) : any => [key, authorityInput[key]]),
    ),
  );

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyJwk: any = publicKey.export({ format: "jwk" });
  const keyId: any = `fixture-${sourceCommit.slice(0, 8)}`;
  const artifactSigner: Record<string, any> = {
    keyId,
    async sign({ purpose, payloadDigest, context }: Record<string, any>) : Promise<any> {
      const contextDigest: any = `sha256:${sha256(canonicalJson(context || {}))}`;
      const safeReceipt: Record<string, any> = {
        receiptId: `${keyId}:${sha256(payloadDigest)}`,
        keyId,
        purpose,
        payloadDigest,
        signedAt: new Date().toISOString(),
      };
      const receipt: Record<string, any> = {
        ...safeReceipt,
        secretRevision: 1,
      };
      const signedEnvelope: Record<string, any> = {
        purpose,
        payloadDigest,
        contextDigest,
        receiptDigest: `sha256:${sha256(canonicalJson(safeReceipt))}`,
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
        receipt,
      };
    },
  };

  return {
    sourceCandidate,
    releaseImageAuthority: authority,
    releaseImageEvidence,
    ociLayoutPath: root,
    artifactSigner,
    trustedPublicKeys: { [keyId]: publicKeyJwk },
  };
}

export async function runEnterpriseOfflineBundleFixture({
  sourceCandidate,
  releaseImageAuthority,
  releaseImageEvidence,
  ociLayoutPath,
  artifactSigner,
  trustedPublicKeys,
  outputRoot,
  replayGuard,
  networkClient,
  processRunner,
}: Record<string, any> = {}) : Promise<any> {
  const suppliedFixtureFields: any = [
    sourceCandidate,
    releaseImageAuthority,
    releaseImageEvidence,
    ociLayoutPath,
    artifactSigner,
    trustedPublicKeys,
  ].filter((value?: any) : any => value !== undefined);
  if (
    suppliedFixtureFields.length !== 0
    && suppliedFixtureFields.length !== 6
  ) {
    fail(
      "enterprise_offline_bundle_fixture_arguments_invalid",
      "Fixture authority arguments must be supplied together.",
    );
  }

  const ownedRoots: any[] = [];
  try {
    if (suppliedFixtureFields.length === 0) {
      const root: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-offline-bundle-fixture-"),
      );
      ownedRoots.push(root);
      const fixture: any = await buildFixture(root);
      sourceCandidate = fixture.sourceCandidate;
      releaseImageAuthority = fixture.releaseImageAuthority;
      releaseImageEvidence = fixture.releaseImageEvidence;
      ociLayoutPath = fixture.ociLayoutPath;
      artifactSigner = fixture.artifactSigner;
      trustedPublicKeys = fixture.trustedPublicKeys;
    }

    const resolvedOutput: any = outputRoot || await fs.mkdtemp(
      path.join(os.tmpdir(), "meshrix-offline-bundle-output-"),
    );
    if (!outputRoot) {
      ownedRoots.push(resolvedOutput);
    }
    const bundle: any = await assembleEnterpriseOfflineBundle({
      sourceCandidate,
      releaseImageAuthority,
      releaseImageEvidence,
      ociLayoutPath,
      artifactSigner,
      trustedPublicKeys,
      outputRoot: resolvedOutput,
      optionalServiceEnabled: false,
    });

    const verified: any = await verifyEnterpriseOfflineBundle({
      bundle,
      bundleRoot: resolvedOutput,
      trustedPublicKeys,
      replayGuard,
    });

    if (networkClient?.request || processRunner) {
      void networkClient;
      void processRunner;
    }

    return Object.freeze({
      ...bundle,
      verified,
    });
  } finally {
    await Promise.all(
      ownedRoots.map((root?: any) : any => fs.rm(root, { recursive: true, force: true })),
    );
  }
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  if (!process.argv.includes("--fixture")) {
    process.stderr.write("Usage: node tools/server-scripts/enterprise-single-node-offline-bundle.ts --fixture\n");
    process.exitCode = 1;
  } else {
    (async () : Promise<any> => {
      const result: any = await runEnterpriseOfflineBundleFixture();
      const safeResult: Record<string, any> = {
        ok: true,
        schema_version: result.schema_version,
        candidate_digest: result.candidate_digest,
        image_digest: result.image_digest,
        inventory_digest: result.inventory_digest,
        compose: {
          image: result.compose.image,
          pull_policy: result.compose.pull_policy,
        },
      };
      process.stdout.write(`${JSON.stringify(safeResult)}\n`);
    })().catch((error?: any) : any => {
      process.stderr.write(`${JSON.stringify({
        code: error?.code || "enterprise_offline_bundle_failed",
      })}\n`);
      process.exitCode = 1;
    });
  }
}
