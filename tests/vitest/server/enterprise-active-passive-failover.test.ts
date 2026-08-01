import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFinalProtectedSinkAttempt
} from "#meshrix/foundation/security/final-protected-sink-permit";
import {
  createActivePassiveBackupReplicaStore
} from "#meshrix/foundation/storage/active-passive-backup-replica";
import {
  createEnterpriseActivePassiveRuntime,
  validateEnterpriseAvailabilityProfile
} from "#meshrix/server-runtime/composition/enterprise-active-passive-runtime";

const cleanupRoots: any[] = [];
const ONE_SECOND: any = 1_000;
const WRITER_TTL_MS: any = 3 * ONE_SECOND;
const CUSTODY_GENERATION_A: any = "fixture-custody-generation-a";
const CUSTODY_GENERATION_B: any = "fixture-custody-generation-b";
const PRIVATE_INSTANCE_A: any = "private-instance-alpha";
const PRIVATE_INSTANCE_B: any = "private-instance-bravo";
const PRIVATE_IDEMPOTENCY: any = "private-idempotency-value";
const PRIVATE_EFFECT_PAYLOAD: any = "private-effect-payload";

const ACTIVE_PASSIVE_PROFILE: Readonly<Record<string, any>> = Object.freeze({
  deploymentProfile: "enterprise-active-passive-container",
  runtimeKind: "container",
  standbyMode: "warm",
  writerLeaseTtlMs: WRITER_TTL_MS,
  writerRenewIntervalMs: ONE_SECOND,
  drainTimeoutMs: 10 * ONE_SECOND,
  upstreams: Object.freeze([
    Object.freeze({
      candidateDigest: `sha256:${"a".repeat(64)}`,
      upstreamId: "meshrix-active-passive-a"
    }),
    Object.freeze({
      candidateDigest: `sha256:${"b".repeat(64)}`,
      upstreamId: "meshrix-active-passive-b"
    })
  ]),
  supportClaims: Object.freeze({
    activeActive: false,
    hotStandby: false,
    zeroRpo: false,
    zeroDowntime: false
  })
});

const SUBJECT: Readonly<Record<string, any>> = Object.freeze({
  generation: "17",
  subjectId: "fixture-active-passive-subject",
  tenantId: "fixture-active-passive-tenant",
  type: "workload"
});

const AUTHORITY_CONTEXT: Readonly<Record<string, any>> = Object.freeze({
  approvalRevision: "23",
  grantRevision: "31",
  policyRevision: "47",
  riskRevision: "11",
  workloadGeneration: SUBJECT.generation
});

function digest(value?: any) : any {
  return createHash("sha256").update(String(value)).digest("hex");
}

function codedError(code?: any) : any {
  return Object.assign(new Error(code), { code });
}

async function tempRoot(label?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), label));
  cleanupRoots.push(root);
  return root;
}

afterEach(async () : Promise<any> => {
  await Promise.all(
    cleanupRoots.splice(0).map((root?: any) : any =>
      fs.rm(root, { recursive: true, force: true })
    )
  );
});

class ManualClock {
  nextTimerId: any;
  timers: any;
  value: any;
  constructor(start: any = 2_000_000_000_000) {
    this.value = start;
    this.nextTimerId = 1;
    this.timers = new Map<any, any>();
  }

  now = () : any => this.value;

  setTimeout = (callback?: any, delayMs?: any) : any => {
    const id: any = this.nextTimerId++;
    this.timers.set(id, {
      callback,
      at: this.value + Math.max(0, Number(delayMs) || 0)
    });
    return id;
  };

  clearTimeout = (id?: any) : any => {
    this.timers.delete(id);
  };

  async advance(milliseconds?: any) : Promise<any> {
    this.value += Number(milliseconds);
    while (true) {
      const next: any = [...this.timers.entries()]
        .filter(([, timer]: any[]) : any => timer.at <= this.value)
        .sort((left?: any, right?: any) : any =>
          left[1].at - right[1].at || left[0] - right[0]
        )[0];
      if (!next) return;
      this.timers.delete(next[0]);
      await next[1].callback();
    }
  }
}

function createFixedCountUpstream() : any {
  const counts: any = new Map<any, any>();
  const blockedEpochs: any = new Set<any>();
  let held: any = null;

  return {
    count(effectId?: any) : any {
      return counts.get(effectId) || 0;
    },
    total() : any {
      return [...counts.values()].reduce((sum?: any, value?: any) : any => sum + value, 0);
    },
    fenceEpoch(epoch?: any) : any {
      blockedEpochs.add(Number(epoch));
    },
    holdNext() : any {
      let release: any;
      let entered: any;
      const wait: any = new Promise((resolve?: any) : any => {
        release = resolve;
      });
      const enteredPromise: any = new Promise((resolve?: any) : any => {
        entered = resolve;
      });
      held = { wait, release, entered };
      return Object.freeze({
        entered: enteredPromise,
        release
      });
    },
    async invoke({ effectId, writerEpoch }: Record<string, any>) : Promise<any> {
      if (blockedEpochs.has(Number(writerEpoch))) {
        throw codedError("fixed_upstream_writer_epoch_fenced");
      }
      counts.set(effectId, (counts.get(effectId) || 0) + 1);
      const selected: any = held;
      held = null;
      selected?.entered();
      await selected?.wait;
      return Object.freeze({
        outcomeDigest: digest(`fixed-outcome:${effectId}`)
      });
    }
  };
}

