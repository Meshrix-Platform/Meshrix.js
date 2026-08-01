#!/usr/bin/env node

import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { loadDeploymentIndex } from "./deployment-index.ts";
import {
  createProductionIngressContract,
  PRODUCTION_INGRESS_TRUSTED_PROXY_MODE
} from "../../packages/foundation/src/security/production-ingress-contract.ts";

const modulePath: any = fileURLToPath(import.meta.url);
const repoRoot: any = path.resolve(path.dirname(modulePath), "../..");
const DIGEST_IMAGE_PATTERN: any =
  /^(?=.{1,512}$)[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)+@sha256:[a-f0-9]{64}$/u;
const PROJECT_PATTERN: any = /^[a-z0-9][a-z0-9_-]{0,62}$/u;

function requireCondition(condition?: any, code?: any) : any {
  if (!condition) throw new Error(code);
}

function digestPinnedImage(value?: any, code?: any) : any {
  const normalized: any = String(value || "").trim();
  requireCondition(DIGEST_IMAGE_PATTERN.test(normalized), code);
  return normalized;
}

function projectName(value: any = "meshrix") : any {
  const normalized: any = String(value || "").trim();
  requireCondition(PROJECT_PATTERN.test(normalized), "cloud_deployment_project_invalid");
  return normalized;
}

