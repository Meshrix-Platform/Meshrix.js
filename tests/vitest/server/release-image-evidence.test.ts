import { describe, expect, it } from "vitest";

import {
  parseReleaseImageAuthorityArguments
} from "../../../tools/server-scripts/create-release-image-authority.ts";
import {
  RELEASE_IMAGE_AUTHORITY_SCHEMA,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  RELEASE_IMAGE_PLATFORMS,
  buildReleaseImageAuthority,
  buildReleaseImageState
} from "../../../tools/server-scripts/lib/release-image-evidence.ts";
import {
  buildReleaseCandidateIdentity
} from "../../../tools/server-scripts/verify-release-candidate-identity.ts";

const COMMIT: any = "0123456789abcdef0123456789abcdef01234567";
const ROOT_DIGEST: any = `sha256:${"a".repeat(64)}`;
const AMD64_DIGEST: any = `sha256:${"b".repeat(64)}`;
const ARM64_DIGEST: any = `sha256:${"c".repeat(64)}`;
const AMD64_ATTESTATION: any = `sha256:${"d".repeat(64)}`;
const ARM64_ATTESTATION: any = `sha256:${"e".repeat(64)}`;
const MEDIA_TYPE: any = OCI_IMAGE_INDEX_MEDIA_TYPE;
const MANIFEST_MEDIA_TYPE: any = OCI_IMAGE_MANIFEST_MEDIA_TYPE;

function sourceCandidate(sourceRevision: any = COMMIT) : any {
  return buildReleaseCandidateIdentity({
    sourceRevision,
    repositoryTreeDigest: `sha256:${"1".repeat(64)}`,
    releaseDefinitionSha256: `sha256:${"2".repeat(64)}`,
    packageLockSha256: `sha256:${"3".repeat(64)}`,
    releasePackages: [
      {
        manifest_path: "packages/contracts/package.json",
        name: "@meshrix/contracts",
        version: "1.2.3",
        manifest_sha256: "5".repeat(64)
      },
      {
        manifest_path: "apps/server/package.json",
        name: "@meshrix/server",
        version: "1.2.3",
        manifest_sha256: "6".repeat(64)
      }
    ],
    supportedProfiles: ["enterprise-single-node"],
    reportInventoryDigest: `sha256:${"4".repeat(64)}`
  });
}

function provenanceFor(platform?: any) : any {
  return {
    SLSA: {
      buildType: "https://mobyproject.org/buildkit@v1",
      builder: { id: "" },
      invocation: {
        parameters: {
          frontend: "dockerfile.v0",
          args: {
            target: "runtime-ui",
            "build-arg:MESHRIX_SOURCE_REPOSITORY": "Acme/Meshrix",
            "build-arg:MESHRIX_SOURCE_REF": "refs/tags/v1.2.3",
            "build-arg:MESHRIX_SOURCE_COMMIT": COMMIT
          }
        },
        environment: { platform }
      },
      metadata: {
        buildInvocationID: `fixture-${platform}`,
        buildStartedOn: "2026-01-01T00:00:00.000Z",
        buildFinishedOn: "2026-01-01T00:00:01.000Z",
        reproducible: false,
        completeness: { parameters: true, environment: true, materials: false },
        "https://mobyproject.org/buildkit@v1#metadata": {
          vcs: {
            revision: COMMIT,
            source: "https://github.com/Acme/Meshrix.git"
          }
        }
      },
      materials: [{
        uri: "pkg:docker/node@24",
        digest: { sha256: "f".repeat(64) }
      }]
    }
  };
}

function sbomFor(platform?: any) : any {
  return {
    SPDX: {
      spdxVersion: "SPDX-2.3",
      SPDXID: "SPDXRef-DOCUMENT",
      dataLicense: "CC0-1.0",
      name: `meshrix-${platform.replace("/", "-")}`,
      documentNamespace: `https://example.invalid/spdx/${platform.replace("/", "-")}`,
      creationInfo: { creators: ["Tool: buildkit"] },
      packages: [{ SPDXID: "SPDXRef-Package-meshrix", name: "meshrix" }],
      relationships: []
    }
  };
}