function createAtomicWriterFencePort({ clock, fixedUpstream }: Record<string, any>) : any {
  const leaseStates: any = new WeakMap<object, any>();
  const handoffStates: any = new WeakMap<object, any>();
  const hardFenceStates: any = new WeakMap<object, any>();
  const partitionedCandidates: any = new Set<any>();
  const calls: any[] = [];
  let epoch: any = 0;
  let holderDigest: any = "";
  let currentLease: any = null;
  let expiresAt: any = 0;
  let lastReleaseEpoch: any = 0;
  let acquisitionMode: any = "initial";

  function assertCandidateDigest(candidateDigest?: any) : any {
    if (!/^[a-f0-9]{64}$/u.test(String(candidateDigest || ""))) {
      throw codedError("writer_fence_candidate_invalid");
    }
  }

  function stateForLease(lease?: any) : any {
    const state: any = leaseStates.get(lease);
    if (!state) throw codedError("writer_fence_lease_invalid");
    return state;
  }

  function assertReachable(candidateDigest?: any) : any {
    if (partitionedCandidates.has(candidateDigest)) {
      calls.push("fence_unavailable");
      throw codedError("writer_fence_unavailable");
    }
  }

  const port: Readonly<Record<string, any>> = Object.freeze({
    async acquire({
      candidateDigest,
      ttlMs,
      handoffReceipt = null,
      hardFenceProof = null
    }: Record<string, any> = {}) : Promise<any> {
      assertCandidateDigest(candidateDigest);
      assertReachable(candidateDigest);
      calls.push("acquire_attempt");
      const now: any = clock.now();
      if (currentLease && now < expiresAt) {
        calls.push("acquire_contended");
        return Object.freeze({ acquired: false, reasonCode: "writer_fence_held" });
      }
      if (epoch > 0) {
        if (holderDigest && now >= expiresAt) {
          const proof: any = hardFenceStates.get(hardFenceProof);
          if (
            !proof ||
            proof.priorEpoch !== epoch ||
            proof.priorHolderDigest !== holderDigest
          ) {
            calls.push("hard_fence_required");
            throw codedError("writer_hard_fence_required");
          }
          acquisitionMode = "hard-fence";
        } else {
          const handoff: any = handoffStates.get(handoffReceipt);
          if (!handoff || handoff.priorEpoch !== lastReleaseEpoch) {
            calls.push("handoff_required");
            throw codedError("writer_handoff_required");
          }
          acquisitionMode = "planned-handoff";
        }
      }
      epoch += 1;
      holderDigest = candidateDigest;
      expiresAt = now + Number(ttlMs);
      const lease: any = Object.freeze(Object.create(null));
      leaseStates.set(lease, {
        candidateDigest,
        epoch
      });
      currentLease = lease;
      calls.push("acquire_success");
      return Object.freeze({
        acquired: true,
        epoch,
        lease
      });
    },

    async renew({ lease, ttlMs }: Record<string, any> = {}) : Promise<any> {
      const state: any = stateForLease(lease);
      assertReachable(state.candidateDigest);
      calls.push("renew");
      if (
        lease !== currentLease ||
        state.epoch !== epoch ||
        state.candidateDigest !== holderDigest ||
        clock.now() >= expiresAt
      ) {
        throw codedError("writer_fence_not_current");
      }
      expiresAt = clock.now() + Number(ttlMs);
      return Object.freeze({ current: true, epoch, lease });
    },

    async verifyCurrent({ lease }: Record<string, any> = {}) : Promise<any> {
      const state: any = stateForLease(lease);
      assertReachable(state.candidateDigest);
      calls.push("verify");
      if (
        lease !== currentLease ||
        state.epoch !== epoch ||
        state.candidateDigest !== holderDigest ||
        clock.now() >= expiresAt
      ) {
        throw codedError("writer_fence_not_current");
      }
      return Object.freeze({ current: true, epoch, lease });
    },

    async release({ lease }: Record<string, any> = {}) : Promise<any> {
      const state: any = stateForLease(lease);
      assertReachable(state.candidateDigest);
      calls.push("release");
      if (
        lease !== currentLease ||
        state.epoch !== epoch ||
        state.candidateDigest !== holderDigest
      ) {
        throw codedError("writer_fence_not_current");
      }
      const handoffReceipt: any = Object.freeze(Object.create(null));
      handoffStates.set(handoffReceipt, { priorEpoch: epoch });
      lastReleaseEpoch = epoch;
      holderDigest = "";
      currentLease = null;
      expiresAt = clock.now();
      return Object.freeze({ released: true, priorEpoch: epoch, handoffReceipt });
    },

    async verifyHardFence({ proof, priorEpoch }: Record<string, any> = {}) : Promise<any> {
      const state: any = hardFenceStates.get(proof);
      if (!state || state.priorEpoch !== Number(priorEpoch)) {
        throw codedError("writer_hard_fence_invalid");
      }
      return Object.freeze({ verified: true, priorEpoch: state.priorEpoch });
    }
  });

  return {
    port,
    calls,
    currentEpoch: () : any => epoch,
    lastAcquisitionMode: () : any => acquisitionMode,
    partitionCurrent() : any {
      if (holderDigest) partitionedCandidates.add(holderDigest);
    },
    healAll() : any {
      partitionedCandidates.clear();
    },
    issueHardFence() : any {
      if (!holderDigest || clock.now() < expiresAt) {
        throw codedError("writer_hard_fence_not_permitted");
      }
      const proof: any = Object.freeze(Object.create(null));
      hardFenceStates.set(proof, {
        priorEpoch: epoch,
        priorHolderDigest: holderDigest
      });
      fixedUpstream.fenceEpoch(epoch);
      calls.push("hard_fence_verified");
      return proof;
    }
  };
}

