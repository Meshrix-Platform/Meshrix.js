import crypto from "node:crypto";

import {
  validateReleaseCandidateIdentity
} from "../verify-release-candidate-identity.ts";

export const RELEASE_IMAGE_AUTHORITY_SCHEMA: any = "v0.0.1:release:image-authority-2";
export const RELEASE_IMAGE_STATE_SCHEMA: any = "v0.0.1:release:image-state-1";
export const RELEASE_IMAGE_PLATFORMS: readonly any[] = Object.freeze(["linux/amd64", "linux/arm64"]);
export const RELEASE_IMAGE_PROVENANCE_PREDICATE: any = "https://slsa.dev/provenance/v0.2";
export const RELEASE_IMAGE_PROVENANCE_BUILD_TYPE: any = "https://mobyproject.org/buildkit@v1";
export const RELEASE_IMAGE_SBOM_FORMAT: any = "SPDX-2";

const DIGEST_PATTERN: any = /^sha256:[a-f0-9]{64}$/u;
const SHA256_PATTERN: any = /^[a-f0-9]{64}$/u;
const REPOSITORY_PATTERN: any = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SOURCE_REF_PATTERN: any = /^refs\/tags\/v[0-9A-Za-z][0-9A-Za-z.+-]*$/u;
const SOURCE_COMMIT_PATTERN: any = /^[a-f0-9]{40}$/u;
export const OCI_IMAGE_INDEX_MEDIA_TYPE: any = "application/vnd.oci.image.index." + "v1+json";
export const OCI_IMAGE_MANIFEST_MEDIA_TYPE: any = "application/vnd.oci.image.manifest." + "v1+json";
const ROOT_MEDIA_TYPES: any = new Set<any>([
  "application/vnd.docker.distribution.manifest.list." + "v2+json",
  OCI_IMAGE_INDEX_MEDIA_TYPE
]);
const MANIFEST_MEDIA_TYPES: any = new Set<any>([
  "application/vnd.docker.distribution.manifest." + "v2+json",
  OCI_IMAGE_MANIFEST_MEDIA_TYPE
]);
const PROVENANCE_FRONTENDS: any = new Set<any>(["dockerfile.v0", "gateway.v0"]);
const ATTESTATION_REFERENCE_TYPE: any = "attestation-manifest";
const ATTESTATION_REFERENCE_DIGEST: any = "vnd.docker.reference.digest";
const ATTESTATION_REFERENCE_KIND: any = "vnd.docker.reference.type";
const BUILDKIT_METADATA_KEY: any = "https://mobyproject.org/buildkit@v1#metadata";

export class ReleaseImageEvidenceError extends Error {
  code: any;
  name: any;
  constructor(code?: any, message?: any) {
    super(message);
    this.name = "ReleaseImageEvidenceError";
    this.code = code;
  }
}

function evidenceError(code?: any, message?: any) : any {
  return new ReleaseImageEvidenceError(code, message);
}