function fixture() : any {
  return {
    image: "ghcr.io/acme/meshrix",
    digest: ROOT_DIGEST,
    target: "ghcr.io/acme/meshrix:1.2.3",
    candidate: `ghcr.io/acme/meshrix:candidate-${COMMIT}`,
    reused: false,
    repository: "Acme/Meshrix",
    sourceRef: "refs/tags/v1.2.3",
    sourceCommit: COMMIT,
    sourceCandidate: sourceCandidate(),
    workflowRef: "Acme/Meshrix/.github/workflows/release.yml@refs/tags/v1.2.3",
    manifestDescriptorText: JSON.stringify({ digest: ROOT_DIGEST, mediaType: MEDIA_TYPE }),
    manifestText: JSON.stringify({
      schemaVersion: 2,
      mediaType: MEDIA_TYPE,
      manifests: [
        {
          mediaType: MANIFEST_MEDIA_TYPE,
          digest: AMD64_DIGEST,
          platform: { os: "linux", architecture: "amd64" }
        },
        {
          mediaType: MANIFEST_MEDIA_TYPE,
          digest: ARM64_DIGEST,
          platform: { os: "linux", architecture: "arm64" }
        },
        {
          mediaType: MANIFEST_MEDIA_TYPE,
          digest: AMD64_ATTESTATION,
          platform: { os: "unknown", architecture: "unknown" },
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": AMD64_DIGEST
          }
        },
        {
          mediaType: MANIFEST_MEDIA_TYPE,
          digest: ARM64_ATTESTATION,
          platform: { os: "unknown", architecture: "unknown" },
          annotations: {
            "vnd.docker.reference.type": "attestation-manifest",
            "vnd.docker.reference.digest": ARM64_DIGEST
          }
        }
      ]
    }),
    provenanceText: JSON.stringify(Object.fromEntries(
      RELEASE_IMAGE_PLATFORMS.map((platform?: any) : any => [platform, provenanceFor(platform)])
    )),
    sbomText: JSON.stringify(Object.fromEntries(
      RELEASE_IMAGE_PLATFORMS.map((platform?: any) : any => [platform, sbomFor(platform)])
    ))
  };
}

function mutateJson(source?: any, mutate?: any) : any {
  const value: any = JSON.parse(source);
  mutate(value);
  return JSON.stringify(value);
}