function createAtomicEffectWitness() : any {
  const records: any = new Map<any, any>();
  const witnessStates: any = new WeakMap<object, any>();
  const calls: any[] = [];
  let prepareAvailable: any = true;
  let settleAvailable: any = true;
  let failNextSettlement: any = false;

  function assertDigest(value?: any) : any {
    if (!/^[a-f0-9]{64}$/u.test(String(value || ""))) {
      throw codedError("active_passive_effect_witness_input_invalid");
    }
  }

  return {
    port: Object.freeze({
      async status() : Promise<any> {
        return Object.freeze({
          ready: prepareAvailable && settleAvailable
        });
      },

      async prepare({
        idempotencyDigest,
        effectDigest,
        writerEpoch
      }: Record<string, any> = {}) : Promise<any> {
        calls.push("prepare");
        if (!prepareAvailable) {
          throw codedError("active_passive_effect_witness_unavailable");
        }
        assertDigest(idempotencyDigest);
        assertDigest(effectDigest);
        if (!Number.isSafeInteger(writerEpoch) || writerEpoch < 1) {
          throw codedError("active_passive_effect_witness_input_invalid");
        }
        const key: any = `${idempotencyDigest}:${effectDigest}`;
        const existing: any = records.get(key);
        if (existing) {
          if (
            existing.writerEpoch > writerEpoch ||
            existing.state === "prepared" ||
            existing.state === "in_doubt"
          ) {
            existing.state = "in_doubt";
            return Object.freeze({ state: "in_doubt" });
          }
          return Object.freeze({
            state: existing.state,
            outcomeDigest: existing.outcomeDigest
          });
        }
        const witnessRef: any = Object.freeze(Object.create(null));
        const record: Record<string, any> = {
          effectDigest,
          idempotencyDigest,
          outcomeDigest: "",
          state: "prepared",
          writerEpoch
        };
        records.set(key, record);
        witnessStates.set(witnessRef, record);
        return Object.freeze({ state: "prepared", witnessRef });
      },

      async settle({ witnessRef, outcomeDigest, writerEpoch }: Record<string, any> = {}) : Promise<any> {
        calls.push("settle");
        const record: any = witnessStates.get(witnessRef);
        if (!record) {
          throw codedError("active_passive_effect_witness_invalid");
        }
        if (!settleAvailable || failNextSettlement) {
          failNextSettlement = false;
          record.state = "in_doubt";
          throw codedError("active_passive_effect_witness_unavailable");
        }
        assertDigest(outcomeDigest);
        if (record.writerEpoch !== Number(writerEpoch)) {
          record.state = "in_doubt";
          throw codedError("active_passive_effect_witness_epoch_mismatch");
        }
        record.state = "settled";
        record.outcomeDigest = outcomeDigest;
        return Object.freeze({ state: "settled", outcomeDigest });
      }
    }),
    calls,
    records,
    setPrepareAvailable(value?: any) : any {
      prepareAvailable = value;
    },
    setSettleAvailable(value?: any) : any {
      settleAvailable = value;
    },
    failNextSettle() : any {
      failNextSettlement = true;
    }
  };
}

function createNodeLifecyclePorts({
  custodyGeneration = CUSTODY_GENERATION_A,
  transitionEvents
}: Record<string, any> = {}) : any {
  const flags: Record<string, any> = {
    restoreReady: true,
    storageReady: true,
    queueReady: true,
    custodyReady: true
  };
  let queueAdmissionOpen: any = true;
  let heldQueueRelease: any = null;
  let heldQueuePromise: any = null;
  let storageOpenCount: any = 0;
  let storageCloseCount: any = 0;
  let custodyCloseCount: any = 0;

  return {
    flags,
    restoreReadinessPort: Object.freeze({
      async status() : Promise<any> {
        return Object.freeze({ ready: flags.restoreReady });
      },
      async markRestored() : Promise<any> {
        flags.restoreReady = true;
      }
    }),
    storageLifecyclePort: Object.freeze({
      async status() : Promise<any> {
        return Object.freeze({ ready: flags.storageReady });
      },
      async openAfterRestore() : Promise<any> {
        flags.storageReady = true;
        storageOpenCount += 1;
      },
      async close() : Promise<any> {
        flags.storageReady = false;
        storageCloseCount += 1;
        transitionEvents.push("storage_closed");
      }
    }),
    queueLifecyclePort: Object.freeze({
      async status() : Promise<any> {
        return Object.freeze({ recovered: flags.queueReady });
      },
      async closeAdmission() : Promise<any> {
        queueAdmissionOpen = false;
        transitionEvents.push("queue_admission_closed");
      },
      async drain() : Promise<any> {
        await heldQueuePromise;
        transitionEvents.push("queue_drained");
        return Object.freeze({ drained: true });
      }
    }),
    custodyLifecyclePort: Object.freeze({
      async status() : Promise<any> {
        return Object.freeze({
          ready: flags.custodyReady,
          generation: custodyGeneration
        });
      },
      async close() : Promise<any> {
        flags.custodyReady = false;
        custodyCloseCount += 1;
        transitionEvents.push("custody_closed");
      }
    }),
    holdQueueItem() : any {
      if (!queueAdmissionOpen) throw codedError("queue_admission_closed");
      heldQueuePromise = new Promise((resolve?: any) : any => {
        heldQueueRelease = resolve;
      });
    },
    releaseQueueItem() : any {
      heldQueueRelease?.();
      heldQueueRelease = null;
      heldQueuePromise = null;
    },
    setCustodyGeneration(value?: any) : any {
      custodyGeneration = value;
    },
    counters() : any {
      return {
        custodyCloseCount,
        storageCloseCount,
        storageOpenCount
      };
    }
  };
}

