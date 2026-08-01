import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertEvidencePolicyReadiness,
  evaluateEvidencePolicyReadiness
} from "../../../tools/server-scripts/lib/operation-proof-evidence-policy.ts";
import {
  createMeshrixSigner,
  createMeshrixSignerKeyRing,
  createOperationProofSubstrate
} from "../../../packages/foundation/src/proof/proof-substrate/index.ts";

describe("operation proof evidence policy readiness", () : any => {
  it("signs with the active generation and verifies retained historical generations", async () : Promise<any> => {
    const previous: any = createMeshrixSigner({
      signerId: "proof-generation-1",
      secret: "fixture-proof-generation-1"
    });
    const active: any = createMeshrixSigner({
      signerId: "proof-generation-2",
      secret: "fixture-proof-generation-2"
    });
    const historicalSignature: any = await previous.sign("historical-envelope");
    const ring: any = createMeshrixSignerKeyRing({
      active,
      verification: [previous]
    });
    try {
      expect(await ring.sign("current-envelope")).toMatch(/^hmac-sha256:/u);
      expect(await ring.verifyFor({
        signerId: "proof-generation-1",
        algorithm: "hmac-sha256",
        message: "historical-envelope",
        signature: historicalSignature
      })).toBe(true);
      expect(await ring.verifyFor({
        signerId: "proof-generation-unknown",
        algorithm: "hmac-sha256",
        message: "historical-envelope",
        signature: historicalSignature
      })).toBe(false);
    } finally {
      ring.close();
    }
  });

  it("fails when production policy is declared without a signer", () : any => {
    const result: any = evaluateEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: ""
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE/);
    expect(() : any => assertEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: ""
    })).toThrow(/MESHRIX_OPERATION_PROOF_SIGNER_SECRET_FILE/);
  });

  it("passes when production policy and signer are consistent", () : any => {
    const result: any = evaluateEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: "fixture-signer-not-a-real-secret"
    });
    expect(result.ok).toBe(true);
    expect(() : any => assertEvidencePolicyReadiness({
      evidencePolicy: "production",
      signerSecret: "fixture-signer-not-a-real-secret"
    })).not.toThrow();
  });

  it("passes for development policy without a signer", () : any => {
    expect(evaluateEvidencePolicyReadiness({
      evidencePolicy: "development",
      signerSecret: ""
    }).ok).toBe(true);
  });

  it("passes when policy is undeclared", () : any => {
    expect(evaluateEvidencePolicyReadiness({
      evidencePolicy: "",
      signerSecret: ""
    }).ok).toBe(true);
  });

  it("rejects unknown policy values", () : any => {
    const result: any = evaluateEvidencePolicyReadiness({
      evidencePolicy: "staging",
      signerSecret: "x"
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/development.*production/);
  });

  it("fails before opening the proof runtime when production signing is unavailable", () : any => {
    expect(() : any => createOperationProofSubstrate({
      dataDir: path.join(os.tmpdir(), "meshrix-proof-preflight-unused"),
      evidencePolicy: "production",
      signer: false
    })).toThrowError(expect.objectContaining({
      code: "operation_proof_signer_required"
    }));
  });

  it("loads a production signer from external file custody and rejects in-data custody", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-proof-signer-custody-"));
    const dataDir: any = path.join(root, "data");
    const externalSecretFile: any = path.join(root, "proof-signer");
    await fs.mkdir(dataDir);
    await fs.writeFile(externalSecretFile, `${"a".repeat(64)}\n`, { mode: 0o600 });
    let substrate: any = null;
    try {
      substrate = createOperationProofSubstrate({
        dataDir,
        runtimeOptions: {
          operationProof: {
            evidencePolicy: "production",
            signerSecretFile: externalSecretFile
          }
        }
      });
      expect(substrate.health()).toMatchObject({
        ok: true,
        evidencePolicy: "production",
        productionVerifiable: true,
        signingConfigured: true
      });
      await substrate.close();
      substrate = null;

      const inDataSecretFile: any = path.join(dataDir, "proof-signer");
      await fs.writeFile(inDataSecretFile, "b".repeat(64), { mode: 0o600 });
      expect(() : any => createOperationProofSubstrate({
        dataDir,
        runtimeOptions: {
          operationProof: {
            evidencePolicy: "production",
            signerSecretFile: inDataSecretFile
          }
        }
      })).toThrowError(expect.objectContaining({
        code: "operation_proof_signer_custody_invalid"
      }));
    } finally {
      await substrate?.close?.();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