function pathIsWithin(parent?: any, child?: any) : any {
  const relative: any = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function enterpriseEnvironmentConfigured({
  secretKeySourceConfigured = false,
  proofSignerSecretSourceConfigured = false,
  securePublicBaseUrlConfigured = false,
  trustedProxyConfigured = false,
}: Record<string, any> = {}) : any {
  requireCondition(
    secretKeySourceConfigured === true,
    "cloud_deployment_secret_key_source_required",
  );
  requireCondition(
    proofSignerSecretSourceConfigured === true,
    "cloud_deployment_proof_signer_secret_source_required",
  );
  requireCondition(
    securePublicBaseUrlConfigured === true,
    "cloud_deployment_secure_public_base_url_required",
  );
  requireCondition(
    trustedProxyConfigured === true,
    "cloud_deployment_trusted_proxy_required",
  );
}

function composeActivation(project?: any) : any {
  return Object.freeze({
    executable: "docker",
    args: Object.freeze([
      "compose",
      "-f",
      "docker-compose.yml",
      "-f",
      "docker-compose.enterprise.yml",
      "-p",
      project,
      "up",
      "-d",
      "--no-build",
      "--pull",
      "never",
      "--wait",
      "meshrix-server",
    ]),
  });
}

export function createEnterpriseSingleNodeCloudDeploymentPlan({
  candidateImage,
  previousImage = "",
  project = "meshrix",
  offline = false,
  secretKeySourceConfigured = false,
  proofSignerSecretSourceConfigured = false,
  securePublicBaseUrlConfigured = false,
  trustedProxyConfigured = false,
}: Record<string, any> = {}) : any {
  const candidate: any = digestPinnedImage(
    candidateImage,
    "cloud_deployment_candidate_digest_required",
  );
  const previous: any = previousImage
    ? digestPinnedImage(previousImage, "cloud_deployment_previous_digest_invalid")
    : "";
  requireCondition(
    !previous || previous !== candidate,
    "cloud_deployment_previous_candidate_must_differ",
  );
  const selectedProject: any = projectName(project);
  enterpriseEnvironmentConfigured({
    secretKeySourceConfigured,
    proofSignerSecretSourceConfigured,
    securePublicBaseUrlConfigured,
    trustedProxyConfigured,
  });
  const admission: any = offline
    ? {
        executable: "docker",
        args: ["image", "inspect", candidate],
        networkRequired: false,
        requirement: "candidate image must already be loaded and digest-addressable",
      }
    : {
        executable: "docker",
        args: ["pull", candidate],
        networkRequired: true,
        requirement: "registry transport is required only before activation",
      };
  return Object.freeze({
    profile: "enterprise-single-node",
    candidateImage: candidate,
    previousImage: previous || null,
    environment: Object.freeze({
      MESHRIX_IMAGE_NAME: candidate,
      MESHRIX_PULL_POLICY: "never",
    }),
    phases: Object.freeze([
      Object.freeze({ id: "admit-candidate", command: Object.freeze(admission) }),
      Object.freeze({
        id: "pre-upgrade-backup",
        operationId: "storage.backups.create",
        requiredReceipt: true,
        target: "independent server-backups volume",
      }),
      Object.freeze({
        id: "activate-candidate",
        command: composeActivation(selectedProject),
      }),
      Object.freeze({
        id: "validate-health",
        command: Object.freeze({
          executable: "docker",
          args: Object.freeze([
            "compose",
            "-f",
            "docker-compose.yml",
            "-f",
            "docker-compose.enterprise.yml",
            "-p",
            selectedProject,
            "ps",
            "--status",
            "running",
            "meshrix-server",
          ]),
        }),
        requireHealthyContainer: true,
      }),
    ]),
    rollback: previous
      ? Object.freeze({
          environment: Object.freeze({
            MESHRIX_IMAGE_NAME: previous,
            MESHRIX_PULL_POLICY: "never",
          }),
          command: composeActivation(selectedProject),
          restorePreviewOperationId: "storage.backups.restore_preview",
          restoreOperationId: "storage.backups.restore",
        })
      : null,
    invariants: Object.freeze({
      imageDigestPinned: true,
      activationNetworkRequired: false,
      localBuildForbidden: true,
      persistentDataVolumeRequired: true,
      independentBackupVolumeRequired: true,
      nonRootUid: 10001,
      readOnlyRootFilesystem: true,
      externalSecretKeyCustodyRequired: true,
      productionProofSigningRequired: true,
      separateEncryptionAndSigningSecretsRequired: true,
      securePublicBaseUrlRequired: true,
      trustedProxyIngressRequired: true,
      upgradeRollbackStateMachineImplemented: true,
    }),
    blockers: Object.freeze([
      "real_n_minus_one_released-image_receipt_pending",
      "signed_offline_multi-architecture_oci_bundle_not_produced",
      "operator_tls_certificate_live_readiness_requires_external_receipt",
    ]),
  });
}

function valueAfter(args?: any, flag?: any) : any {
  const index: any = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

async function validateExternalHexSecretSource({
  configuredPath = "",
  requiredCode,
  invalidCode,
}: Record<string, any> = {}) : Promise<any> {
  const source: any = String(configuredPath || "").trim();
  requireCondition(path.isAbsolute(source), requiredCode);
  const [stat, realPath] = await Promise.all([
    fs.lstat(source).catch(() : any => null),
    fs.realpath(source).catch(() : any => ""),
  ]);
  requireCondition(
    stat?.isFile() &&
      !stat.isSymbolicLink() &&
      stat.size <= 256 &&
      realPath &&
      !pathIsWithin(repoRoot, realPath) &&
      (process.platform === "win32" || (stat.mode & 0o077) === 0),
    invalidCode,
  );
  const bytes: any = await fs.readFile(realPath).catch(() : any => null);
  try {
    requireCondition(
      Buffer.isBuffer(bytes) &&
        (bytes.length === 64 || (bytes.length === 65 && bytes[64] === 0x0a)) &&
        bytes.subarray(0, 64).every((byte?: any) : any =>
          (byte >= 0x30 && byte <= 0x39) || (byte >= 0x61 && byte <= 0x66)),
      invalidCode,
    );
    return Object.freeze({
      realPath,
      secretDigest: createHash("sha256").update(bytes.subarray(0, 64)).digest("hex"),
    });
  } finally {
    bytes?.fill(0);
  }
}

export async function validateEnterpriseSecretCustody({
  encryptionSecretPath = "",
  proofSignerSecretPath = "",
}: Record<string, any> = {}) : Promise<any> {
  const encryptionSecret: any = await validateExternalHexSecretSource({
    configuredPath: encryptionSecretPath,
    requiredCode: "cloud_deployment_secret_key_source_required",
    invalidCode: "cloud_deployment_secret_key_source_invalid",
  });
  const proofSignerSecret: any = await validateExternalHexSecretSource({
    configuredPath: proofSignerSecretPath,
    requiredCode: "cloud_deployment_proof_signer_secret_source_required",
    invalidCode: "cloud_deployment_proof_signer_secret_source_invalid",
  });
  requireCondition(
    encryptionSecret.realPath !== proofSignerSecret.realPath &&
      encryptionSecret.secretDigest !== proofSignerSecret.secretDigest,
    "cloud_deployment_secret_custody_separation_required",
  );
  return Object.freeze({ ready: true, distinct: true, external: true });
}

async function main() : Promise<any> {
  const args: any = process.argv.slice(2);
  requireCondition(
    args[0] === "plan",
    "Usage: enterprise-single-node-cloud-deployment.ts plan --candidate <digest-reference> [--previous <digest-reference>] [--offline] [--project <name>]",
  );
  const index: any = await loadDeploymentIndex({ cwd: repoRoot });
  requireCondition(
    index.dockerPresets?.mainService?.immutableCandidate?.offlineStartRequiresPreloadedImage === true,
    "cloud_deployment_index_contract_missing",
  );
  await validateEnterpriseSecretCustody({
    encryptionSecretPath: process.env.MESHRIX_LOCAL_SECRET_MASTER_KEY_SOURCE,
    proofSignerSecretPath: process.env.MESHRIX_OPERATION_PROOF_SIGNER_SECRET_SOURCE,
  });
  let publicBaseUrl: any;
  try {
    publicBaseUrl = new URL(String(process.env.MESHRIX_PUBLIC_BASE_URL || ""));
  } catch {
    throw new Error("cloud_deployment_secure_public_base_url_required");
  }
  requireCondition(
    publicBaseUrl.protocol === "https:" &&
      !publicBaseUrl.username &&
      !publicBaseUrl.password &&
      !publicBaseUrl.search &&
      !publicBaseUrl.hash,
    "cloud_deployment_secure_public_base_url_required",
  );
  createProductionIngressContract({
    mode: PRODUCTION_INGRESS_TRUSTED_PROXY_MODE,
    advertisedBaseUrl: publicBaseUrl.origin,
    trustedProxies: process.env.MESHRIX_TRUSTED_PROXIES,
    cookieSecure: "always"
  });
  const plan: any = createEnterpriseSingleNodeCloudDeploymentPlan({
    candidateImage: valueAfter(args, "--candidate"),
    previousImage: valueAfter(args, "--previous"),
    project: valueAfter(args, "--project") || "meshrix",
    offline: args.includes("--offline"),
    secretKeySourceConfigured: true,
    proofSignerSecretSourceConfigured: true,
    securePublicBaseUrlConfigured: true,
    trustedProxyConfigured: true,
  });
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

const direct: any = process.argv[1] && path.resolve(process.argv[1]) === modulePath;
if (direct) {
  main().catch((error?: any) : any => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