describe("release image evidence authority", () : any => {
  it("requires one explicit value for every authority input", () : any => {
    const args: any[] = [
      "--image", "ghcr.io/acme/meshrix",
      "--digest", ROOT_DIGEST,
      "--target", "ghcr.io/acme/meshrix:1.2.3",
      "--candidate", `ghcr.io/acme/meshrix:candidate-${COMMIT}`,
      "--reused", "false",
      "--repository", "Acme/Meshrix",
      "--source-ref", "refs/tags/v1.2.3",
      "--source-commit", COMMIT,
      "--source-candidate", "source-candidate.json",
      "--workflow-ref", "Acme/Meshrix/.github/workflows/release.yml@refs/tags/v1.2.3",
      "--manifest-descriptor", "descriptor.json",
      "--manifest", "manifest.json",
      "--provenance", "provenance.json",
      "--sbom", "sbom.json",
      "--authority-output", "authority.json",
      "--state-output", "state.json"
    ];
    expect(parseReleaseImageAuthorityArguments(args)).toMatchObject({
      image: "ghcr.io/acme/meshrix",
      digest: ROOT_DIGEST,
      reused: false,
      sourceCandidate: "source-candidate.json",
      manifestDescriptor: "descriptor.json",
      authorityOutput: "authority.json"
    });
    expect(() : any => parseReleaseImageAuthorityArguments([...args, "--unknown", "value"]))
      .toThrow("release_image_argument_invalid");
    expect(() : any => parseReleaseImageAuthorityArguments([...args, "--image", "duplicate"]))
      .toThrow("release_image_argument_invalid");

    const sourceCandidateIndex: any = args.indexOf("--source-candidate");
    const withoutSourceCandidate: any[] = [
      ...args.slice(0, sourceCandidateIndex),
      ...args.slice(sourceCandidateIndex + 2)
    ];
    expect(() : any => parseReleaseImageAuthorityArguments(withoutSourceCandidate))
      .toThrow("release_image_argument_missing");
  });

  it("binds each release platform, attestation subject, source coordinate, and evidence digest", () : any => {
    const input: any = fixture();
    const authority: any = buildReleaseImageAuthority(input);
    expect(authority).toMatchObject({
      schemaVersion: RELEASE_IMAGE_AUTHORITY_SCHEMA,
      repository: "Acme/Meshrix",
      sourceCommit: COMMIT,
      sourceRef: "refs/tags/v1.2.3",
      candidateDigest: input.sourceCandidate.candidate_digest,
      image: "ghcr.io/acme/meshrix",
      digest: ROOT_DIGEST,
      platforms: RELEASE_IMAGE_PLATFORMS,
      provenancePredicateType: "https://slsa.dev/provenance/v0.2",
      provenanceBuildType: "https://mobyproject.org/buildkit@v1",
      sbomFormat: "SPDX-2",
      provenanceVerified: true,
      sbomVerified: true
    });
    expect(authority.platformEvidence).toEqual([
      { platform: "linux/amd64", subjectDigest: AMD64_DIGEST, attestationDigest: AMD64_ATTESTATION },
      { platform: "linux/arm64", subjectDigest: ARM64_DIGEST, attestationDigest: ARM64_ATTESTATION }
    ]);
    for (const field of [
      "manifestDescriptorSha256",
      "manifestSha256",
      "provenanceSha256",
      "sbomSha256"
    ]) {
      expect(authority[field]).toMatch(/^[a-f0-9]{64}$/u);
    }

    const authorityText: any = `${JSON.stringify(authority, null, 2)}\n`;
    const state: any = buildReleaseImageState({
      authorityText,
      target: input.target,
      candidate: input.candidate,
      reused: input.reused
    });
    expect(state).toMatchObject({
      repository: input.repository,
      sourceCommit: input.sourceCommit,
      candidateDigest: input.sourceCandidate.candidate_digest,
      digest: input.digest,
      target: input.target,
      candidate: input.candidate,
      reused: false
    });
    expect(state.authoritySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects a different source-candidate revision or candidate authority digest", () : any => {
    const wrongRevision: any = fixture();
    wrongRevision.sourceCandidate = sourceCandidate("1".repeat(40));
    expect(() : any => buildReleaseImageAuthority(wrongRevision)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/candidate/u) })
    );

    const substitutedAuthority: any = fixture();
    substitutedAuthority.sourceCandidate = {
      ...substitutedAuthority.sourceCandidate,
      candidate_digest: "0".repeat(64)
    };
    expect(() : any => buildReleaseImageAuthority(substitutedAuthority)).toThrowError(
      expect.objectContaining({ code: expect.stringMatching(/candidate/u) })
    );
  });

  it("rejects commit substrings instead of accepting them as source binding", () : any => {
    const input: any = fixture();
    input.provenanceText = mutateJson(input.provenanceText, (provenance?: any) : any => {
      provenance["linux/amd64"].SLSA.invocation.parameters.args[
        "build-arg:MESHRIX_SOURCE_COMMIT"
      ] = `prefix-${COMMIT}-suffix`;
    });
    expect(() : any => buildReleaseImageAuthority(input)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_source_mismatch" })
    );
  });

  it("rejects wrong repository and ref values even when the commit is exact", () : any => {
    const input: any = fixture();
    input.provenanceText = mutateJson(input.provenanceText, (provenance?: any) : any => {
      provenance["linux/arm64"].SLSA.invocation.parameters.args[
        "build-arg:MESHRIX_SOURCE_REPOSITORY"
      ] = "Acme/Elsewhere";
      provenance["linux/arm64"].SLSA.invocation.parameters.args[
        "build-arg:MESHRIX_SOURCE_REF"
      ] = "refs/tags/v9.9.9";
    });
    expect(() : any => buildReleaseImageAuthority(input)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_source_mismatch" })
    );

    const forgedVcs: any = fixture();
    forgedVcs.provenanceText = mutateJson(forgedVcs.provenanceText, (provenance?: any) : any => {
      provenance["linux/amd64"].SLSA.metadata[
        "https://mobyproject.org/buildkit@v1#metadata"
      ].vcs.source = "https://github.com/Acme/Elsewhere.git";
    });
    expect(() : any => buildReleaseImageAuthority(forgedVcs)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_source_mismatch" })
    );
  });

  it("rejects missing platform provenance and empty SBOM placeholders", () : any => {
    const missingPlatform: any = fixture();
    missingPlatform.provenanceText = mutateJson(missingPlatform.provenanceText, (provenance?: any) : any => {
      delete provenance["linux/arm64"];
    });
    expect(() : any => buildReleaseImageAuthority(missingPlatform)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_platform_set_mismatch" })
    );

    const emptySbom: any = fixture();
    emptySbom.sbomText = JSON.stringify({
      "linux/amd64": { SPDX: {} },
      "linux/arm64": { SPDX: {} }
    });
    expect(() : any => buildReleaseImageAuthority(emptySbom)).toThrowError(
      expect.objectContaining({ code: "release_image_sbom_schema_mismatch" })
    );
  });

  it("rejects manifest digest and attestation-subject mismatches", () : any => {
    const descriptorMismatch: any = fixture();
    descriptorMismatch.manifestDescriptorText = JSON.stringify({
      digest: `sha256:${"0".repeat(64)}`,
      mediaType: MEDIA_TYPE
    });
    expect(() : any => buildReleaseImageAuthority(descriptorMismatch)).toThrowError(
      expect.objectContaining({ code: "release_image_manifest_descriptor_mismatch" })
    );

    const subjectMismatch: any = fixture();
    subjectMismatch.manifestText = mutateJson(subjectMismatch.manifestText, (manifest?: any) : any => {
      manifest.manifests[2].annotations["vnd.docker.reference.digest"] =
        `sha256:${"1".repeat(64)}`;
    });
    expect(() : any => buildReleaseImageAuthority(subjectMismatch)).toThrowError(
      expect.objectContaining({ code: "release_image_attestation_subject_mismatch" })
    );
  });

  it("rejects platform and SPDX schema substitutions", () : any => {
    const wrongPlatform: any = fixture();
    wrongPlatform.provenanceText = mutateJson(wrongPlatform.provenanceText, (provenance?: any) : any => {
      provenance["linux/arm64"].SLSA.invocation.environment.platform = "linux/amd64";
    });
    expect(() : any => buildReleaseImageAuthority(wrongPlatform)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_schema_mismatch" })
    );

    const wrongSpdx: any = fixture();
    wrongSpdx.sbomText = mutateJson(wrongSpdx.sbomText, (sbom?: any) : any => {
      sbom["linux/amd64"].SPDX.spdxVersion = "CycloneDX-1.6";
    });
    expect(() : any => buildReleaseImageAuthority(wrongSpdx)).toThrowError(
      expect.objectContaining({ code: "release_image_sbom_schema_mismatch" })
    );
  });
});