function finalAttempt({
  node,
  clock,
  idempotencyKey,
  effectKind = "upstream-network"
}: Record<string, any>) : any {
  const targetSelector: Readonly<Record<string, any>> = Object.freeze({
    serviceId: "fixed-count-upstream",
    effectKind
  });
  const effect: Readonly<Record<string, any>> = Object.freeze({
    kind: effectKind,
    targetDigest: digest(`target:${effectKind}`)
  });
  const resourceRevision: any = "fixture-resource-revision";
  const requestDigest: any = digest(`request:${idempotencyKey}:${effectKind}`);
  const unboundAttempt: any = createFinalProtectedSinkAttempt({
    audience: "fixture-active-passive-final-sink",
    subject: SUBJECT,
    operationId: `fixture.active-passive.${effectKind}`,
    requestDigest,
    context: AUTHORITY_CONTEXT,
    targetSelector,
    proofRef: `proof:${digest(idempotencyKey)}`,
    authorization: {
      grantRevision: AUTHORITY_CONTEXT.grantRevision,
      policyRevision: AUTHORITY_CONTEXT.policyRevision
    },
    approval: {
      approvalRevision: AUTHORITY_CONTEXT.approvalRevision
    },
    risk: {
      riskRevision: AUTHORITY_CONTEXT.riskRevision
    },
    now: clock.now,
    revalidateCurrentAuthority: async ({ binding }: Record<string, any>) : Promise<any> => Object.freeze({
      allowed: true,
      revoked: false,
      subject: binding.subject,
      context: Object.freeze({
        approvalRevision: binding.context.approvalRevision,
        grantRevision: binding.context.grantRevision,
        policyRevision: binding.context.policyRevision,
        riskRevision: binding.context.riskRevision,
        workloadGeneration: binding.context.workloadGeneration
      })
    })
  });
  const attempt: any = node.runtime.bindFinalProtectedSinkAttempt(unboundAttempt);
  return {
    attempt,
    targetSelector,
    effect,
    resourceRevision,
    resolveCurrentResource: async () : Promise<any> => Object.freeze({
      effect,
      resourceRevision
    })
  };
}

function createNeutralLoadBalancer(nodes?: any) : any {
  let selectedCount: any = 0;
  return {
    selectedCount: () : any => selectedCount,
    async select() : Promise<any> {
      for (const node of nodes) {
        const readiness: any = await node.runtime.probe("/api/readyz");
        if (readiness.statusCode === 200 && readiness.body.ready === true) {
          selectedCount += 1;
          return node;
        }
      }
      throw codedError("active_passive_no_ready_writer");
    },
    async invoke(effect?: any) : Promise<any> {
      return effect(await this.select());
    }
  };
}

async function createCluster({
  custodyGenerationA = CUSTODY_GENERATION_A,
  custodyGenerationB = CUSTODY_GENERATION_A,
  replicaFault = null
}: Record<string, any> = {}) : Promise<any> {
  const clock: any = new ManualClock();
  const fixedUpstream: any = createFixedCountUpstream();
  const fence: any = createAtomicWriterFencePort({ clock, fixedUpstream });
  const witness: any = createAtomicEffectWitness();
  const replicaRoot: any = await tempRoot("meshrix-active-passive-replica-");
  const replicaFaultState: Record<string, any> = { stage: replicaFault };
  const replicaStore: any = createActivePassiveBackupReplicaStore({
    replicaRoot,
    faultInjector(stage?: any) : any {
      if (replicaFaultState.stage === stage) {
        throw codedError("fixture_replica_publication_fault");
      }
    }
  });

  async function createNode(instanceRef?: any, custodyGeneration?: any) : Promise<any> {
    const userDataPath: any = await tempRoot("meshrix-active-passive-node-");
    const transitionEvents: any[] = [];
    const lifecycle: any = createNodeLifecyclePorts({
      custodyGeneration,
      transitionEvents
    });
    const runtime: any = createEnterpriseActivePassiveRuntime({
      profile: ACTIVE_PASSIVE_PROFILE,
      instanceRef,
      userDataPath,
      writerFencePort: fence.port,
      effectWitnessPort: witness.port,
      backupReplicaPort: replicaStore,
      restoreReadinessPort: lifecycle.restoreReadinessPort,
      storageLifecyclePort: lifecycle.storageLifecyclePort,
      queueLifecyclePort: lifecycle.queueLifecyclePort,
      custodyLifecyclePort: lifecycle.custodyLifecyclePort,
      clock: Object.freeze({
        now: clock.now,
        setTimeout: clock.setTimeout,
        clearTimeout: clock.clearTimeout
      }),
      onTransition(event?: any) : any {
        transitionEvents.push(event.code);
      }
    });
    return {
      instanceRef,
      userDataPath,
      transitionEvents,
      lifecycle,
      runtime
    };
  }

  const nodes: any[] = [
    await createNode(PRIVATE_INSTANCE_A, custodyGenerationA),
    await createNode(PRIVATE_INSTANCE_B, custodyGenerationB)
  ];
  const loadBalancer: any = createNeutralLoadBalancer(nodes);
  return {
    clock,
    fence,
    fixedUpstream,
    loadBalancer,
    nodes,
    replicaFaultState,
    replicaRoot,
    replicaStore,
    witness,
    createNode
  };
}

async function startCluster(cluster?: any) : Promise<any> {
  await Promise.all(cluster.nodes.map((node?: any) : any => node.runtime.start()));
  const probes: any = await Promise.all(cluster.nodes.map(async (node?: any) : Promise<any> => ({
    node,
    health: await node.runtime.probe("/api/healthz"),
    readiness: await node.runtime.probe("/api/readyz")
  })));
  const writer: any = probes.find((probe?: any) : any => probe.readiness.statusCode === 200)?.node;
  const standby: any = probes.find((probe?: any) : any => probe.readiness.statusCode === 503)?.node;
  if (!writer || !standby) throw new Error("Expected one writer and one standby.");
  return { writer, standby, probes };
}

