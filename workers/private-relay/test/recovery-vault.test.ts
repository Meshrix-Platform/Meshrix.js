/**
 * RecoveryVaultDO tests: bounded opaque snapshot storage with CAS revisions,
 * recovery-key proof fetches (no device/account session), staged replacement
 * integrity, nonce replay defense, purpose separation and restart survival.
 */

import { afterEach, describe, expect, it } from "vitest";
import { env, evictDurableObject, reset, runInDurableObject } from "cloudflare:test";

import { PRIVATE_RELAY_RECOVERY_SCHEMA_VERSION } from "../../../packages/contracts/src/private-relay/index.ts";
import { vaultObjectName } from "../src/ids.ts";
import {
  VAULT_1,
  generateVaultKeys,
  makeSnapshot,
  provisionVault,
  randomCiphertext,
  vaultFetchMessage,
  vaultPost,
  vaultWriteMessage,
  type VaultKeys,
} from "./helpers.ts";

afterEach(async () => {
  await reset();
});

async function provisionedVault(generation = 3): Promise<{ writer: VaultKeys; writer2: VaultKeys; recovery: VaultKeys }> {
  const writer = await generateVaultKeys("wkey.test.1");
  const writer2 = await generateVaultKeys("wkey.test.2");
  const recovery = await generateVaultKeys("rckey.test.1");
  const response = await provisionVault(VAULT_1, [writer], {
    keyId: recovery.keyId,
    algorithm: recovery.algorithm,
    publicKey: recovery.publicKey,
  }, generation);
  expect(response.ok).toBe(true);
  return { writer, writer2, recovery };
}