function isPlainObject(value?: any) : any {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requirePlainObject(value?: any, code?: any, message?: any) : any {
  if (!isPlainObject(value)) throw evidenceError(code, message);
  return value;
}

function parseJsonText(text?: any, label?: any) : any {
  const normalized: any = String(text || "").trim();
  if (!normalized) {
    throw evidenceError(`release_image_${label}_missing`, `The release image ${label} is missing.`);
  }
  try {
    return { normalized, value: JSON.parse(normalized) };
  } catch {
    throw evidenceError(
      `release_image_${label}_invalid`,
      `The release image ${label} is not valid JSON.`
    );
  }
}

function sha256(value?: any) : any {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function exactKeys(value?: any, expected?: any) : any {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function platformName(platform?: any) : any {
  if (!isPlainObject(platform)) return "";
  return `${String(platform.os || "")}/${String(platform.architecture || "")}`;
}

function validateCoordinates({
  image,
  digest,
  target,
  candidate,
  reused,
  repository,
  sourceRef,
  sourceCommit,
  workflowRef
}: Record<string, any>) : any {
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw evidenceError("release_image_repository_invalid", "The release repository is invalid.");
  }
  if (!SOURCE_REF_PATTERN.test(sourceRef)) {
    throw evidenceError("release_image_source_ref_invalid", "The release source ref is invalid.");
  }
  if (!SOURCE_COMMIT_PATTERN.test(sourceCommit)) {
    throw evidenceError("release_image_source_commit_invalid", "The release source commit is invalid.");
  }
  const owner: any = repository.slice(0, repository.indexOf("/")).toLowerCase();
  const expectedImage: any = `ghcr.io/${owner}/meshrix`;
  if (image !== expectedImage) {
    throw evidenceError("release_image_name_invalid", "The release image name is invalid.");
  }
  if (!DIGEST_PATTERN.test(digest)) {
    throw evidenceError("release_image_digest_invalid", "The release image digest is invalid.");
  }
  const version: any = sourceRef.slice("refs/tags/v".length);
  if (target !== `${image}:${version}` || candidate !== `${image}:candidate-${sourceCommit}`) {
    throw evidenceError(
      "release_image_coordinate_mismatch",
      "The release image target or candidate coordinate is invalid."
    );
  }
  if (typeof reused !== "boolean") {
    throw evidenceError("release_image_reuse_state_invalid", "The release image reuse state is invalid.");
  }
  if (workflowRef !== `${repository}/.github/workflows/release.yml@${sourceRef}`) {
    throw evidenceError(
      "release_image_workflow_ref_invalid",
      "The release image workflow ref is invalid."
    );
  }
}

function validateManifest({ descriptor, manifest, digest }: Record<string, any>) : any {
  requirePlainObject(descriptor, "release_image_descriptor_invalid", "The image descriptor is invalid.");
  requirePlainObject(manifest, "release_image_manifest_invalid", "The image manifest is invalid.");
  if (
    descriptor.digest !== digest
    || !ROOT_MEDIA_TYPES.has(descriptor.mediaType)
    || descriptor.mediaType !== manifest.mediaType
    || manifest.schemaVersion !== 2
    || !ROOT_MEDIA_TYPES.has(manifest.mediaType)
    || !Array.isArray(manifest.manifests)
  ) {
    throw evidenceError(
      "release_image_manifest_descriptor_mismatch",
      "The image descriptor and manifest index do not match the expected digest and schema."
    );
  }

  const runtimeEntries: any = manifest.manifests.filter((entry?: any) : any => entry?.platform?.os !== "unknown");
  const runtimePlatforms: any = runtimeEntries.map((entry?: any) : any => platformName(entry.platform));
  if (
    runtimeEntries.length !== RELEASE_IMAGE_PLATFORMS.length
    || JSON.stringify([...runtimePlatforms].sort()) !== JSON.stringify(RELEASE_IMAGE_PLATFORMS)
    || new Set<any>(runtimePlatforms).size !== runtimePlatforms.length
  ) {
    throw evidenceError(
      "release_image_platform_set_mismatch",
      "The image manifest does not contain exactly the supported release platforms."
    );
  }

  const runtimeByPlatform: any = new Map<any, any>();
  for (const entry of runtimeEntries) {
    const platform: any = platformName(entry.platform);
    if (!MANIFEST_MEDIA_TYPES.has(entry.mediaType) || !DIGEST_PATTERN.test(String(entry.digest || ""))) {
      throw evidenceError(
        "release_image_platform_descriptor_invalid",
        "A release platform descriptor is invalid."
      );
    }
    runtimeByPlatform.set(platform, entry);
  }

  const attestations: any = manifest.manifests.filter((entry?: any) : any => entry?.platform?.os === "unknown");
  if (attestations.length !== RELEASE_IMAGE_PLATFORMS.length) {
    throw evidenceError(
      "release_image_attestation_set_mismatch",
      "The image manifest must contain one attestation manifest for each release platform."
    );
  }
  const attestationBySubject: any = new Map<any, any>();
  for (const entry of attestations) {
    const annotations: any = requirePlainObject(
      entry.annotations,
      "release_image_attestation_descriptor_invalid",
      "An image attestation descriptor is invalid."
    );
    const subjectDigest: any = String(annotations[ATTESTATION_REFERENCE_DIGEST] || "");
    if (
      platformName(entry.platform) !== "unknown/unknown"
      || !MANIFEST_MEDIA_TYPES.has(entry.mediaType)
      || !DIGEST_PATTERN.test(String(entry.digest || ""))
      || annotations[ATTESTATION_REFERENCE_KIND] !== ATTESTATION_REFERENCE_TYPE
      || !DIGEST_PATTERN.test(subjectDigest)
      || attestationBySubject.has(subjectDigest)
    ) {
      throw evidenceError(
        "release_image_attestation_descriptor_invalid",
        "An image attestation descriptor is not bound to one unique subject digest."
      );
    }
    attestationBySubject.set(subjectDigest, entry);
  }

  return RELEASE_IMAGE_PLATFORMS.map((platform?: any) : any => {
    const subjectDigest: any = runtimeByPlatform.get(platform).digest;
    const attestation: any = attestationBySubject.get(subjectDigest);
    if (!attestation) {
      throw evidenceError(
        "release_image_attestation_subject_mismatch",
        "A release platform is missing its digest-bound attestation manifest."
      );
    }
    return {
      platform,
      subjectDigest,
      attestationDigest: attestation.digest
    };
  });
}

function validateMaterial(material?: any) : any {
  if (!isPlainObject(material) || typeof material.uri !== "string" || material.uri.length === 0) {
    return false;
  }
  if (!isPlainObject(material.digest) || Object.keys(material.digest).length === 0) return false;
  return (Object.entries(material.digest) as [string, any][]).every(([algorithm, value]: any[]) : any => (
    /^[a-z0-9][a-z0-9._-]*$/u.test(algorithm)
    && SHA256_PATTERN.test(String(value || ""))
  ));
}

function normalizeGitHubRepositorySource(value?: any) : any {
  const source: any = String(value || "").trim();
  const sshMatch: any = source.match(/^git@github\.com:([^?#]+?)(?:\.git)?$/u);
  if (sshMatch) return sshMatch[1].replace(/\.git$/u, "");
  let sourceUrl: any;
  try {
    sourceUrl = new URL(source);
  } catch {
    return "";
  }
  if (
    sourceUrl.hostname.toLowerCase() !== "github.com"
    || sourceUrl.username
    || sourceUrl.password
    || sourceUrl.search
    || sourceUrl.hash
  ) {
    return "";
  }
  return decodeURIComponent(sourceUrl.pathname)
    .replace(/^\/+|\/+$/gu, "")
    .replace(/\.git$/u, "");
}

function validateProvenance({ provenance, repository, sourceRef, sourceCommit }: Record<string, any>) : any {
  requirePlainObject(
    provenance,
    "release_image_provenance_invalid",
    "The release image provenance is invalid."
  );
  if (!exactKeys(provenance, RELEASE_IMAGE_PLATFORMS)) {
    throw evidenceError(
      "release_image_provenance_platform_set_mismatch",
      "The provenance platform set does not match the release manifest."
    );
  }

  for (const platform of RELEASE_IMAGE_PLATFORMS) {
    const wrapper: any = requirePlainObject(
      provenance[platform],
      "release_image_provenance_invalid",
      "A release platform provenance statement is invalid."
    );
    const predicate: any = requirePlainObject(
      wrapper.SLSA,
      "release_image_provenance_schema_mismatch",
      "A release platform is missing its SLSA provenance predicate."
    );
    const invocation: any = requirePlainObject(
      predicate.invocation,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance invocation is invalid."
    );
    const parameters: any = requirePlainObject(
      invocation.parameters,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance parameters are invalid."
    );
    const args: any = requirePlainObject(
      parameters.args,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance build arguments are invalid."
    );
    const environment: any = requirePlainObject(
      invocation.environment,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance environment is invalid."
    );
    const metadata: any = requirePlainObject(
      predicate.metadata,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance metadata is invalid."
    );
    const completeness: any = requirePlainObject(
      metadata.completeness,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance completeness declaration is invalid."
    );
    requirePlainObject(
      predicate.builder,
      "release_image_provenance_schema_mismatch",
      "The SLSA provenance builder is invalid."
    );
    const buildkitMetadata: any = requirePlainObject(
      metadata[BUILDKIT_METADATA_KEY],
      "release_image_provenance_schema_mismatch",
      "The BuildKit provenance metadata is invalid."
    );
    const vcs: any = requirePlainObject(
      buildkitMetadata.vcs,
      "release_image_provenance_source_mismatch",
      "The BuildKit provenance VCS binding is invalid."
    );
    if (
      predicate.buildType !== RELEASE_IMAGE_PROVENANCE_BUILD_TYPE
      || typeof predicate.builder.id !== "string"
      || !PROVENANCE_FRONTENDS.has(parameters.frontend)
      || args.target !== "runtime-ui"
      || environment.platform !== platform
      || completeness.parameters !== true
      || completeness.environment !== true
      || typeof completeness.materials !== "boolean"
      || typeof metadata.buildInvocationID !== "string"
      || metadata.buildInvocationID.length === 0
      || typeof metadata.buildStartedOn !== "string"
      || typeof metadata.buildFinishedOn !== "string"
      || Number.isNaN(Date.parse(metadata.buildStartedOn))
      || Number.isNaN(Date.parse(metadata.buildFinishedOn))
      || Date.parse(metadata.buildStartedOn) > Date.parse(metadata.buildFinishedOn)
      || typeof metadata.reproducible !== "boolean"
      || !Array.isArray(predicate.materials)
      || predicate.materials.length === 0
      || !predicate.materials.every(validateMaterial)
    ) {
      throw evidenceError(
        "release_image_provenance_schema_mismatch",
        "The release image provenance does not satisfy the required SLSA semantics."
      );
    }
    if (
      args["build-arg:MESHRIX_SOURCE_REPOSITORY"] !== repository
      || args["build-arg:MESHRIX_SOURCE_REF"] !== sourceRef
      || args["build-arg:MESHRIX_SOURCE_COMMIT"] !== sourceCommit
      || vcs.revision !== sourceCommit
      || normalizeGitHubRepositorySource(vcs.source).toLowerCase() !== repository.toLowerCase()
    ) {
      throw evidenceError(
        "release_image_provenance_source_mismatch",
        "The release image provenance is not bound to the exact repository, ref, and commit."
      );
    }
  }
}

function validateSpdxDocument(document?: any) : any {
  requirePlainObject(
    document,
    "release_image_sbom_schema_mismatch",
    "A release platform SPDX document is invalid."
  );
  const creationInfo: any = requirePlainObject(
    document.creationInfo,
    "release_image_sbom_schema_mismatch",
    "A release platform SPDX creation record is invalid."
  );
  if (
    !/^SPDX-2\.[0-9]+$/u.test(String(document.spdxVersion || ""))
    || document.SPDXID !== "SPDXRef-DOCUMENT"
    || document.dataLicense !== "CC0-1.0"
    || typeof document.documentNamespace !== "string"
    || !/^https?:\/\//u.test(document.documentNamespace)
    || typeof document.name !== "string"
    || document.name.length === 0
    || !Array.isArray(creationInfo.creators)
    || creationInfo.creators.length === 0
    || !creationInfo.creators.every((creator?: any) : any => typeof creator === "string" && creator.length > 0)
    || !Array.isArray(document.packages)
    || document.packages.length === 0
    || !document.packages.every((entry?: any) : any => (
      isPlainObject(entry)
      && /^SPDXRef-/u.test(String(entry.SPDXID || ""))
      && typeof entry.name === "string"
      && entry.name.length > 0
    ))
    || !Array.isArray(document.relationships)
  ) {
    throw evidenceError(
      "release_image_sbom_schema_mismatch",
      "A release platform SBOM does not satisfy the required SPDX semantics."
    );
  }
}

function validateSbom(sbom?: any) : any {
  requirePlainObject(sbom, "release_image_sbom_invalid", "The release image SBOM is invalid.");
  if (!exactKeys(sbom, RELEASE_IMAGE_PLATFORMS)) {
    throw evidenceError(
      "release_image_sbom_platform_set_mismatch",
      "The SBOM platform set does not match the release manifest."
    );
  }
  for (const platform of RELEASE_IMAGE_PLATFORMS) {
    const wrapper: any = requirePlainObject(
      sbom[platform],
      "release_image_sbom_schema_mismatch",
      "A release platform SBOM wrapper is invalid."
    );
    if (!exactKeys(wrapper, ["SPDX"])) {
      throw evidenceError(
        "release_image_sbom_schema_mismatch",
        "A release platform SBOM must contain exactly one SPDX document."
      );
    }
    validateSpdxDocument(wrapper.SPDX);
  }
}

export function buildReleaseImageAuthority({
  image,
  digest,
  target,
  candidate,
  reused,
  repository,
  sourceRef,
  sourceCommit,
  sourceCandidate,
  workflowRef,
  manifestDescriptorText,
  manifestText,
  provenanceText,
  sbomText
}: Record<string, any>) : any {
  validateCoordinates({
    image,
    digest,
    target,
    candidate,
    reused,
    repository,
    sourceRef,
    sourceCommit,
    workflowRef
  });
  const validatedSourceCandidate: any = validateReleaseCandidateIdentity(sourceCandidate);
  if (validatedSourceCandidate.source_revision !== sourceCommit) {
    throw evidenceError(
      "release_image_source_candidate_mismatch",
      "The release image source candidate does not match the release source commit."
    );
  }
  const descriptor: any = parseJsonText(manifestDescriptorText, "manifest_descriptor");
  const manifest: any = parseJsonText(manifestText, "manifest");
  const provenance: any = parseJsonText(provenanceText, "provenance");
  const sbom: any = parseJsonText(sbomText, "sbom");
  const platformEvidence: any = validateManifest({
    descriptor: descriptor.value,
    manifest: manifest.value,
    digest
  });
  validateProvenance({
    provenance: provenance.value,
    repository,
    sourceRef,
    sourceCommit
  });
  validateSbom(sbom.value);

  return {
    schemaVersion: RELEASE_IMAGE_AUTHORITY_SCHEMA,
    repository,
    sourceCommit,
    sourceRef,
    candidateDigest: validatedSourceCandidate.candidate_digest,
    workflowRef,
    image,
    digest,
    platforms: [...RELEASE_IMAGE_PLATFORMS],
    platformEvidence,
    provenancePredicateType: RELEASE_IMAGE_PROVENANCE_PREDICATE,
    provenanceBuildType: RELEASE_IMAGE_PROVENANCE_BUILD_TYPE,
    sbomFormat: RELEASE_IMAGE_SBOM_FORMAT,
    manifestDescriptorSha256: sha256(descriptor.normalized),
    manifestSha256: sha256(manifest.normalized),
    provenanceSha256: sha256(provenance.normalized),
    sbomSha256: sha256(sbom.normalized),
    provenanceVerified: true,
    sbomVerified: true
  };
}

export function buildReleaseImageState({ authorityText, target, candidate, reused }: Record<string, any>) : any {
  const authority: any = parseJsonText(authorityText, "authority").value;
  if (authority.schemaVersion !== RELEASE_IMAGE_AUTHORITY_SCHEMA) {
    throw evidenceError(
      "release_image_authority_schema_mismatch",
      "The release image authority schema is invalid."
    );
  }
  if (!SHA256_PATTERN.test(String(authority.candidateDigest || ""))) {
    throw evidenceError(
      "release_image_source_candidate_invalid",
      "The release image source candidate digest is invalid."
    );
  }
  return {
    schemaVersion: RELEASE_IMAGE_STATE_SCHEMA,
    repository: authority.repository,
    sourceCommit: authority.sourceCommit,
    sourceRef: authority.sourceRef,
    candidateDigest: authority.candidateDigest,
    workflowRef: authority.workflowRef,
    image: authority.image,
    digest: authority.digest,
    target,
    candidate,
    reused,
    authoritySha256: sha256(authorityText)
  };
}