async function runEffect({
  node,
  clock,
  fixedUpstream,
  idempotencyKey,
  effectId,
  effectKind = "upstream-network"
}: Record<string, any>) : Promise<any> {
  return node.runtime.runFinalProtectedEffect({
    ...finalAttempt({ node, clock, idempotencyKey, effectKind }),
    idempotencyKey,
    perform: ({ writerEpoch }: Record<string, any>) : any =>
      fixedUpstream.invoke({ effectId, writerEpoch })
  });
}

function expectCodedThrow(action?: any, code?: any) : any {
  expect(action).toThrow(expect.objectContaining({ code }));
}

function expectPrivateMarkersAbsent(value?: any, markers: any = []) : any {
  const serialized: any = JSON.stringify(value);
  for (const marker of [
    PRIVATE_INSTANCE_A,
    PRIVATE_INSTANCE_B,
    PRIVATE_IDEMPOTENCY,
    PRIVATE_EFFECT_PAYLOAD,
    CUSTODY_GENERATION_A,
    CUSTODY_GENERATION_B,
    ...markers
  ]) {
    expect(serialized).not.toContain(marker);
  }
}

function expectOrderedSubsequence(actual?: any, expected?: any) : any {
  let cursor: any = -1;
  for (const item of expected) {
    cursor = actual.indexOf(item, cursor + 1);
    expect(cursor, `missing ordered transition ${item}`).toBeGreaterThanOrEqual(0);
  }
}

async function writeOrdinaryState(root?: any, value?: any) : Promise<any> {
  const stateDir: any = path.join(root, "state");
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(
    path.join(stateDir, "ordinary.json"),
    JSON.stringify({ value }),
    { mode: 0o600 }
  );
}

async function readOrdinaryState(root?: any) : Promise<any> {
  return JSON.parse(
    await fs.readFile(path.join(root, "state", "ordinary.json"), "utf8")
  ).value;
}

async function findReplicaPayloadFile(replicaRoot?: any, replicaId?: any) : Promise<any> {
  async function walk(current?: any) : Promise<any> {
    const entries: any = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const selectedPath: any = path.join(current, entry.name);
      if (entry.isDirectory()) {
        const found: any = await walk(selectedPath);
        if (found) return found;
      } else if (
        entry.isFile() &&
        selectedPath.includes(replicaId) &&
        !entry.name.includes("manifest") &&
        !entry.name.includes("receipt")
      ) {
        return selectedPath;
      }
    }
    return "";
  }
  return walk(replicaRoot);
}