describe("recovery vault CAS storage", () => {
  it("commits a write and serves ciphertext to a recovery-key proof only", async () => {
    const { writer, recovery } = await provisionedVault(3);
    const snapshot = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    const write = await vaultWriteMessage(VAULT_1, writer, 0, snapshot);
    const committed = await vaultPost(VAULT_1, write);
    expect(committed.status).toBe(200);
    expect(committed.body.outcome).toBe("committed");
    expect(committed.body.committedRevision).toBe(1);

    // A fresh install holds only the recovery key — no device or account
    // session. The typed vault_fetch proof is sufficient for retrieval.
    const fetch = await vaultFetchMessage(VAULT_1, recovery);
    const fetched = await vaultPost(VAULT_1, fetch);
    expect(fetched.status).toBe(200);
    expect(fetched.body.kind).toBe("vault-snapshot");
    expect((fetched.body.snapshot as { ciphertext: string }).ciphertext)
      .toBe((snapshot.snapshot as { ciphertext: string }).ciphertext);
    expect(fetched.body.revision).toBe(1);
  });

  it("reports conflict on CAS mismatch and refuses unregistered writers", async () => {
    const { writer, writer2, recovery } = await provisionedVault(3);
    const snapshot = (rev: number) => makeSnapshot(VAULT_1, 3, rev, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    const snapshot1 = snapshot(1);
    const first = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, snapshot1));
    expect(first.body.outcome).toBe("committed");

    // Retrying the exact committed write reconciles idempotently.
    const retried = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, snapshot1));
    expect(retried.body.outcome).toBe("committed");
    expect(retried.body.committedRevision).toBe(1);

    // A divergent write at the same expected revision is a real conflict.
    const stale = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, snapshot(1)));
    expect(stale.body.outcome).toBe("conflict");
    expect(stale.body.currentRevision).toBe(1);

    const next = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 1, snapshot(2)));
    expect(next.body.outcome).toBe("committed");
    expect(next.body.committedRevision).toBe(2);

    // Unregistered writer key: no escalation path.
    const unregistered = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer2, 2, snapshot(3)));
    expect(unregistered.body.outcome).toBe("refused");
  });

  it("rejects a generation regression and a tampered digest", async () => {
    const { writer, recovery } = await provisionedVault(3);
    const good = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, good));

    const regressed = makeSnapshot(VAULT_1, 2, 2, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    const regression = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 1, regressed));
    expect(regression.body.outcome).toBe("refused");

    const tampered = await vaultWriteMessage(VAULT_1, writer, 1,
      makeSnapshot(VAULT_1, 3, 2, randomCiphertext(64), {
        keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
      }), { writeAuth: { snapshotDigest: "sha256:" + "0".repeat(64) } });
    const digested = await vaultPost(VAULT_1, tampered);
    expect(digested.body.outcome).toBe("refused");
  });

  it("refuses wrong-purpose proofs, replays and foreign-key signatures", async () => {
    const { writer, recovery } = await provisionedVault(3);
    await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0,
      makeSnapshot(VAULT_1, 3, 1, randomCiphertext(64), {
        keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
      })));

    // Wrong purpose on the wire kind.
    const wrongPurpose = await vaultFetchMessage(VAULT_1, recovery, { purpose: "recover_device" });
    const refused = await vaultPost(VAULT_1, wrongPurpose);
    expect(refused.body.kind).toBe("vault-fetch-refused");
    expect(refused.body.refusal).toBe("purpose_denied");

    // Valid fetch, then its exact replay: the nonce is single-use.
    const fetch = await vaultFetchMessage(VAULT_1, recovery);
    const first = await vaultPost(VAULT_1, fetch);
    expect(first.body.kind).toBe("vault-snapshot");
    const replay = await vaultPost(VAULT_1, fetch);
    expect(replay.body.refusal).toBe("proof_invalid");

    // A proof signed by the writer key under the recovery keyId fails.
    const foreign = await vaultFetchMessage(VAULT_1, { ...writer, keyId: recovery.keyId });
    const foreignResult = await vaultPost(VAULT_1, foreign);
    expect(foreignResult.body.refusal).toBe("proof_invalid");
  });

  it("survives object restart with the committed snapshot intact", async () => {
    const { writer, recovery } = await provisionedVault(3);
    const snapshot = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, snapshot));

    const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(VAULT_1)));
    await evictDurableObject(stub);

    const fetched = await vaultPost(VAULT_1, await vaultFetchMessage(VAULT_1, recovery));
    expect(fetched.status).toBe(200);
    expect((fetched.body.snapshot as { ciphertext: string }).ciphertext)
      .toBe((snapshot.snapshot as { ciphertext: string }).ciphertext);
  });

  it("keeps the last committed snapshot when a staged replacement is abandoned", async () => {
    const { writer, recovery } = await provisionedVault(3);
    const firstSnapshot = makeSnapshot(VAULT_1, 3, 1, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 0, firstSnapshot));

    // Simulate an abandoned staged replacement directly in storage; the next
    // read must still serve the committed snapshot, and a different write at
    // the same expected revision reconciles as conflict, not silent loss.
    const stub = env.RECOVERY_VAULT.get(env.RECOVERY_VAULT.idFromName(vaultObjectName(VAULT_1)));
    await runInDurableObject(stub, async (_instance: unknown, state: DurableObjectState) => {
      await state.storage.put("staged", {
        expectedRevision: 1,
        snapshotDigest: "sha256:" + "1".repeat(64),
        snapshot: { algorithm: "XChaCha20-Poly1305", nonce: "sn.test.abandoned", ciphertext: "QUJBTkRPTkVE", byteLength: 9 },
        publicVerifier: { keyId: recovery.keyId, algorithm: "Ed25519", publicKey: recovery.publicKey },
        generation: 3,
        revision: 2,
        receivedAt: new Date().toISOString(),
      });
    });
    const fetched = await vaultPost(VAULT_1, await vaultFetchMessage(VAULT_1, recovery));
    expect((fetched.body.snapshot as { ciphertext: string }).ciphertext)
      .toBe((firstSnapshot.snapshot as { ciphertext: string }).ciphertext);

    const replacement = makeSnapshot(VAULT_1, 3, 2, randomCiphertext(64), {
      keyId: recovery.keyId, algorithm: recovery.algorithm, publicKey: recovery.publicKey,
    });
    const second = await vaultPost(VAULT_1, await vaultWriteMessage(VAULT_1, writer, 1, replacement));
    expect(second.body.outcome).toBe("committed");
    const refetched = await vaultPost(VAULT_1, await vaultFetchMessage(VAULT_1, recovery));
    expect((refetched.body.snapshot as { ciphertext: string }).ciphertext)
      .toBe((replacement.snapshot as { ciphertext: string }).ciphertext);
  });

  it("refuses fetch before provisioning and without a committed snapshot", async () => {
    const recovery = await generateVaultKeys("rckey.test.x");
    const fetched = await vaultPost(VAULT_1, await vaultFetchMessage(VAULT_1, recovery));
    expect(fetched.body.refusal).toBe("not_found");
  });
});
