import { describe, expect, it } from "vitest";

import {
  parseReleaseImageAuthorityArguments
} from "../../../tools/server-scripts/create-release-image-authority.mjs";
import {
  RELEASE_IMAGE_AUTHORITY_SCHEMA,
  OCI_IMAGE_INDEX_MEDIA_TYPE,
  OCI_IMAGE_MANIFEST_MEDIA_TYPE,
  RELEASE_IMAGE_PLATFORMS,
  buildReleaseImageAuthority,
  buildReleaseImageState
} from "../../../tools/server-scripts/lib/release-image-evidence.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const ROOT_DIGEST = `sha256:${"a".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"b".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"c".repeat(64)}`;
const AMD64_ATTESTATION = `sha256:${"d".repeat(64)}`;
const ARM64_ATTESTATION = `sha256:${"e".repeat(64)}`;
const MEDIA_TYPE = OCI_IMAGE_INDEX_MEDIA_TYPE;
const MANIFEST_MEDIA_TYPE = OCI_IMAGE_MANIFEST_MEDIA_TYPE;

function provenanceFor(platform) {
  return {
    SLSA: {
      buildType: "https://mobyproject.org/buildkit@v1",
      builder: { id: "" },
      invocation: {
        parameters: {
          frontend: "dockerfile.v0",
          args: {
            target: "runtime-ui",
            "build-arg:LICO_SOURCE_REPOSITORY": "Acme/LicoMesh",
            "build-arg:LICO_SOURCE_REF": "refs/tags/v1.2.3",
            "build-arg:LICO_SOURCE_COMMIT": COMMIT
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
            source: "https://github.com/Acme/LicoMesh.git"
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

function sbomFor(platform) {
  return {
    SPDX: {
      spdxVersion: "SPDX-2.3",
      SPDXID: "SPDXRef-DOCUMENT",
      dataLicense: "CC0-1.0",
      name: `lico-${platform.replace("/", "-")}`,
      documentNamespace: `https://example.invalid/spdx/${platform.replace("/", "-")}`,
      creationInfo: { creators: ["Tool: buildkit"] },
      packages: [{ SPDXID: "SPDXRef-Package-lico", name: "lico" }],
      relationships: []
    }
  };
}

function fixture() {
  return {
    image: "ghcr.io/acme/licomesh",
    digest: ROOT_DIGEST,
    target: "ghcr.io/acme/licomesh:1.2.3",
    candidate: `ghcr.io/acme/licomesh:candidate-${COMMIT}`,
    reused: false,
    repository: "Acme/LicoMesh",
    sourceRef: "refs/tags/v1.2.3",
    sourceCommit: COMMIT,
    workflowRef: "Acme/LicoMesh/.github/workflows/release.yml@refs/tags/v1.2.3",
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
      RELEASE_IMAGE_PLATFORMS.map((platform) => [platform, provenanceFor(platform)])
    )),
    sbomText: JSON.stringify(Object.fromEntries(
      RELEASE_IMAGE_PLATFORMS.map((platform) => [platform, sbomFor(platform)])
    ))
  };
}

function mutateJson(source, mutate) {
  const value = JSON.parse(source);
  mutate(value);
  return JSON.stringify(value);
}

describe("release image evidence authority", () => {
  it("requires one explicit value for every authority input", () => {
    const args = [
      "--image", "ghcr.io/acme/licomesh",
      "--digest", ROOT_DIGEST,
      "--target", "ghcr.io/acme/licomesh:1.2.3",
      "--candidate", `ghcr.io/acme/licomesh:candidate-${COMMIT}`,
      "--reused", "false",
      "--repository", "Acme/LicoMesh",
      "--source-ref", "refs/tags/v1.2.3",
      "--source-commit", COMMIT,
      "--workflow-ref", "Acme/LicoMesh/.github/workflows/release.yml@refs/tags/v1.2.3",
      "--manifest-descriptor", "descriptor.json",
      "--manifest", "manifest.json",
      "--provenance", "provenance.json",
      "--sbom", "sbom.json",
      "--authority-output", "authority.json",
      "--state-output", "state.json"
    ];
    expect(parseReleaseImageAuthorityArguments(args)).toMatchObject({
      image: "ghcr.io/acme/licomesh",
      digest: ROOT_DIGEST,
      reused: false,
      manifestDescriptor: "descriptor.json",
      authorityOutput: "authority.json"
    });
    expect(() => parseReleaseImageAuthorityArguments([...args, "--unknown", "value"]))
      .toThrow("release_image_argument_invalid");
    expect(() => parseReleaseImageAuthorityArguments([...args, "--image", "duplicate"]))
      .toThrow("release_image_argument_invalid");
  });

  it("binds each release platform, attestation subject, source coordinate, and evidence digest", () => {
    const input = fixture();
    const authority = buildReleaseImageAuthority(input);
    expect(authority).toMatchObject({
      schemaVersion: RELEASE_IMAGE_AUTHORITY_SCHEMA,
      repository: "Acme/LicoMesh",
      sourceCommit: COMMIT,
      sourceRef: "refs/tags/v1.2.3",
      image: "ghcr.io/acme/licomesh",
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

    const authorityText = `${JSON.stringify(authority, null, 2)}\n`;
    const state = buildReleaseImageState({
      authorityText,
      target: input.target,
      candidate: input.candidate,
      reused: input.reused
    });
    expect(state).toMatchObject({
      repository: input.repository,
      sourceCommit: input.sourceCommit,
      digest: input.digest,
      target: input.target,
      candidate: input.candidate,
      reused: false
    });
    expect(state.authoritySha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("rejects commit substrings instead of accepting them as source binding", () => {
    const input = fixture();
    input.provenanceText = mutateJson(input.provenanceText, (provenance) => {
      provenance["linux/amd64"].SLSA.invocation.parameters.args[
        "build-arg:LICO_SOURCE_COMMIT"
      ] = `prefix-${COMMIT}-suffix`;
    });
    expect(() => buildReleaseImageAuthority(input)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_source_mismatch" })
    );
  });

  it("rejects wrong repository and ref values even when the commit is exact", () => {
    const input = fixture();
    input.provenanceText = mutateJson(input.provenanceText, (provenance) => {
      provenance["linux/arm64"].SLSA.invocation.parameters.args[
        "build-arg:LICO_SOURCE_REPOSITORY"
      ] = "Acme/Elsewhere";
      provenance["linux/arm64"].SLSA.invocation.parameters.args[
        "build-arg:LICO_SOURCE_REF"
      ] = "refs/tags/v9.9.9";
    });
    expect(() => buildReleaseImageAuthority(input)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_source_mismatch" })
    );

    const forgedVcs = fixture();
    forgedVcs.provenanceText = mutateJson(forgedVcs.provenanceText, (provenance) => {
      provenance["linux/amd64"].SLSA.metadata[
        "https://mobyproject.org/buildkit@v1#metadata"
      ].vcs.source = "https://github.com/Acme/Elsewhere.git";
    });
    expect(() => buildReleaseImageAuthority(forgedVcs)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_source_mismatch" })
    );
  });

  it("rejects missing platform provenance and empty SBOM placeholders", () => {
    const missingPlatform = fixture();
    missingPlatform.provenanceText = mutateJson(missingPlatform.provenanceText, (provenance) => {
      delete provenance["linux/arm64"];
    });
    expect(() => buildReleaseImageAuthority(missingPlatform)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_platform_set_mismatch" })
    );

    const emptySbom = fixture();
    emptySbom.sbomText = JSON.stringify({
      "linux/amd64": { SPDX: {} },
      "linux/arm64": { SPDX: {} }
    });
    expect(() => buildReleaseImageAuthority(emptySbom)).toThrowError(
      expect.objectContaining({ code: "release_image_sbom_schema_mismatch" })
    );
  });

  it("rejects manifest digest and attestation-subject mismatches", () => {
    const descriptorMismatch = fixture();
    descriptorMismatch.manifestDescriptorText = JSON.stringify({
      digest: `sha256:${"0".repeat(64)}`,
      mediaType: MEDIA_TYPE
    });
    expect(() => buildReleaseImageAuthority(descriptorMismatch)).toThrowError(
      expect.objectContaining({ code: "release_image_manifest_descriptor_mismatch" })
    );

    const subjectMismatch = fixture();
    subjectMismatch.manifestText = mutateJson(subjectMismatch.manifestText, (manifest) => {
      manifest.manifests[2].annotations["vnd.docker.reference.digest"] =
        `sha256:${"1".repeat(64)}`;
    });
    expect(() => buildReleaseImageAuthority(subjectMismatch)).toThrowError(
      expect.objectContaining({ code: "release_image_attestation_subject_mismatch" })
    );
  });

  it("rejects platform and SPDX schema substitutions", () => {
    const wrongPlatform = fixture();
    wrongPlatform.provenanceText = mutateJson(wrongPlatform.provenanceText, (provenance) => {
      provenance["linux/arm64"].SLSA.invocation.environment.platform = "linux/amd64";
    });
    expect(() => buildReleaseImageAuthority(wrongPlatform)).toThrowError(
      expect.objectContaining({ code: "release_image_provenance_schema_mismatch" })
    );

    const wrongSpdx = fixture();
    wrongSpdx.sbomText = mutateJson(wrongSpdx.sbomText, (sbom) => {
      sbom["linux/amd64"].SPDX.spdxVersion = "CycloneDX-1.6";
    });
    expect(() => buildReleaseImageAuthority(wrongSpdx)).toThrowError(
      expect.objectContaining({ code: "release_image_sbom_schema_mismatch" })
    );
  });
});