describe("enterprise container active-passive failover", () : any => {
  it("accepts one container-only cold/warm single-writer profile and atomically elects exactly one writer", async () : Promise<any> => {
    expect(validateEnterpriseAvailabilityProfile(ACTIVE_PASSIVE_PROFILE))
      .toMatchObject({
        deploymentProfile: "enterprise-active-passive-container",
        runtimeKind: "container",
        standbyMode: "warm",
        upstreamCount: 2,
        supportClaims: {
          activeActive: false,
          hotStandby: false,
          zeroRpo: false,
          zeroDowntime: false
        }
      });

    expectCodedThrow(() : any => validateEnterpriseAvailabilityProfile({
      deploymentProfile: "enterprise-single-node",
      runtimeKind: "container",
      upstreams: ACTIVE_PASSIVE_PROFILE.upstreams
    }), "enterprise_single_node_upstream_count_invalid");
    for (const invalid of [
      { runtimeKind: "native" },
      { standbyMode: "hot" },
      { supportClaims: { ...ACTIVE_PASSIVE_PROFILE.supportClaims, activeActive: true } },
      { supportClaims: { ...ACTIVE_PASSIVE_PROFILE.supportClaims, zeroRpo: true } },
      { guaranteeRpoMs: 0 },
      { guaranteeRtoMs: 1 }
    ]) {
      expectCodedThrow(() : any => validateEnterpriseAvailabilityProfile({
        ...ACTIVE_PASSIVE_PROFILE,
        ...invalid
      }), "enterprise_active_passive_profile_invalid");
    }

    const cluster: any = await createCluster();
    const { probes } = await startCluster(cluster);

    expect(probes.map((probe?: any) : any => probe.health.statusCode)).toEqual([200, 200]);
    expect(probes.map((probe?: any) : any => probe.readiness.statusCode).sort()).toEqual([200, 503]);
    expect(cluster.fence.calls.filter((call?: any) : any => call === "acquire_success")).toHaveLength(1);
    expect(cluster.fence.currentEpoch()).toBe(1);
    expect((await cluster.loadBalancer.select()).runtime).toBe(
      probes.find((probe?: any) : any => probe.readiness.statusCode === 200).node.runtime
    );
    expect(cluster.fixedUpstream.total()).toBe(0);
    for (const probe of probes) {
      expectPrivateMarkersAbsent(probe);
    }
  });

  it("keeps liveness separate and requires every current recovery fact for readiness and LB admission", async () : Promise<any> => {
    const cluster: any = await createCluster();
    const { writer } = await startCluster(cluster);
    const factors: any[] = [
      ["restoreReady", "active_passive_restore_not_ready"],
      ["storageReady", "active_passive_storage_not_ready"],
      ["queueReady", "active_passive_queue_not_ready"],
      ["custodyReady", "active_passive_custody_not_ready"]
    ];

    for (const [flag, reasonCode] of factors) {
      writer.lifecycle.flags[flag] = false;
      await writer.runtime.refreshReadiness();
      expect(await writer.runtime.probe("/api/healthz")).toEqual({
        statusCode: 200,
        body: { ok: true, status: "live" }
      });
      expect(await writer.runtime.probe("/api/readyz")).toEqual({
        statusCode: 503,
        body: {
          ok: false,
          ready: false,
          role: "writer",
          reasonCode
        }
      });
      await expect(cluster.loadBalancer.select()).rejects.toMatchObject({
        code: "active_passive_no_ready_writer"
      });
      expect(cluster.fixedUpstream.total()).toBe(0);
      writer.lifecycle.flags[flag] = true;
      await writer.runtime.refreshReadiness();
      expect((await writer.runtime.probe("/api/readyz")).statusCode).toBe(200);
    }

    cluster.witness.setPrepareAvailable(false);
    await writer.runtime.refreshReadiness();
    expect(await writer.runtime.probe("/api/readyz")).toMatchObject({
      statusCode: 503,
      body: { reasonCode: "active_passive_witness_not_ready" }
    });
    cluster.witness.setPrepareAvailable(true);
    cluster.fence.partitionCurrent();
    await expect(writer.runtime.refreshWriterLease()).rejects.toMatchObject({
      code: "writer_fence_unavailable"
    });
    expect((await writer.runtime.probe("/api/healthz")).statusCode).toBe(200);
    expect(await writer.runtime.probe("/api/readyz")).toMatchObject({
      statusCode: 503,
      body: { reasonCode: "writer_fence_unavailable" }
    });
    cluster.fence.healAll();
    await writer.runtime.refreshWriterLease();
    await writer.runtime.refreshReadiness();
    expect((await writer.runtime.probe("/api/readyz")).statusCode).toBe(200);
    expectPrivateMarkersAbsent(await writer.runtime.summary(), [
      writer.userDataPath
    ]);
  });

  it("fails closed on lease loss and requires hard fencing before a next-epoch writer can replace a resurrected primary", async () : Promise<any> => {
    const cluster: any = await createCluster();
    const { writer, standby } = await startCluster(cluster);
    const effectKinds: any[] = [
      "upstream-network",
      "workspace-write",
      "custody-read",
      "queue-settle"
    ];
    const capturedEpochOneAttempts: any = effectKinds.map((effectKind?: any) : any => ({
      effectKind,
      claim: finalAttempt({
        node: writer,
        clock: cluster.clock,
        idempotencyKey: `${PRIVATE_IDEMPOTENCY}:captured:${effectKind}`,
        effectKind
      })
    }));

    cluster.fence.partitionCurrent();
    await expect(writer.runtime.refreshWriterLease()).rejects.toMatchObject({
      code: "writer_fence_unavailable"
    });
    for (const effectKind of effectKinds) {
      await expect(runEffect({
        node: writer,
        clock: cluster.clock,
        fixedUpstream: cluster.fixedUpstream,
        idempotencyKey: `${PRIVATE_IDEMPOTENCY}:${effectKind}`,
        effectId: `denied:${effectKind}`,
        effectKind
      })).rejects.toMatchObject({
        code: expect.stringMatching(
          /^(?:writer_fence_unavailable|active_passive_not_ready)$/u
        )
      });
    }
    expect(cluster.witness.calls).toEqual([]);
    expect(cluster.fixedUpstream.total()).toBe(0);

    await cluster.clock.advance(WRITER_TTL_MS + 1);
    await expect(standby.runtime.attemptWriterAcquire()).rejects.toMatchObject({
      code: "writer_hard_fence_required"
    });
    const hardFenceProof: any = cluster.fence.issueHardFence();
    await standby.runtime.attemptWriterAcquire({ hardFenceProof });
    await standby.runtime.refreshReadiness();
    expect(cluster.fence.currentEpoch()).toBe(2);
    expect(cluster.fence.lastAcquisitionMode()).toBe("hard-fence");
    expect((await standby.runtime.probe("/api/readyz")).statusCode).toBe(200);

    for (const { effectKind, claim } of capturedEpochOneAttempts) {
      await expect(standby.runtime.runFinalProtectedEffect({
        ...claim,
        idempotencyKey: `${PRIVATE_IDEMPOTENCY}:captured:${effectKind}`,
        perform: ({ writerEpoch }: Record<string, any>) : any =>
          cluster.fixedUpstream.invoke({
            effectId: `captured:${effectKind}`,
            writerEpoch
          })
      })).rejects.toMatchObject({
        code: "writer_fence_epoch_mismatch"
      });
    }

    cluster.fence.healAll();
    await expect(writer.runtime.refreshWriterLease()).rejects.toMatchObject({
      code: "writer_fence_not_current"
    });
    expect(await writer.runtime.probe("/api/healthz")).toMatchObject({
      statusCode: 200,
      body: { status: "live" }
    });
    expect((await writer.runtime.probe("/api/readyz")).statusCode).toBe(503);
    await expect(runEffect({
      node: writer,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: `${PRIVATE_IDEMPOTENCY}:resurrected`,
      effectId: "resurrected-old-writer"
    })).rejects.toMatchObject({
      code: expect.stringMatching(
        /^(?:writer_fence_not_current|active_passive_not_ready)$/u
      )
    });

    await expect(runEffect({
      node: standby,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: `${PRIVATE_IDEMPOTENCY}:new-writer`,
      effectId: "new-writer-effect"
    })).resolves.toMatchObject({ state: "settled" });
    expect(cluster.fixedUpstream.count("resurrected-old-writer")).toBe(0);
    expect(cluster.fixedUpstream.count("new-writer-effect")).toBe(1);
  });

  it("prepares and settles the independent witness synchronously and never blindly retries an in-doubt effect", async () : Promise<any> => {
    const cluster: any = await createCluster();
    const { writer, standby } = await startCluster(cluster);

    cluster.witness.setPrepareAvailable(false);
    await expect(runEffect({
      node: writer,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: `${PRIVATE_IDEMPOTENCY}:prepare-down`,
      effectId: "prepare-down"
    })).rejects.toMatchObject({
      code: "active_passive_effect_witness_unavailable"
    });
    expect(cluster.fixedUpstream.total()).toBe(0);

    cluster.witness.setPrepareAvailable(true);
    cluster.witness.failNextSettle();
    const uncertainKey: any = `${PRIVATE_IDEMPOTENCY}:post-effect-crash`;
    await expect(runEffect({
      node: writer,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: uncertainKey,
      effectId: "post-effect-crash"
    })).rejects.toMatchObject({
      code: "active_passive_effect_outcome_in_doubt"
    });
    expect(cluster.fixedUpstream.count("post-effect-crash")).toBe(1);

    cluster.fence.partitionCurrent();
    await expect(writer.runtime.refreshWriterLease()).rejects.toBeTruthy();
    await cluster.clock.advance(WRITER_TTL_MS + 1);
    const hardFenceProof: any = cluster.fence.issueHardFence();
    await standby.runtime.attemptWriterAcquire({ hardFenceProof });
    await standby.runtime.refreshReadiness();

    await expect(runEffect({
      node: standby,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: uncertainKey,
      effectId: "post-effect-crash"
    })).rejects.toMatchObject({
      code: "active_passive_effect_outcome_in_doubt"
    });
    expect(cluster.fixedUpstream.count("post-effect-crash")).toBe(1);

    await expect(runEffect({
      node: standby,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: `${PRIVATE_IDEMPOTENCY}:fresh`,
      effectId: "fresh-after-failover"
    })).resolves.toMatchObject({ state: "settled" });
    expect(cluster.fixedUpstream.count("fresh-after-failover")).toBe(1);
    for (const key of cluster.witness.records.keys()) {
      expect(key).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/u);
      expect(key).not.toContain(PRIVATE_IDEMPOTENCY);
    }
  });

  it("orders planned drain as LB removal, admission close, drain, final replica, resource close, then fence release", async () : Promise<any> => {
    const cluster: any = await createCluster();
    const { writer, standby } = await startCluster(cluster);
    await writeOrdinaryState(writer.userDataPath, "planned-handoff-state");
    writer.lifecycle.holdQueueItem();
    const heldUpstream: any = cluster.fixedUpstream.holdNext();
    const heldEffect: any = runEffect({
      node: writer,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: `${PRIVATE_IDEMPOTENCY}:planned-held`,
      effectId: "planned-held"
    });
    await heldUpstream.entered;

    const drain: any = writer.runtime.plannedDrain();
    await Promise.resolve();
    expect(await writer.runtime.probe("/api/readyz")).toMatchObject({
      statusCode: 503,
      body: { reasonCode: "active_passive_draining" }
    });
    await expect(cluster.loadBalancer.select()).rejects.toMatchObject({
      code: "active_passive_no_ready_writer"
    });

    heldUpstream.release();
    writer.lifecycle.releaseQueueItem();
    await expect(heldEffect).resolves.toMatchObject({ state: "settled" });
    const handoff: any = await drain;

    expectOrderedSubsequence(writer.transitionEvents, [
      "readiness_closed",
      "effect_admission_closed",
      "queue_admission_closed",
      "effects_drained",
      "queue_drained",
      "backup_replica_published",
      "storage_closed",
      "custody_closed",
      "fence_released"
    ]);
    expect(writer.lifecycle.counters()).toMatchObject({
      storageCloseCount: 1,
      custodyCloseCount: 1
    });
    const replicas: any = await cluster.replicaStore.list();
    expect(replicas).toHaveLength(1);
    expect(replicas[0]).toMatchObject({
      complete: true,
      sourceWriterEpoch: 1
    });

    await standby.runtime.restoreRecoveryPoint({
      replicaRef: handoff.replicaRef,
      handoffReceipt: handoff.handoffReceipt
    });
    await standby.runtime.attemptWriterAcquire({
      handoffReceipt: handoff.handoffReceipt
    });
    await standby.runtime.refreshReadiness();
    expect(await readOrdinaryState(standby.userDataPath))
      .toBe("planned-handoff-state");
    expect(cluster.fence.currentEpoch()).toBe(2);
    expect(cluster.fence.lastAcquisitionMode()).toBe("planned-handoff");
    expect((await standby.runtime.probe("/api/readyz")).statusCode).toBe(200);
    expect((await writer.runtime.probe("/api/readyz")).statusCode).toBe(503);
  });

  it("publishes only complete atomic replicas and rejects tamper, wrong custody, and superseded epochs before opening storage", async () : Promise<any> => {
    const cluster: any = await createCluster();
    const { writer, standby } = await startCluster(cluster);
    await writeOrdinaryState(writer.userDataPath, "epoch-one");

    cluster.replicaFaultState.stage = "before_publish_rename";
    await expect(writer.runtime.createRecoveryPoint()).rejects.toMatchObject({
      code: "fixture_replica_publication_fault"
    });
    expect(await cluster.replicaStore.list()).toEqual([]);
    cluster.replicaFaultState.stage = null;

    const epochOneReplica: any = await writer.runtime.createRecoveryPoint();
    const planned: any = await writer.runtime.plannedDrain();
    await standby.runtime.restoreRecoveryPoint({
      replicaRef: planned.replicaRef,
      handoffReceipt: planned.handoffReceipt
    });
    await standby.runtime.attemptWriterAcquire({
      handoffReceipt: planned.handoffReceipt
    });
    await standby.runtime.refreshReadiness();
    await writeOrdinaryState(standby.userDataPath, "epoch-two");

    standby.lifecycle.setCustodyGeneration(CUSTODY_GENERATION_B);
    await standby.runtime.refreshReadiness();
    const wrongCustodyReplica: any = await standby.runtime.createRecoveryPoint();
    standby.lifecycle.setCustodyGeneration(CUSTODY_GENERATION_A);
    await standby.runtime.refreshReadiness();
    const tamperedReplica: any = await standby.runtime.createRecoveryPoint();
    const tamperedFile: any = await findReplicaPayloadFile(
      cluster.replicaRoot,
      tamperedReplica.replicaRef.replicaId
    );
    expect(tamperedFile).not.toBe("");
    await fs.appendFile(tamperedFile, Buffer.from([0x7f]));
    const validReplica: any = await standby.runtime.createRecoveryPoint();

    cluster.fence.partitionCurrent();
    await expect(standby.runtime.refreshWriterLease()).rejects.toBeTruthy();
    await cluster.clock.advance(WRITER_TTL_MS + 1);
    const hardFenceProof: any = cluster.fence.issueHardFence();
    const replacement: any = await cluster.createNode(
      "private-instance-replacement",
      CUSTODY_GENERATION_A
    );

    for (const [replicaRef, code] of [
      [tamperedReplica.replicaRef, "active_passive_replica_integrity_failed"],
      [wrongCustodyReplica.replicaRef, "active_passive_replica_custody_mismatch"],
      [epochOneReplica.replicaRef, "active_passive_replica_epoch_stale"]
    ]) {
      await expect(replacement.runtime.restoreRecoveryPoint({
        replicaRef,
        hardFenceProof
      })).rejects.toMatchObject({ code });
      expect(replacement.lifecycle.counters().storageOpenCount).toBe(0);
      expect((await replacement.runtime.probe("/api/readyz")).statusCode).toBe(503);
      await expect(fs.readFile(
        path.join(replacement.userDataPath, "state", "ordinary.json")
      )).rejects.toMatchObject({ code: "ENOENT" });
    }

    await replacement.runtime.restoreRecoveryPoint({
      replicaRef: validReplica.replicaRef,
      hardFenceProof
    });
    await replacement.runtime.attemptWriterAcquire({ hardFenceProof });
    await replacement.runtime.refreshReadiness();
    expect(replacement.lifecycle.counters().storageOpenCount).toBe(1);
    expect(await readOrdinaryState(replacement.userDataPath)).toBe("epoch-two");
    expect((await replacement.runtime.probe("/api/readyz")).statusCode).toBe(200);
  });

  it("honestly exposes post-backup ordinary-state loss while preventing effect duplication and RPO/RTO claims", async () : Promise<any> => {
    const cluster: any = await createCluster();
    const { writer, standby } = await startCluster(cluster);
    await writeOrdinaryState(writer.userDataPath, "ordinary-state-a");
    const recoveryPoint: any = await writer.runtime.createRecoveryPoint();
    await writeOrdinaryState(writer.userDataPath, "ordinary-state-b");

    cluster.witness.failNextSettle();
    const uncertainKey: any = `${PRIVATE_IDEMPOTENCY}:ordinary-state-gap`;
    await expect(runEffect({
      node: writer,
      clock: cluster.clock,
      fixedUpstream: cluster.fixedUpstream,
      idempotencyKey: uncertainKey,
      effectId: "effect-after-backup"
    })).rejects.toMatchObject({
      code: "active_passive_effect_outcome_in_doubt"
    });
    expect(cluster.fixedUpstream.count("effect-after-backup")).toBe(1);

    const failoverStartedAt: any = cluster.clock.now();
    cluster.fence.partitionCurrent();
    await expect(writer.runtime.refreshWriterLease()).rejects.toBeTruthy();
    await cluster.clock.advance(WRITER_TTL_MS + 250);
    const hardFenceProof: any = cluster.fence.issueHardFence();
    await standby.runtime.restoreRecoveryPoint({
      replicaRef: recoveryPoint.replicaRef,
      hardFenceProof
    });
    await standby.runtime.attemptWriterAcquire({ hardFenceProof });
    await standby.runtime.refreshReadiness();

    expect(await readOrdinaryState(standby.userDataPath)).toBe("ordinary-state-a");
    expect(await readOrdinaryState(writer.userDataPath)).toBe("ordinary-state-b");
    await expect(cluster.loadBalancer.invoke((selected?: any) : any =>
      runEffect({
        node: selected,
        clock: cluster.clock,
        fixedUpstream: cluster.fixedUpstream,
        idempotencyKey: uncertainKey,
        effectId: "effect-after-backup"
      })
    )).rejects.toMatchObject({
      code: "active_passive_effect_outcome_in_doubt"
    });
    expect(cluster.fixedUpstream.count("effect-after-backup")).toBe(1);

    const summary: any = await standby.runtime.summary({
      failoverStartedAt
    });
    expect(Object.keys(summary).sort()).toEqual([
      "measurements",
      "profile",
      "ready",
      "reasonCode",
      "role",
      "state",
      "writerEpoch"
    ]);
    expect(summary).toMatchObject({
      profile: "enterprise-active-passive-container",
      ready: true,
      role: "writer",
      writerEpoch: 2
    });
    expect(Object.keys(summary.measurements).sort()).toEqual([
      "backupAgeMs",
      "effectInDoubtCount",
      "failoverDurationMs",
      "protectedEffectCount"
    ]);
    for (const value of (Object.values(summary.measurements) as any[])) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    const serialized: any = JSON.stringify(summary);
    expect(serialized).not.toMatch(/rpo|rto|guarantee|zero.?downtime/iu);
    expectPrivateMarkersAbsent(summary, [
      writer.userDataPath,
      standby.userDataPath,
      cluster.replicaRoot
    ]);
  });
});
