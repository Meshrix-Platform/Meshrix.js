import { fork, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgentWorkspace } from "../../../packages/agents/src/agent-workspace/index.ts";
import { stableId } from "../../../packages/agents/src/agent-workspace/agent-workspace-support.ts";
import { SERVER_API_OPERATIONS } from "../../../packages/contracts/src/operations/operation-registry.ts";
import { canonicalJson } from "../../../packages/contracts/src/serialization/canonical-json.ts";
import { MemoryLockManager } from "../../../packages/foundation/src/concurrency/lock-manager.ts";
import {
  CONSOLE_CSRF_COOKIE,
  CONSOLE_SESSION_COOKIE
} from "../../../packages/foundation/src/security/auth/console-auth.ts";
import { openSqliteDatabase } from "../../../packages/foundation/src/storage/sqlite-database.ts";
import { createSqliteWorkQueueStore } from "../../../packages/foundation/src/work-queue/sqlite-store.ts";
import { createUploadSessionHandlers } from "../../../packages/protocols/http/controllers/jobs-controller-upload-handlers.ts";
import { createQueueApplicationPort } from "../../../packages/server-runtime/src/composition/queue-application-port.ts";
import { dispatchRegisteredHttpOperation } from "../../../packages/server-runtime/src/composition/dispatch-operation-http.ts";
import { createOperationRouteIndex } from "../../../packages/server-runtime/src/routing/operation-route-index.ts";
import { createServerCompositionRoot } from "../../../packages/server-runtime/src/composition/composition-root.ts";
import {
  createUploadWorkspaceMaterializationProvider,
  createUploadWorkspaceMaterializationTransactionStore
} from "../../../packages/server-runtime/src/composition/upload-workspace-materialization-provider.ts";

const OPERATION_ID: any = "jobs.upload_workspace_materialize";
const CRASH_ADMISSION_USERNAME: any =
  "materialization-crash-owner";
const CRASH_ADMISSION_PASSWORD: any =
  "Synthetic-Materialization-Crash-Owner-42!";
const MATERIALIZATION_PATH: any =
  "/api/jobs/upload-workspace-materializations";
const DEFAULT_LOGICAL_TARGET: any = "incoming/materialized-payload.bin";
const MAX_PLAINTEXT_WINDOW: any = 64 * 1024;
const RUNTIME_LEASE_MS: any = 5_000;
const CRASH_LEASE_MS: any = 250;
const POSIX: any = process.platform !== "win32";
const itPosix: any = POSIX ? it : it.skip;
const PRECOMMIT_CRASH_CASES: readonly any[] = Object.freeze([
  Object.freeze({
    crashStage: "after_publication_intent",
    custodyReads: 0,
    expectsCleanup: true,
    finalPermits: 1,
    stage: "publication_intent",
    tempState: "missing",
    targetState: "missing"
  }),
  Object.freeze({
    crashStage: "after_directory_worker_bound",
    custodyReads: 0,
    expectsCleanup: false,
    finalPermits: 0,
    stage: "admitted",
    tempState: "missing",
    targetState: "missing"
  }),
  Object.freeze({
    crashStage: "after_temp_reserved",
    custodyReads: 0,
    expectsCleanup: true,
    finalPermits: 1,
    stage: "temp_reserved",
    tempState: "empty",
    targetState: "missing"
  }),
  Object.freeze({
    crashStage: "after_first_chunk_written",
    custodyReads: 1,
    expectsCleanup: true,
    finalPermits: 1,
    stage: "temp_reserved",
    tempState: "partial",
    targetState: "missing"
  }),
  Object.freeze({
    crashStage: "after_publication_prepared",
    custodyReads: 1,
    expectsCleanup: true,
    finalPermits: 1,
    stage: "publication_prepared",
    tempState: "full",
    targetState: "missing"
  }),
  Object.freeze({
    crashStage: "after_publication_linked",
    custodyReads: 1,
    expectsCleanup: true,
    finalPermits: 1,
    stage: "publication_prepared",
    tempState: "linked",
    targetState: "linked"
  }),
  Object.freeze({
    crashStage: "after_published_file_durable",
    custodyReads: 1,
    expectsCleanup: true,
    finalPermits: 1,
    stage: "publication_prepared",
    tempState: "missing",
    targetState: "full"
  })
]);
const QUEUE_CRASH_CASES: readonly any[] = Object.freeze([
  Object.freeze({
    crashStage: "after_queue_claim",
    interruptedStage: "admitted",
    interruptedStatus: "queued",
    markerEffects: Object.freeze({
      archiveWrites: 0,
      custodyReads: 0,
      finalPermits: 0,
      stateCommits: 0
    }),
    recoveryEffects: Object.freeze({
      custodyReads: 1,
      finalPermits: 1,
      stateCommits: 1
    })
  }),
  Object.freeze({
    crashStage: "after_transaction_completed_before_queue_ack",
    interruptedStage: "completed",
    interruptedStatus: "completed",
    markerEffects: Object.freeze({
      custodyReads: 1,
      finalPermits: 1,
      stateCommits: 1
    }),
    recoveryEffects: Object.freeze({
      archiveWrites: 0,
      custodyReads: 0,
      finalPermits: 0,
      stateCommits: 0
    })
  })
]);
const WAL_TAMPER_CASES: readonly any[] = Object.freeze([
  Object.freeze({
    expectedStage: "publication_intent",
    hookName: "afterPublicationIntentBeforeCustodyOpen",
    hookOwner: "faultHooks"
  }),
  Object.freeze({
    expectedStage: "temp_reserved",
    hookName: "afterTempReservedBeforeFirstWrite",
    hookOwner: "faultHooks"
  }),
  Object.freeze({
    expectedStage: "publication_prepared",
    hookName: "afterPublicationPreparedBeforeLink",
    hookOwner: "faultHooks"
  }),
  Object.freeze({
    expectedStage: "published",
    hookName: "afterWorkspacePublish",
    hookOwner: "faultHooks"
  }),
  Object.freeze({
    expectedStage: "evidence_pending",
    hookName: "afterEvidencePending",
    hookOwner: "faultHooks"
  }),
  Object.freeze({
    expectedStage: "audit_finalized",
    hookName: "afterProofWriteBeforeRecord",
    hookOwner: "faultHooks"
  }),
  Object.freeze({
    expectedStage: "proof_finalized",
    hookName: "afterProofFinalizedRecord",
    hookOwner: "transactionHooks"
  })
]);
const FORBIDDEN_ADMISSION_ALIAS_GROUPS: Readonly<Record<string, any>> = Object.freeze({
  allow: Object.freeze(["allow", "allowed", "authorized", "canWrite"]),
  bytes: Object.freeze([
    "body",
    "buffer",
    "bytes",
    "content",
    "contentBase64",
    "payload"
  ]),
  descriptor: Object.freeze([
    "descriptor",
    "fileDescriptor",
    "materializationDescriptor",
    "mutation"
  ]),
  key: Object.freeze(["credential", "encryptionKey", "key", "secret"]),
  path: Object.freeze([
    "absolutePath",
    "destination",
    "sourcePath",
    "targetPath"
  ]),
  permit: Object.freeze([
    "authorization",
    "capability",
    "permit",
    "proof"
  ]),
  receipt: Object.freeze([
    "approvalReceipt",
    "authorizationReceipt",
    "receipt",
    "settlementReceipt"
  ]),
  token: Object.freeze([
    "accessToken",
    "bearer",
    "sessionToken",
    "token"
  ])
});
const PATH_SENSITIVE_FAULT_SEAMS: readonly any[] = Object.freeze([
  "afterDirectoryWorkerBoundBeforeReserve",
  "afterTempInodeReservedBeforeWal",
  "afterTempReservedBeforeFirstWrite",
  "afterFirstChunkWrittenBeforeContinue",
  "afterPublicationPreparedBeforeLink",
  "afterPublicationLinkedBeforeTempUnlink",
  "afterPublishedFileDurableBeforeStateCommit"
]);
const INODE_REPLACEMENT_CASES: readonly any[] = Object.freeze([
  ...["symlink", "hardlink", "fifo", "socket", "mode", "nlink"].map(
    (replacement?: any) : any => Object.freeze({
      faultSeam: "afterTempReservedBeforeFirstWrite",
      replacement,
      subject: "temp"
    })
  ),
  ...["symlink", "hardlink", "fifo", "socket", "mode", "nlink"].map(
    (replacement?: any) : any => Object.freeze({
      faultSeam: "afterPublicationLinkedBeforeTempUnlink",
      replacement,
      subject: "target"
    })
  )
]);
const crashChildPath: any = fileURLToPath(new URL(
  "./support/upload-workspace-materialization-crash-child.ts",
  import.meta.url
));
const cleanupTasks: any[] = [];
const retainedCrashChildren: any[] = [];

function sha256(value?: any) : any {
  return createHash("sha256").update(value).digest("hex");
}

function clone(value?: any) : any {
  return JSON.parse(JSON.stringify(value));
}

function responseRecorder() : any {
  return {
    chunks: [],
    statusCode: 0,
    writeHead(statusCode?: any) : any {
      this.statusCode = statusCode;
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(
          Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
        );
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    },
    json() : any {
      return JSON.parse(
        Buffer.concat(this.chunks).toString("utf8") || "{}"
      );
    }
  };
}

function cookieMap(setCookies: any = []) : any {
  return Object.fromEntries(setCookies.map((cookie?: any) : any => {
    const [name, value = ""] =
      String(cookie).split(";", 1)[0].split("=");
    return [
      decodeURIComponent(name),
      decodeURIComponent(value)
    ];
  }));
}

function authCookieHeader(loginResult?: any) : any {
  const cookies: any = cookieMap(loginResult.cookies);
  return [
    `${CONSOLE_SESSION_COOKIE}=${encodeURIComponent(
      cookies[CONSOLE_SESSION_COOKIE]
    )}`,
    `${CONSOLE_CSRF_COOKIE}=${encodeURIComponent(
      cookies[CONSOLE_CSRF_COOKIE]
    )}`
  ].join("; ");
}

function consoleRequest({
  cookie = "",
  csrf = "",
  safetyConfirm = true
}: Record<string, any> = {}) : any {
  const headers: Record<string, any> = {
    host: "console.local",
    origin: "http://console.local",
    "user-agent": "meshrix-materialization-acceptance"
  };
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-meshrix-csrf"] = csrf;
  if (safetyConfirm) {
    headers["x-meshrix-safety-confirm"] = "true";
  }
  return {
    headers,
    method: "POST",
    socket: {
      encrypted: false,
      remoteAddress: "127.0.0.1"
    },
    url: MATERIALIZATION_PATH
  };
}

function terminalStatus(value?: any) : any {
  return ["cancelled", "completed", "failed"].includes(
    String(value?.status || "")
  );
}

function safeDiagnosticToken(value?: any, fallback: any = "none") : any {
  const normalized: any = String(value || "").trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/u.test(normalized)
    ? normalized
    : fallback;
}

function createPausePoint() : any {
  let reachedResolve: any;
  let releaseResolve: any;
  let entered: any = false;
  const reached: any = new Promise((resolve?: any) : any => {
    reachedResolve = resolve;
  });
  const released: any = new Promise((resolve?: any) : any => {
    releaseResolve = resolve;
  });
  const point: Readonly<Record<string, any>> = Object.freeze({
    reached,
    async hook(input?: any) : Promise<any> {
      if (entered) return;
      entered = true;
      reachedResolve(Object.freeze({ ...input }));
      await released;
    },
    release() : any {
      releaseResolve();
    }
  });
  cleanupTasks.push(() : any => point.release());
  return point;
}

function createQueueSchedulingGate(
  queueApplicationPort?: any,
  events?: any,
  counters?: any
) : any {
  let facet: any = null;
  let released: any = false;
  const recoveredWorkItemIds: any = new Set<any>();
  async function waitForInFlightHandlers({
    timeoutMs = 90_000
  }: Record<string, any> = {}) : Promise<any> {
    const startedAt: any = Date.now();
    while (Number(facet?.describe()?.execution?.inFlight || 0) > 0) {
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(
          "Materialization queue handler did not drain."
        );
      }
      await new Promise((resolve?: any) : any => setImmediate(resolve));
    }
  }
  return Object.freeze({
    port: Object.freeze({
      async registerQueue(definition?: any) : Promise<any> {
        const realFacet: any =
          await queueApplicationPort.registerQueue(definition);
        facet = realFacet;
        return Object.freeze({
          ...realFacet,
          async enqueue(...args: any[]) : Promise<any> {
            counters.queueEnqueues += 1;
            return realFacet.enqueue(...args);
          },
          requestDispatch() : any {
            if (!released) {
              return Promise.resolve({
                dispatched: 0,
                reason: "acceptance_schedule_gate"
              });
            }
            return realFacet.requestDispatch();
          }
        });
      }
    }),
    async dispatch() : Promise<any> {
      if (!facet) {
        throw new Error(
          "Materialization queue is not registered."
        );
      }
      released = true;
      events.push("queue-dispatch");
      try {
        const result: any = await facet.requestDispatch();
        for (const dispatchResult of result?.results || []) {
          for (const recovered of dispatchResult?.recovered || []) {
            if (recovered?.workItemId) {
              recoveredWorkItemIds.add(recovered.workItemId);
            }
          }
        }
        await waitForInFlightHandlers();
        return result;
      } finally {
        released = false;
      }
    },
    observe(input: Record<string, any> = {}) : any {
      if (!facet) {
        throw new Error(
          "Materialization queue is not registered."
        );
      }
      return facet.observe(input);
    },
    recoveredWorkItemIds() : any {
      return [...recoveredWorkItemIds].sort();
    }
  });
}

function transactionDatabasePath(root?: any) : any {
  return path.join(
    root,
    "jobs",
    "upload-workspace-materialization.sqlite"
  );
}

function readRawTransactionRow(root?: any, requestRef?: any) : any {
  const db: any = openSqliteDatabase(transactionDatabasePath(root));
  try {
    return db.prepare(`
      SELECT *
      FROM materialization_requests
      WHERE request_ref = ?
    `).get(requestRef);
  } finally {
    db.close();
  }
}

function readRawAgentWorkspaceRow(root?: any, workspaceId?: any) : any {
  const db: any = openSqliteDatabase(path.join(
    root,
    "agent-workspaces",
    "agent-workspace.sqlite"
  ));
  try {
    return db.prepare(`
      SELECT *
      FROM aw_workspaces
      WHERE workspace_id = ?
    `).get(workspaceId);
  } finally {
    db.close();
  }
}

function safeEffectCounts(fixture?: any) : any {
  return Object.freeze({
    archiveWrites: fixture.counters.archiveWrites,
    custodyReads: fixture.counters.custodyReads,
    finalPermits: fixture.counters.finalPermits,
    maxPlaintextChunk: fixture.counters.maxPlaintextChunk,
    queueClaims: fixture.counters.queueClaims,
    stateCommits: fixture.counters.stateCommits,
    workspaceReads: fixture.counters.workspaceReads
  });
}

async function createFixture() : Promise<any> {
  const root: any = await fs.mkdtemp(
    path.join(os.tmpdir(), "meshrix-materialization-acceptance-")
  );
  const registeredOperation: any = SERVER_API_OPERATIONS.find(
    (candidate?: any) : any => candidate.id === OPERATION_ID
  );
  if (!registeredOperation) {
    throw new Error(
      "Upload workspace materialization operation is unavailable."
    );
  }
  const operationAuthority: any = clone(registeredOperation);
  const lockManager: any = new MemoryLockManager();
  const events: any[] = [];
  const faultHooks: any = Object.create(null);
  const counters: Record<string, any> = {
    archiveWrites: 0,
    authorityCaptures: 0,
    custodyReads: 0,
    finalPermits: 0,
    maxPlaintextChunk: 0,
    maxOutstandingPlaintext: 0,
    outstandingPlaintext: 0,
    queueClaims: 0,
    queueEnqueues: 0,
    sourceChunks: [],
    stateCommits: 0,
    transactionCreates: 0,
    workspaceReads: 0,
    workspaceReadKinds: []
  };
  const fixture: Record<string, any> = {
    root,
    events,
    faultHooks,
    transactionHooks: Object.create(null),
    counters,
    lockManager,
    operationAuthority,
    runtimes: [],
    compositionRoot: null,
    runtimeProviders: null,
    owner: null,
    workspace: null,
    loginResult: null,
    tagManagementStore: null,
    consoleAuth: null,
    securityPermissions: null,
    deferredAuthorityPort: null,
    storageKernel: null,
    storageProvider: null,
    keyBroker: null,
    noRunCustody: null,
    uploadSessionStore: null,
    substrate: null,
    agentWorkspace: null,
    operationAuditStore: null,
    operationProofSubstrate: null,
    workspaceRoot: "",
    custodyStreamTransform: null,
    descriptorTransform: null,
    recoveryTransforms: Object.create(null)
  };

  fixture.resetEffects = () : any => {
    counters.archiveWrites = 0;
    counters.authorityCaptures = 0;
    counters.custodyReads = 0;
    counters.finalPermits = 0;
    counters.maxPlaintextChunk = 0;
    counters.maxOutstandingPlaintext = 0;
    counters.outstandingPlaintext = 0;
    counters.queueClaims = 0;
    counters.queueEnqueues = 0;
    counters.sourceChunks.length = 0;
    counters.stateCommits = 0;
    counters.transactionCreates = 0;
    counters.workspaceReads = 0;
    counters.workspaceReadKinds.length = 0;
    events.length = 0;
  };

  async function openPersistentResources({ initialize = false }: Record<string, any> = {}) : Promise<any> {
    const runtimeLogger: Readonly<Record<string, any>> = Object.freeze({
      debug() : any {},
      error() : any {},
      info() : any {},
      warn() : any {}
    });
    fixture.compositionRoot = await createServerCompositionRoot({
      runtimeLogger,
      runtimeOptions: {
        enabledPlugins: [],
        pluginConfigurations: {},
        profile: "minimal"
      },
      userDataPath: root
    });
    fixture.consoleAuth = fixture.compositionRoot.consoleAuth;
    fixture.tagManagementStore =
      fixture.consoleAuth.tagManagementStore;
    if (initialize) {
      const initialOwner: any =
        await fixture.consoleAuth.ensureInitialOwner();
      const loginRequest: any = consoleRequest({
        safetyConfirm: false
      });
      loginRequest.url = "/api/console/auth/login";
      fixture.loginResult = await fixture.consoleAuth.login({
        username: initialOwner.username,
        password: initialOwner.password
      }, loginRequest);
      fixture.owner = Object.freeze({
        subjectId:
          fixture.loginResult.session.user.userId,
        tenantId:
          fixture.loginResult.session.user.tenantId,
        userId:
          fixture.loginResult.session.user.userId
      });
    }
    fixture.securityPermissions =
      fixture.compositionRoot.securityPermissions;
    fixture.deferredAuthorityPort =
      fixture.compositionRoot
        .deferredProtectedSinkAuthorityPort;
    fixture.storageKernel =
      fixture.compositionRoot.storageKernel;
    fixture.storageProvider =
      fixture.compositionRoot.storageProvider;
    fixture.noRunCustody =
      fixture.compositionRoot.uploadNoRunCustody;
    fixture.uploadSessionStore =
      fixture.compositionRoot.uploadSessionStore;
    fixture.substrate =
      fixture.compositionRoot.dataStructureSubstrate;
    fixture.operationAuditStore =
      fixture.compositionRoot.operationAuditStore;
    fixture.operationProofSubstrate =
      fixture.compositionRoot.operationProofSubstrate;
    const realMerkleState: any =
      fixture.substrate.merkleStateSubstrate;
    const observedCas: Readonly<Record<string, any>> = Object.freeze({
      ...realMerkleState.cas,
      async putBlock(...args: any[]) : Promise<any> {
        counters.archiveWrites += 1;
        return realMerkleState.cas.putBlock(...args);
      }
    });
    const observedStateCommit: Readonly<Record<string, any>> = Object.freeze({
      ...realMerkleState.stateCommit,
      async begin(...args: any[]) : Promise<any> {
        counters.workspaceReads += 1;
        counters.workspaceReadKinds.push("state.begin");
        return realMerkleState.stateCommit.begin(...args);
      },
      async getCommitByEventHash(...args: any[]) : Promise<any> {
        counters.workspaceReads += 1;
        counters.workspaceReadKinds.push("state.commit");
        const commit: any = await realMerkleState.stateCommit
          .getCommitByEventHash(...args);
        return typeof fixture.recoveryTransforms.stateCommit ===
          "function"
          ? fixture.recoveryTransforms.stateCommit(commit)
          : commit;
      }
    });
    const observedEventLog: Readonly<Record<string, any>> = Object.freeze({
      ...realMerkleState.eventLog,
      async getEvent(...args: any[]) : Promise<any> {
        counters.workspaceReads += 1;
        counters.workspaceReadKinds.push("event.get");
        const event: any =
          await realMerkleState.eventLog.getEvent(...args);
        return typeof fixture.recoveryTransforms.event === "function"
          ? fixture.recoveryTransforms.event(event)
          : event;
      },
      async listEvents(...args: any[]) : Promise<any> {
        counters.workspaceReads += 1;
        counters.workspaceReadKinds.push("event.list");
        return realMerkleState.eventLog.listEvents(...args);
      },
      async verifyPartition(...args: any[]) : Promise<any> {
        counters.workspaceReads += 1;
        counters.workspaceReadKinds.push("event.verify");
        return realMerkleState.eventLog.verifyPartition(...args);
      }
    });
    const observedMerkleIndex: Readonly<Record<string, any>> = Object.freeze({
      ...realMerkleState.merkleIndex,
      async get(...args: any[]) : Promise<any> {
        counters.workspaceReads += 1;
        counters.workspaceReadKinds.push("index.get");
        return realMerkleState.merkleIndex.get(...args);
      }
    });
    const observedMerkleState: Readonly<Record<string, any>> = Object.freeze({
      ...realMerkleState,
      cas: observedCas,
      eventLog: observedEventLog,
      merkleIndex: observedMerkleIndex,
      stateCommit: observedStateCommit
    });
    const realCheckpointTree: any =
      fixture.substrate.checkpointTreeProjection;
    const observedCheckpointTree: Readonly<Record<string, any>> = Object.freeze({
      ...realCheckpointTree,
      async upsertCheckpointNode(input?: any) : Promise<any> {
        const candidate: any =
          typeof fixture.recoveryTransforms.checkpoint === "function"
            ? fixture.recoveryTransforms.checkpoint(input)
            : input;
        return realCheckpointTree.upsertCheckpointNode(candidate);
      }
    });
    const observedSubstrate: Readonly<Record<string, any>> = Object.freeze({
      ...fixture.substrate,
      checkpointTreeProjection: observedCheckpointTree,
      merkleStateSubstrate: observedMerkleState
    });
    fixture.runtimeProviders =
      await fixture.compositionRoot.createBoundRuntimeProviders({
        activeFeatureIds:
          fixture.compositionRoot.featureRuntime.activeFeatureIds,
        dataStructureSubstrate: observedSubstrate,
        getControllers: () : any => Object.freeze({}),
        getDiscoveryState: () : any => Object.freeze({}),
        getJobWorkflowProvider: () : any => null,
        getListenUrl: () : any => "",
        getOperationPermissionPlatform: () : any => null,
        isAnyFeatureActive:
          fixture.compositionRoot.isAnyFeatureActive,
        isFeatureActive:
          fixture.compositionRoot.isFeatureActive,
        jobManager: null,
        operationAuditStore:
          fixture.operationAuditStore,
        operationConcurrencyScope:
          fixture.compositionRoot.operationConcurrencyScope,
        operationLockManager:
          fixture.compositionRoot.operationLockManager,
        operationProofSubstrate:
          fixture.operationProofSubstrate,
        protocolEventBus:
          fixture.compositionRoot.protocolEventBus,
        queueApplicationPort:
          fixture.compositionRoot.queueApplicationPort,
        runtime: fixture.compositionRoot.runtime,
        runtimeLogger,
        securityPermissions: fixture.securityPermissions,
        userDataPath: root
      });
    fixture.agentWorkspace =
      fixture.runtimeProviders.agentWorkspace;
    if (!fixture.agentWorkspace) {
      throw new Error(
        "Root-owned agent workspace composition is unavailable."
      );
    }
    if (initialize) {
      fixture.workspace =
        fixture.agentWorkspace.createWorkspace({
          ownerUserId: fixture.owner.subjectId,
          title: "Custody materialization acceptance"
        }).workspace;
    }
    fixture.workspaceRoot = path.join(
      root,
      "agent-workspaces",
      "folders",
      stableId(
        "workspace-folder",
        fixture.workspace.workspaceId
      )
    );
  }

  async function closePersistentResources() : Promise<any> {
    await fixture.agentWorkspace?.close?.();
    fixture.agentWorkspace = null;
    fixture.runtimeProviders = null;
    await fixture.compositionRoot?.close?.();
    fixture.compositionRoot = null;
    fixture.operationProofSubstrate = null;
    fixture.operationAuditStore = null;
    fixture.substrate = null;
    fixture.consoleAuth = null;
    fixture.tagManagementStore = null;
    fixture.keyBroker = null;
    fixture.storageKernel = null;
    fixture.storageProvider = null;
    fixture.noRunCustody = null;
    fixture.uploadSessionStore = null;
    fixture.securityPermissions = null;
    fixture.deferredAuthorityPort = null;
  }

  const invokeHook: any = async (name?: any, input?: any) : Promise<any> => {
    events.push(name);
    await faultHooks[name]?.(input, fixture);
  };

  fixture.openRuntime = async () : Promise<any> => {
    const transactionStore: any =
      createUploadWorkspaceMaterializationTransactionStore({
        leaseMs: RUNTIME_LEASE_MS,
        userDataPath: root
      });
    const queueStore: any = createSqliteWorkQueueStore({
      userDataPath: root,
      policy: { leaseTimeoutMs: RUNTIME_LEASE_MS }
    });
    const queueApplicationPort: any =
      await createQueueApplicationPort({
        dispatchIntervalMs: 60_000,
        store: queueStore,
        userDataPath: root
      });
    const queueGate: any = createQueueSchedulingGate(
      queueApplicationPort,
      events,
      counters
    );
    const uploadCustodyReadPort: Readonly<Record<string, any>> = Object.freeze({
      async open(input?: any) : Promise<any> {
        counters.custodyReads += 1;
        const opened: any =
          await fixture.noRunCustody.readPort.open(input);
        const observedStream: any =
          (async function* observedPlaintext() : AsyncGenerator<any, any, any> {
            for await (const value of opened.stream) {
              const chunk: any = Buffer.isBuffer(value)
                ? value
                : Buffer.from(value);
              counters.sourceChunks.push(chunk.byteLength);
              counters.maxPlaintextChunk = Math.max(
                counters.maxPlaintextChunk,
                chunk.byteLength
              );
              counters.outstandingPlaintext +=
                chunk.byteLength;
              counters.maxOutstandingPlaintext = Math.max(
                counters.maxOutstandingPlaintext,
                counters.outstandingPlaintext
              );
              try {
                yield chunk;
              } finally {
                counters.outstandingPlaintext -=
                  chunk.byteLength;
              }
            }
          })();
        return Object.freeze({
          receipt: opened.receipt,
          stream:
            typeof fixture.custodyStreamTransform === "function"
              ? fixture.custodyStreamTransform(observedStream)
              : observedStream
        });
      }
    });
    const transactionStorePort: Readonly<Record<string, any>> = Object.freeze({
      ...transactionStore,
      async create(...args: any[]) : Promise<any> {
        counters.transactionCreates += 1;
        return transactionStore.create(...args);
      },
      async recordProofFinalized(...args: any[]) : Promise<any> {
        const recorded: any =
          await transactionStore.recordProofFinalized(...args);
        await fixture.transactionHooks
          .afterProofFinalizedRecord?.(
            Object.freeze({
              requestRef: recorded.requestRef
            })
          );
        return recorded;
      }
    });
    const provider: any =
      await fixture.compositionRoot
        .createBoundUploadWorkspaceMaterializationProvider({
        deferredProtectedSinkAuthorityPort: Object.freeze({
          ...fixture.deferredAuthorityPort,
          async capture(...args: any[]) : Promise<any> {
            counters.authorityCaptures += 1;
            return fixture.deferredAuthorityPort.capture(...args);
          }
        }),
        faultInjector: Object.freeze({
          afterTransactionCreatedBeforeEnqueue: (input?: any) : any =>
            invokeHook(
              "afterTransactionCreatedBeforeEnqueue",
              input
            ),
          afterQueueClaim: async (input?: any) : Promise<any> => {
            counters.queueClaims += 1;
            await invokeHook("afterQueueClaim", input);
          },
          afterTransactionCompletedBeforeQueueAck: (input?: any) : any =>
            invokeHook(
              "afterTransactionCompletedBeforeQueueAck",
              input
            ),
          afterFinalPermitConsumed: async (input?: any) : Promise<any> => {
            counters.finalPermits += 1;
            await invokeHook(
              "afterFinalPermitConsumed",
              input
            );
          },
          afterPublicationIntentBeforeCustodyOpen: (input?: any) : any =>
            invokeHook(
              "afterPublicationIntentBeforeCustodyOpen",
              input
            ),
          afterDirectoryWorkerBoundBeforeReserve: (input?: any) : any =>
            invokeHook(
              "afterDirectoryWorkerBoundBeforeReserve",
              input
            ),
          afterTempInodeReservedBeforeWal: (input?: any) : any =>
            invokeHook(
              "afterTempInodeReservedBeforeWal",
              input
            ),
          afterTempReservedBeforeFirstWrite: (input?: any) : any =>
            invokeHook(
              "afterTempReservedBeforeFirstWrite",
              input
            ),
          afterFirstChunkWrittenBeforeContinue: (input?: any) : any =>
            invokeHook(
              "afterFirstChunkWrittenBeforeContinue",
              input
            ),
          afterPublicationPreparedBeforeLink: (input?: any) : any =>
            invokeHook(
              "afterPublicationPreparedBeforeLink",
              input
            ),
          afterPublicationLinkedBeforeTempUnlink: (input?: any) : any =>
            invokeHook(
              "afterPublicationLinkedBeforeTempUnlink",
              input
            ),
          afterPublishedFileDurableBeforeStateCommit: (input?: any) : any =>
            invokeHook(
              "afterPublishedFileDurableBeforeStateCommit",
              input
            ),
          afterStateAndCheckpointDurableBeforeReceipt:
            async (input?: any) : Promise<any> => {
              counters.stateCommits += 1;
              await invokeHook(
                "afterStateAndCheckpointDurableBeforeReceipt",
                input
              );
            },
          afterPrecommitCleanupBeforeRecord: (input?: any) : any =>
            invokeHook(
              "afterPrecommitCleanupBeforeRecord",
              input
            ),
          afterWorkspacePublish: (input?: any) : any =>
            invokeHook("afterWorkspacePublish", input),
          afterEvidencePending: (input?: any) : any =>
            invokeHook("afterEvidencePending", input),
          afterAuditWriteBeforeRecord: (input?: any) : any =>
            invokeHook(
              "afterAuditWriteBeforeRecord",
              input
            ),
          afterProofWriteBeforeRecord: (input?: any) : any =>
            invokeHook(
              "afterProofWriteBeforeRecord",
              input
            )
        }),
        operationAuditStore: fixture.operationAuditStore,
        operationProofSubstrate:
          fixture.operationProofSubstrate,
        queueApplicationPort: queueGate.port,
        resolveOperation(operationId?: any) : any {
          return operationId === OPERATION_ID
            ? fixture.operationAuthority
            : null;
        },
        transactionStore: transactionStorePort,
        uploadCustodyReadPort,
        uploadSessionStore: Object.freeze({
          ...fixture.uploadSessionStore,
          async resolveUploadSessionFiles(...args: any[]) : Promise<any> {
            const files: any =
              await fixture.uploadSessionStore
                .resolveUploadSessionFiles(...args);
            return typeof fixture.descriptorTransform === "function"
              ? fixture.descriptorTransform(files)
              : files;
          }
        }),
        userDataPath: root
        });
    const handlers: any = createUploadSessionHandlers({
      checkpointUploadSessionStore:
        fixture.uploadSessionStore,
      protocolEventBus: null,
      uploadWorkspaceMaterializationProvider: provider,
      userDataPath: root
    });
    let closed: any = false;
    const runtime: Record<string, any> = {
      handlers,
      provider,
      queueApplicationPort,
      queueGate,
      queueStore,
      transactionStore,
      async close() : Promise<any> {
        if (closed) return;
        closed = true;
        await provider.close();
        transactionStore.close();
        await queueApplicationPort.close();
        await queueStore.close?.();
      }
    };
    fixture.runtimes.push(runtime);
    return runtime;
  };

  fixture.closeRuntimes = async () : Promise<any> => {
    for (const runtime of fixture.runtimes.splice(0).reverse()) {
      await runtime.close().catch(() : any => {});
    }
  };
  fixture.suspendPersistent = async () : Promise<any> => {
    await fixture.closeRuntimes();
    await closePersistentResources();
  };
  fixture.resumePersistent = async () : Promise<any> => {
    await openPersistentResources({ initialize: false });
  };
  fixture.ensureTargetParent = async (
    logicalTarget: any = DEFAULT_LOGICAL_TARGET
  ) : Promise<any> => {
    await fs.mkdir(
      path.dirname(path.join(fixture.workspaceRoot, logicalTarget)),
      { recursive: true, mode: 0o700 }
    );
  };
  fixture.materializationEvents = async () : Promise<any> => {
    const scope: any = `workspace:${fixture.workspace.workspaceId}`;
    const eventsForWorkspace: any =
      await fixture.substrate.merkleStateSubstrate
        .eventLog.listEvents(scope, { limit: 10_000 });
    return eventsForWorkspace.filter(
      (entry?: any) : any => entry?.payload?.action === "file.materialize"
    );
  };
  fixture.workspaceCheckpointTrees = async () : Promise<any> => {
    const projection: any =
      fixture.substrate.checkpointTreeProjection;
    const summaries: any = await projection.listCheckpointTrees({
      limit: 100,
      ownerId: fixture.workspace.workspaceId
    });
    const trees: any = await Promise.all(
      summaries.map((summary?: any) : any =>
        projection.loadCheckpointTree({
          treeId: summary.treeId
        })
      )
    );
    return trees
      .filter(Boolean)
      .sort((left?: any, right?: any) : any =>
        left.treeId.localeCompare(right.treeId)
      );
  };
  fixture.close = async () : Promise<any> => {
    await fixture.closeRuntimes();
    await closePersistentResources();
    lockManager.destroy();
    await fs.rm(root, { recursive: true, force: true });
  };

  await openPersistentResources({ initialize: true });
  await fixture.ensureTargetParent();
  fixture.resetEffects();
  cleanupTasks.push(() : any => fixture.close());
  return fixture;
}

async function createCompletedUpload(
  fixture?: any,
  bytes?: any,
  seed: any = "single-file",
  owner: any = fixture.owner
) : Promise<any> {
  const created: any =
    await fixture.uploadSessionStore.createOrResumeUploadSession({
      checkpoint: {
        archiveBatchId: `archive-${seed}`,
        checkpointId: `checkpoint-${seed}`,
        clientUid: `client-${seed}`,
        sourceType: "upload"
      },
      files: [{
        byteSize: bytes.length,
        mediaType: "application/octet-stream",
        relativePath: "payload.bin",
        sha256: sha256(bytes)
      }],
      manifest: {
        inputDigest: sha256(`input:${seed}`),
        manifestDigest: sha256(`manifest:${seed}`)
      },
      owner
    });
  for (
    let offset: any = 0;
    offset < bytes.length;
    offset += MAX_PLAINTEXT_WINDOW
  ) {
    const appended: any =
      await fixture.uploadSessionStore.appendUploadSessionChunk({
        buffer: bytes.subarray(
          offset,
          Math.min(
            bytes.length,
            offset + MAX_PLAINTEXT_WINDOW
          )
        ),
        fileIndex: 0,
        offset,
        owner,
        sessionId: created.sessionId
      });
    expect(appended.ok).toBe(true);
  }
  const files: any =
    await fixture.uploadSessionStore.resolveUploadSessionFiles(
      created.sessionId,
      { owner }
    );
  expect(files).toHaveLength(1);
  expect(files[0]).toMatchObject({
    byteSize: bytes.length,
    contentDigest: sha256(bytes),
    custodyRef: expect.stringMatching(/^custody:/u),
    custodyState: "sealed_no_run",
    envelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u)
  });
  return Object.freeze({
    descriptor: files[0],
    sessionId: created.sessionId
  });
}

async function workspaceRevision(
  fixture?: any,
  workspaceId: any = fixture.workspace.workspaceId,
  actorUserId: any = fixture.owner.subjectId
) : Promise<any> {
  const current: any =
    await fixture.agentWorkspace.workspaceFileRevision({
      actorUserId,
      workspaceId
    });
  expect(current.ok).toBe(true);
  return current.revision;
}

async function listBoundSucceededMaterializationReceipts(
  operationProofSubstrate: any,
  { intentId, workspaceId }: Record<string, any>
) : Promise<any> {
  const receipts: any = await operationProofSubstrate.listReceipts({
    limit: 10_000
  });
  return receipts.filter(
    (entry?: any) : any =>
      entry?.operationId === OPERATION_ID &&
      entry?.status === "succeeded" &&
      entry?.workspaceId === workspaceId &&
      entry?.pactium?.intentId === intentId
  );
}

async function submitMaterialization(
  fixture?: any,
  runtime?: any,
  upload?: any,
  {
    expectedWorkspaceRevision = "",
    logicalTarget = DEFAULT_LOGICAL_TARGET,
    extraInput = {}
  }: Record<string, any> = {}
) : Promise<any> {
  await fixture.ensureTargetParent(logicalTarget);
  const response: any = responseRecorder();
  const request: any = consoleRequest({
    cookie: authCookieHeader(fixture.loginResult),
    csrf: fixture.loginResult.csrfToken
  });
  const input: Record<string, any> = {
    expectedWorkspaceRevision:
      expectedWorkspaceRevision ||
      await workspaceRevision(fixture),
    logicalTarget,
    safetyConfirm: true,
    uploadSessionId: upload.sessionId,
    workspaceId: fixture.workspace.workspaceId,
    ...extraInput
  };
  const dispatched: any = await dispatchRegisteredHttpOperation({
    authorizeOperation:
      fixture.securityPermissions.authorizeOperation,
    concurrencyScope:
      "upload-materialization-acceptance",
    controllers: { jobs: runtime.handlers },
    method: "POST",
    lockManager: fixture.lockManager,
    operationAuditStore: fixture.operationAuditStore,
    operationProofSubstrate:
      fixture.operationProofSubstrate,
    operations: [fixture.operationAuthority],
    routeIndex: createOperationRouteIndex([fixture.operationAuthority], { strict: true }),
    request,
    requestBody: Buffer.from(JSON.stringify(input)),
    response,
    url: new URL(MATERIALIZATION_PATH, "http://console.local")
  });
  expect(dispatched).toBe(true);
  return Object.freeze({
    input,
    payload: response.json(),
    request,
    response
  });
}

async function dispatchUntilTerminal(
  runtime?: any,
  requestRef?: any,
  { attempts = 100 }: Record<string, any> = {}
) : Promise<any> {
  let record: any = null;
  for (let attempt: any = 0; attempt < attempts; attempt += 1) {
    await runtime.queueGate.dispatch();
    record = await runtime.provider.get(requestRef);
    if (terminalStatus(record)) return record;
    await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
  }
  const workItemId: any = record?.bindingDigest
    ? `materialization-work:${record.bindingDigest}`
    : "";
  const inspection: any = workItemId
    ? await runtime.queueStore.inspect({
        includeJournal: true,
        workItemId
      })
    : null;
  const lastError: any = inspection?.workItem?.lastError || {};
  throw new Error(
    [
      "Materialization queue did not reach a terminal state",
      `(status=${safeDiagnosticToken(record?.status)},`,
      `stage=${safeDiagnosticToken(record?.stage)},`,
      `errorCode=${safeDiagnosticToken(record?.error?.code)},`,
      `queueErrorCode=${safeDiagnosticToken(lastError.code)},`,
      `queueErrorClass=${safeDiagnosticToken(lastError.name)}).`
    ].join(" ")
  );
}

async function dispatchUntilQueueCompleted(
  runtime?: any,
  workItemId?: any,
  { attempts = 100 }: Record<string, any> = {}
) : Promise<any> {
  for (let attempt: any = 0; attempt < attempts; attempt += 1) {
    await runtime.queueGate.dispatch();
    const inspection: any = await runtime.queueGate.observe({
      includeJournal: true,
      workItemId
    });
    if (inspection.workItem?.state === "completed") {
      return inspection;
    }
    await new Promise((resolve?: any) : any => setTimeout(resolve, 20));
  }
  throw new Error(
    "Materialization queue did not acknowledge its terminal transaction."
  );
}

async function lstatOrMissing(candidate?: any) : Promise<any> {
  try {
    return await fs.lstat(candidate);
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function createFifo(candidate?: any) : Promise<any> {
  await new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn("mkfifo", [candidate], {
      stdio: "ignore"
    });
    child.once("error", reject);
    child.once("exit", (code?: any, signal?: any) : any => {
      if (code === 0 && signal === null) resolve();
      else {
        reject(new Error(
          `mkfifo failed (code=${code}, signal=${signal || "none"}).`
        ));
      }
    });
  });
}

async function createUnixSocket(candidate?: any) : Promise<any> {
  const server: any = net.createServer();
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(candidate, resolve);
  });
  cleanupTasks.push(() : any => new Promise((resolve?: any) : any =>
    server.close(() : any => resolve())
  ));
}

async function fileIdentitySnapshot(candidate?: any) : Promise<any> {
  const stat: any = await fs.lstat(candidate, { bigint: true });
  return Object.freeze({
    birthtimeNs: String(stat.birthtimeNs),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode),
    nlink: Number(stat.nlink),
    size: Number(stat.size)
  });
}

async function protectedDirectorySnapshot(directory?: any) : Promise<any> {
  const entries: any = (await fs.readdir(directory)).sort();
  return Object.freeze({
    identity: await fileIdentitySnapshot(directory),
    entries: await Promise.all(entries.map(async (name?: any) : Promise<any> => {
      const candidate: any = path.join(directory, name);
      const stat: any = await fs.lstat(candidate);
      return Object.freeze({
        contentDigest: stat.isFile()
          ? sha256(await fs.readFile(candidate))
          : "",
        identity: await fileIdentitySnapshot(candidate),
        name
      });
    }))
  });
}

async function inspectPrivatePackageSubpath() : Promise<any> {
  const packageSubpath: any = [
    "@meshrix/agents",
    "agent-workspace",
    "agent-workspace-materialization"
  ].join("/");
  const source: any = [
    `import(${JSON.stringify(packageSubpath)})`,
    ".then(() => process.exit(2))",
    ".catch((error) => process.exit(",
    "error?.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED' ? 0 : 3",
    "))"
  ].join("");
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(
      process.execPath,
      ["--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        stdio: "ignore"
      }
    );
    child.once("error", reject);
    child.once("exit", (code?: any, signal?: any) : any => {
      resolve(Object.freeze({ code, signal }));
    });
  });
}

async function spawnCrashChild(
  root?: any,
  crashStage?: any,
  { admission = null }: Record<string, any> = {}
) : Promise<any> {
  const captureSuffix: any = sha256(
    `${crashStage}:${Date.now()}:${Math.random()}`
  ).slice(0, 16);
  const stdoutPath: any = path.join(
    root,
    `.materialization-crash-${captureSuffix}.stdout`
  );
  const stderrPath: any = path.join(
    root,
    `.materialization-crash-${captureSuffix}.stderr`
  );
  const stdoutFd: any = fsSync.openSync(stdoutPath, "wx", 0o600);
  const stderrFd: any = fsSync.openSync(stderrPath, "wx", 0o600);
  let captureFdsClosed: any = false;
  const closeCaptureFds: any = () : any => {
    if (captureFdsClosed) return;
    captureFdsClosed = true;
    fsSync.closeSync(stdoutFd);
    fsSync.closeSync(stderrFd);
  };
  let child: any;
  try {
    child = fork(crashChildPath, [], {
      detached: POSIX,
      env: {
        LANG: "C"
      },
      execArgv: ["--no-warnings", "--conditions=source"],
      serialization: "advanced",
      stdio: [
        "ignore",
        stdoutFd,
        stderrFd,
        "ipc"
      ]
    });
  } catch (error: any) {
    closeCaptureFds();
    throw error;
  }
  // The child owns duplicated descriptors after fork. Keeping the parent's
  // copies open across the crash matrix leaks two descriptors per case and can
  // starve later children under the complete suite.
  closeCaptureFds();
  retainedCrashChildren.push(child);
  const terminateCrashUnit: any = () : any => {
    if (
      POSIX &&
      Number.isSafeInteger(child.pid) &&
      child.pid > 1
    ) {
      try {
        process.kill(-child.pid, "SIGKILL");
        return;
      } catch (error: any) {
        if (error?.code !== "ESRCH" && error?.code !== "EPERM") throw error;
      }
    }
    child.kill("SIGKILL");
  };
  const childExited: any = new Promise((resolve?: any) : any => {
    child.once("exit", (code?: any, signal?: any) : any => resolve([code, signal]));
  });
  cleanupTasks.push(async () : Promise<any> => {
    if (child.exitCode === null && child.signalCode === null) {
      terminateCrashUnit();
    }
    await childExited;
  });
  let prematureExitHandler: any;
  const marker: any = await new Promise((resolve?: any, reject?: any) : any => {
    // This timer owns IPC liveness only. Heartbeats re-arm it while the
    // child's independent progress watchdog requires named materialization
    // milestones and reports child_crash_stage_not_reached for a live stall.
    let readinessTimer: any = null;
    let onMessage: any = null;
    const clearReadiness: any = () : any => {
      if (readinessTimer) clearTimeout(readinessTimer);
      readinessTimer = null;
    };
    const armReadiness: any = () : any => {
      clearReadiness();
      readinessTimer = setTimeout(() : any => {
        if (onMessage) child.off("message", onMessage);
        reject(new Error("Crash child readiness timed out."));
      }, 300_000);
    };
    onMessage = (value?: any) : any => {
      if (value?.kind === "heartbeat") {
        armReadiness();
        return;
      }
      clearReadiness();
      child.off("message", onMessage);
      if (value?.kind === "ready") {
        resolve(value);
        return;
      }
      const failureCode: any =
        /^[a-z0-9][a-z0-9._:-]{0,79}$/u.test(
          String(value?.code || "")
        )
          ? value.code
          : "child_failure";
      reject(Object.assign(
        new Error(
          `Crash child failed before readiness (${failureCode}).`
        ),
        { code: failureCode }
      ));
    };
    prematureExitHandler = (code?: any, signal?: any) : any => {
      clearReadiness();
      child.off("message", onMessage);
      void (async () : Promise<any> => {
        let stdout: any = Buffer.alloc(0);
        let stderr: any = Buffer.alloc(0);
        try {
          [stdout, stderr] = await Promise.all([
            fs.readFile(stdoutPath),
            fs.readFile(stderrPath)
          ]);
        } catch (error) {
          // Capture files are best-effort diagnostics for the failure.
        }
        reject(new Error(
          [
            "Crash child exited before readiness",
            `(code=${Number.isInteger(code) ? code : "none"},`,
            `signal=${signal || "none"},`,
            `stdoutBytes=${stdout.byteLength},`,
            `stderrBytes=${stderr.byteLength}).`
          ].join(" ")
        ));
      })();
    };
    armReadiness();
    child.on("message", onMessage);
    child.once("exit", prematureExitHandler);
    child.send({
      ...(admission ? { admission } : {}),
      crashStage,
      root
    });
  });
  child.off("exit", prematureExitHandler);
  expect(Object.keys(marker).sort()).toEqual([
    "archiveWrites",
    "code",
    "custodyReads",
    "finalPermits",
    "kind",
    "queueClaims",
    "stage",
    "stateCommits"
  ]);
  expect(Buffer.byteLength(JSON.stringify(marker), "utf8"))
    .toBeLessThanOrEqual(512);
  child.disconnect();
  await once(child, "disconnect");
  terminateCrashUnit();
  const [, signal] = await childExited;
  const [stdout, stderr] = await Promise.all([
    fs.readFile(stdoutPath),
    fs.readFile(stderrPath)
  ]);
  expect(signal).toBe("SIGKILL");
  expect(stdout).toHaveLength(0);
  expect(stderr).toHaveLength(0);
  return marker;
}

async function waitForExpiredCrashLeases() : Promise<any> {
  await new Promise((resolve?: any) : any =>
    setTimeout(resolve, CRASH_LEASE_MS + 150)
  );
}

async function acknowledgeTerminatedCrashExecution(
  root?: any,
  workItemId?: any
) : Promise<any> {
  const store: any = createSqliteWorkQueueStore({
    userDataPath: root,
    policy: { leaseTimeoutMs: CRASH_LEASE_MS }
  });
  try {
    const before: any = store.inspect({
      includeJournal: true,
      workItemId
    });
    expect(before.workItem).toMatchObject({
      state: "running",
      lease: {
        leaseId: expect.any(String),
        leaseSeq: expect.any(Number)
      }
    });
    const terminatedLease: Readonly<Record<string, any>> = Object.freeze({
      leaseId: before.workItem.lease.leaseId,
      leaseSeq: before.workItem.lease.leaseSeq
    });
    const interrupted: any = store.markInDoubt({
      workItemId,
      leaseId: terminatedLease.leaseId,
      reason: "isolated_execution_terminated",
      error: {
        type: "isolated_execution_terminated"
      }
    });
    expect(interrupted).toMatchObject({
      interrupted: true,
      idempotent: false,
      workItem: {
        state: "in_doubt",
        lease: terminatedLease
      }
    });
    const acknowledged: any = store.acknowledgeTermination({
      workItemId,
      leaseId: terminatedLease.leaseId,
      toState: "retry",
      delayMs: 0,
      reason: "isolated_execution_termination_acknowledged",
      error: {
        type: "isolated_execution_termination_acknowledged"
      }
    });
    expect(acknowledged).toMatchObject({
      acknowledged: true,
      idempotent: false,
      toState: "queued",
      workItem: {
        state: "queued",
        lease: null
      }
    });
    expect(store.acknowledgeTermination({
      workItemId,
      leaseId: terminatedLease.leaseId,
      toState: "retry",
      delayMs: 0,
      reason: "isolated_execution_termination_acknowledged"
    })).toMatchObject({
      acknowledged: false,
      idempotent: true,
      workItem: {
        state: "queued"
      }
    });
    const after: any = store.inspect({
      includeJournal: true,
      workItemId
    });
    expect(after.journal.slice(-2).map(
      (entry?: any) : any => entry.transition
    )).toEqual([
      "interrupt",
      "termination_acknowledged"
    ]);
    return terminatedLease;
  } finally {
    await store.close?.();
  }
}

async function expectTerminatedQueueRecovery(runtime?: any, bindingDigest?: any) : Promise<any> {
  const workItemId: any = `materialization-work:${bindingDigest}`;
  expect(runtime.queueGate.recoveredWorkItemIds())
    .not.toContain(workItemId);
  const inspection: any = await runtime.queueGate.observe({
    includeJournal: true,
    workItemId
  });
  const journal: any = inspection.journal.map((entry?: any) : any =>
    Object.freeze({
      reason: entry.reason,
      transition: entry.transition
    })
  );
  const transitions: any = journal.map((entry?: any) : any => entry.transition);
  if (transitions.includes("retention_snapshot")) {
    expect(transitions[0]).toBe("retention_snapshot");
    expect(
      transitions.filter(
        (entry?: any) : any => entry === "retention_snapshot"
      )
    ).toHaveLength(1);
    const retainedTail: any = transitions.slice(1);
    expect(
      retainedTail.every(
        (entry?: any) : any =>
          entry === "progress" || entry === "complete"
      )
    ).toBe(true);
    // Lease-maintenance journal entries are not materialization progress:
    // periodic worker renewals, engine lease heartbeats, and the terminal
    // lease fence the worker records before applying the handler outcome.
    // Under host load any of them can repeat, while genuine progress
    // reasons must stay within the bounded-recovery invariant below.
    const leaseMaintenanceReasons: any = new Set<any>([
      "lease_renewal",
      "materialization_lease_heartbeat",
      "handler_terminal_fence"
    ]);
    const retainedProgress: any = journal.slice(1).filter(
      (entry?: any) : any =>
        entry.transition === "progress" &&
        !leaseMaintenanceReasons.has(entry.reason)
    );
    expect(
      retainedProgress.length,
      `recovery journal: ${journal
        .slice(1)
        .slice(0, 40)
        .map((entry?: any) : any =>
          `${entry.transition}:${entry.reason || ""}:${entry.operationId || ""}`
        )
        .join("|")}`
    ).toBeLessThanOrEqual(16);
    if (retainedTail.length === 0) {
      if (inspection.workItem !== null) {
        expect(inspection.workItem.state).toBe("completed");
      }
      return;
    }
    expect(inspection.workItem.state).toBe("completed");
    expect(
      retainedTail.filter((entry?: any) : any => entry === "complete")
    ).toHaveLength(1);
    expect(retainedTail.at(-1)).toBe("complete");
    return;
  }
  expect(transitions[0]).toBe("enqueue");
  expect(
    transitions.filter((entry?: any) : any => entry === "interrupt")
  ).toHaveLength(1);
  expect(
    transitions.filter(
      (entry?: any) : any =>
        entry === "termination_acknowledged"
    )
  ).toHaveLength(1);
  expect(transitions).not.toContain("lease_expired");
  const acknowledgedAt: any =
    transitions.indexOf("termination_acknowledged");
  expect(
    transitions.slice(acknowledgedAt + 1),
    `terminated queue recovery transitions: ${transitions.join(" -> ")}`
  ).toContain("claim");
  expect(transitions.at(-1)).toBe("complete");
}

function createExecutableLookingPayload() : any {
  const bytes: any = Buffer.alloc(1024 * 1024 + 257, 0x90);
  Buffer.from(
    "#!/bin/sh\nprintf 'opaque-upload-must-remain-inert'\n",
    "utf8"
  ).copy(bytes, 0);
  Buffer.from("MZ", "ascii").copy(bytes, 4096);
  return bytes;
}

function custodyStreamFault(kind?: any) : any {
  return (stream?: any) : any => (
    async function* faultedCustodyStream() : AsyncGenerator<any, any, any> {
      let changed: any = false;
      for await (const value of stream) {
        const chunk: any = Buffer.isBuffer(value)
          ? value
          : Buffer.from(value);
        if (!changed && kind === "truncated") {
          changed = true;
          if (chunk.byteLength > 1) {
            yield chunk.subarray(0, chunk.byteLength - 1);
          }
          continue;
        }
        if (!changed && kind === "corrupted") {
          changed = true;
          const corrupted: any = Buffer.from(chunk);
          corrupted[0] ^= 0xff;
          yield corrupted;
          continue;
        }
        yield chunk;
      }
      if (kind === "excess") {
        yield Buffer.from([0xff]);
      }
    }
  )();
}

function snapshotDatabaseLayout(db?: any) : any {
  const tables: any = db.prepare(`
    SELECT type, name, sql
    FROM sqlite_master
    WHERE name LIKE 'materialization_%' OR
          name = 'idx_materialization_requests_reconcile'
    ORDER BY type, name
  `).all();
  const columns: any = db.prepare(
    "PRAGMA table_info(materialization_requests)"
  ).all();
  const rows: any = columns.length > 0
    ? db.prepare(
        "SELECT * FROM materialization_requests ORDER BY request_ref"
      ).all()
    : [];
  return JSON.stringify({
    columns,
    rows,
    tables,
    userVersion: Number(
      db.pragma("user_version", { simple: true }) || 0
    )
  });
}

function seedCurrentLayoutRows(
  root?: any,
  rows?: any,
  { unversioned = false }: Record<string, any> = {}
) : any {
  const initialized: any =
    createUploadWorkspaceMaterializationTransactionStore({
      userDataPath: root
    });
  initialized.close();
  const db: any = openSqliteDatabase(
    transactionDatabasePath(root)
  );
  const columns: any = db.prepare(
    "PRAGMA table_info(materialization_requests)"
  ).all().map((entry?: any) : any => entry.name);
  const insert: any = db.prepare(`
    INSERT INTO materialization_requests (
      ${columns.join(", ")}
    ) VALUES (
      ${columns.map(() : any => "?").join(", ")}
    )
  `);
  db.prepare(
    "DELETE FROM materialization_requests"
  ).run();
  for (const row of rows) {
    insert.run(...columns.map((column?: any) : any => row[column]));
  }
  if (unversioned) {
    db.exec(`
      DROP TABLE materialization_schema_meta;
      DROP INDEX idx_materialization_requests_reconcile;
    `);
    db.pragma("user_version = 0");
  }
  db.close();
}

afterEach(async () : Promise<any> => {
  vi.restoreAllMocks();
  while (cleanupTasks.length > 0) {
    await cleanupTasks.pop()();
  }
});

describe(
  "opaque upload custody to governed workspace materialization",
  () : any => {
    it("keeps root-owned materialization authority private and rejects legacy capture or shape-compatible substitutes before state", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const reflected: any = new Set<any>();
      let current: any = fixture.agentWorkspace;
      while (current) {
        for (const key of Reflect.ownKeys(current)) {
          reflected.add(String(key));
        }
        current = Reflect.getPrototypeOf(current);
      }
      expect(
        [...reflected].filter((key?: any) : any =>
          /materializ|captureWorkspaceMaterialization|inspectPublished/iu
            .test(key)
        )
      ).toEqual([]);
      expect(
        Reflect.ownKeys(fixture.compositionRoot).filter((key?: any) : any =>
          /materializationRootAuthority|workspaceMaterializationPort|withRequest/iu
            .test(String(key))
        )
      ).toEqual([]);
      let legacyCapture: any = null;
      const standaloneWorkspace: any = createAgentWorkspace({
        bindPrivateMaterializationPort(port?: any) : any {
          legacyCapture = port;
        },
        userDataPath: path.join(
          fixture.root,
          "legacy-binder-negative"
        )
      });
      expect(legacyCapture).toBeNull();
      expect(
        Reflect.ownKeys(standaloneWorkspace).filter((key?: any) : any =>
          /materializ|withRequest/iu.test(String(key))
        )
      ).toEqual([]);
      await standaloneWorkspace.close();

      await expect(inspectPrivatePackageSubpath()).resolves.toEqual({
        code: 0,
        signal: null
      });
      await expect(
        fixture.compositionRoot
          .createBoundUploadWorkspaceMaterializationProvider({
            workspaceMaterializationPort: Object.freeze({
              async withRequest() : Promise<any> {}
            })
          })
      ).rejects.toThrow(
        /workspace materialization port injection is forbidden/iu
      );

      const transactionStore: any =
        createUploadWorkspaceMaterializationTransactionStore({
          userDataPath: fixture.root
        });
      const registerQueue: any = vi.fn();
      const common: Record<string, any> = {
        deferredProtectedSinkAuthorityPort:
          fixture.deferredAuthorityPort,
        operationAuditStore: fixture.operationAuditStore,
        operationProofSubstrate:
          fixture.operationProofSubstrate,
        queueApplicationPort: { registerQueue },
        resolveOperation: () : any => fixture.operationAuthority,
        transactionStore,
        uploadCustodyReadPort: fixture.noRunCustody.readPort,
        uploadSessionStore: fixture.uploadSessionStore,
        userDataPath: fixture.root
      };
      await expect(
        createUploadWorkspaceMaterializationProvider({
          ...common,
          workspaceMaterializationPort: fixture.agentWorkspace
        })
      ).rejects.toThrow(
        /composition-issued agent workspace materialization port/iu
      );
      await expect(
        createUploadWorkspaceMaterializationProvider({
          ...common,
          workspaceMaterializationPort: Object.freeze({
            async withRequest(_binding?: any, task?: any) : Promise<any> {
              return task(Object.freeze({}));
            }
          })
        })
      ).rejects.toThrow(
        /composition-issued agent workspace materialization port/iu
      );
      expect(registerQueue).not.toHaveBeenCalled();
      expect(transactionStore.count()).toBe(0);
      transactionStore.close();
    });

    itPosix("rejects a pre-existing agent-workspaces symlink before database creation or external-neighbor mutation", async () : Promise<any> => {
      const caseRoot: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-agent-workspace-root-symlink-")
      );
      cleanupTasks.push(() : any =>
        fs.rm(caseRoot, { recursive: true, force: true })
      );
      const dataRoot: any = path.join(caseRoot, "data");
      const externalNeighbor: any = path.join(
        caseRoot,
        "external-neighbor"
      );
      await fs.mkdir(dataRoot, { mode: 0o700 });
      await fs.mkdir(externalNeighbor, { mode: 0o750 });
      const sentinel: any = path.join(externalNeighbor, "sentinel.bin");
      await fs.writeFile(
        sentinel,
        Buffer.from("external-neighbor-must-remain-opaque", "utf8"),
        { mode: 0o640 }
      );
      await fs.chmod(externalNeighbor, 0o750);
      await fs.chmod(sentinel, 0o640);
      const privateRootLink: any = path.join(
        dataRoot,
        "agent-workspaces"
      );
      await fs.symlink(externalNeighbor, privateRootLink);
      const dataRootBefore: any =
        await protectedDirectorySnapshot(dataRoot);
      const externalBefore: any =
        await protectedDirectorySnapshot(externalNeighbor);
      const linkBefore: any =
        await fileIdentitySnapshot(privateRootLink);

      let unsafeWorkspace: any = null;
      let initializationError: any = null;
      try {
        unsafeWorkspace = createAgentWorkspace({
          defaultCanAccessAll: true,
          userDataPath: dataRoot
        });
      } catch (error: any) {
        initializationError = error;
      }
      await unsafeWorkspace?.close?.();

      expect(initializationError).toMatchObject({
        code: "agent_workspace_private_directory_unsafe",
        status: 409
      });
      expect(await protectedDirectorySnapshot(dataRoot))
        .toEqual(dataRootBefore);
      expect(await protectedDirectorySnapshot(externalNeighbor))
        .toEqual(externalBefore);
      expect(await fileIdentitySnapshot(privateRootLink))
        .toEqual(linkBefore);
      expect((await fs.lstat(privateRootLink)).isSymbolicLink())
        .toBe(true);
      await expect(
        fs.lstat(path.join(externalNeighbor, "agent-workspace.sqlite"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    itPosix("rejects createWorkspaceFolder through a workspace-child symlink before database, chmod, or external-neighbor writes", async () : Promise<any> => {
      const caseRoot: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-workspace-child-symlink-")
      );
      let workspaceRuntime: any = null;
      cleanupTasks.push(async () : Promise<any> => {
        try {
          await workspaceRuntime?.close?.();
        } catch {
          // Preserve the acceptance failure while still removing the fixture.
        }
        await fs.rm(caseRoot, { recursive: true, force: true });
      });
      const dataRoot: any = path.join(caseRoot, "data");
      const externalNeighbor: any = path.join(
        caseRoot,
        "external-neighbor"
      );
      await fs.mkdir(dataRoot, { mode: 0o700 });
      await fs.mkdir(externalNeighbor, { mode: 0o750 });
      const sentinel: any = path.join(externalNeighbor, "sentinel.bin");
      await fs.writeFile(
        sentinel,
        Buffer.from("workspace-child-must-not-follow", "utf8"),
        { mode: 0o640 }
      );
      await fs.chmod(externalNeighbor, 0o750);
      await fs.chmod(sentinel, 0o640);
      workspaceRuntime = createAgentWorkspace({
        defaultCanAccessAll: true,
        userDataPath: dataRoot
      });
      const workspace: any = workspaceRuntime.createWorkspace({
        title: "Workspace child symlink rejection"
      }).workspace;
      const workspaceRoot: any = path.join(
        dataRoot,
        "agent-workspaces",
        "folders",
        stableId("workspace-folder", workspace.workspaceId)
      );
      const redirectedParent: any = path.join(
        workspaceRoot,
        "redirected-parent"
      );
      await fs.symlink(externalNeighbor, redirectedParent);
      const workspaceRowBefore: any = readRawAgentWorkspaceRow(
        dataRoot,
        workspace.workspaceId
      );
      const workspaceRootBefore: any =
        await protectedDirectorySnapshot(workspaceRoot);
      const externalBefore: any =
        await protectedDirectorySnapshot(externalNeighbor);
      const linkBefore: any =
        await fileIdentitySnapshot(redirectedParent);

      const rejected: any =
        await workspaceRuntime.createWorkspaceFolder({
          folderPath: "redirected-parent/forbidden-child",
          workspaceId: workspace.workspaceId
        });

      expect(rejected).toMatchObject({
        ok: false,
        status: 400
      });
      expect(rejected.error).toMatch(
        /符号链接/u
      );
      expect(readRawAgentWorkspaceRow(
        dataRoot,
        workspace.workspaceId
      )).toEqual(workspaceRowBefore);
      expect(await protectedDirectorySnapshot(workspaceRoot))
        .toEqual(workspaceRootBefore);
      expect(await protectedDirectorySnapshot(externalNeighbor))
        .toEqual(externalBefore);
      expect(await fileIdentitySnapshot(redirectedParent))
        .toEqual(linkBefore);
      expect((await fs.lstat(redirectedParent)).isSymbolicLink())
        .toBe(true);
      await expect(
        fs.lstat(path.join(externalNeighbor, "forbidden-child"))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("admits only the canonical logical target and denies changed authority after bounded precommit reads but before protected effects", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const upload: any = await createCompletedUpload(
        fixture,
        Buffer.from("closed-admission", "utf8"),
        "closed-admission"
      );
      const admissionRevision: any = await workspaceRevision(fixture);
      for (const [field, value] of [
        ["mutation", {
          files: [{
            sourcePath: "payload.bin",
            targetPath: DEFAULT_LOGICAL_TARGET
          }]
        }],
        ["custodyRef", upload.descriptor.custodyRef],
        ["permit", "caller-supplied-permit"],
        ["absolutePath", "/not-an-admissible-target"]
      ]) {
        fixture.resetEffects();
        const rejected: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          {
            expectedWorkspaceRevision: admissionRevision,
            extraInput: { [field]: value }
          }
        );
        expect(rejected.response.statusCode).toBe(400);
        expect(runtime.transactionStore.count()).toBe(0);
        expect(safeEffectCounts(fixture)).toEqual({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          maxPlaintextChunk: 0,
          queueClaims: 0,
          stateCommits: 0,
          workspaceReads: 0
        });
      }

      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { expectedWorkspaceRevision: admissionRevision }
      );
      expect(admitted.response.statusCode).toBe(202);
      const record: any = await runtime.transactionStore.get(
        admitted.payload.requestRef
      );
      expect(record).toMatchObject({
        logicalTarget: DEFAULT_LOGICAL_TARGET,
        status: "queued",
        descriptor: {
          byteCount: upload.descriptor.byteSize,
          contentDigest: upload.descriptor.contentDigest,
          custodyRef: upload.descriptor.custodyRef,
          envelopeDigest: upload.descriptor.envelopeDigest,
          state: "sealed_no_run"
        }
      });

      await fixture.consoleAuth.updateUser(
        fixture.owner.subjectId,
        { roleId: "viewer" }
      );
      fixture.resetEffects();
      const denied: any = await dispatchUntilTerminal(
        runtime,
        admitted.payload.requestRef
      );
      expect(denied).toMatchObject({
        evidence: null,
        publication: null,
        stage: "admitted",
        status: "failed"
      });
      expect(safeEffectCounts(fixture)).toEqual({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 0,
        maxPlaintextChunk: 0,
        queueClaims: 1,
        stateCommits: 0,
        workspaceReads: 13
      });
      expect(fixture.counters.workspaceReadKinds).toEqual([
        "state.begin",
        "state.begin",
        "event.list",
        "state.begin",
        "event.list",
        "state.begin",
        "event.list",
        "state.begin",
        "event.list",
        "state.begin",
        "event.list",
        "state.begin",
        "event.list"
      ]);
      await expect(
        fs.lstat(path.join(
          fixture.workspaceRoot,
          DEFAULT_LOGICAL_TARGET
        ))
      ).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("recursively rejects every caller-supplied descriptor, byte, key, token, permit, receipt, allow, and path alias before authority capture, transaction creation, or enqueue", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const upload: any = await createCompletedUpload(
        fixture,
        Buffer.from("recursive-closed-admission", "utf8"),
        "recursive-closed-admission"
      );
      const expectedWorkspaceRevision: any =
        await workspaceRevision(fixture);
      const aliases: any = (Object.entries(
        FORBIDDEN_ADMISSION_ALIAS_GROUPS
      ) as [string, any][]).flatMap(([group, fields]: any[]) : any =>
        fields.flatMap((field?: any) : any => [
          Object.freeze({
            field,
            group,
            input: { [field]: `caller-${group}` }
          }),
          Object.freeze({
            field,
            group,
            input: {
              confirm: {
                envelope: [{
                  facts: {
                    [field]: `caller-${group}`
                  }
                }]
              }
            }
          })
        ])
      );

      for (const candidate of aliases) {
        fixture.resetEffects();
        const rejected: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          {
            expectedWorkspaceRevision,
            extraInput: candidate.input
          }
        );
        expect(
          rejected.response.statusCode,
          `${candidate.group}:${candidate.field}`
        ).toBe(400);
        expect(
          runtime.transactionStore.count(),
          `${candidate.group}:${candidate.field}`
        ).toBe(0);
        expect({
          authorityCaptures: fixture.counters.authorityCaptures,
          queueEnqueues: fixture.counters.queueEnqueues,
          transactionCreates: fixture.counters.transactionCreates
        }).toEqual({
          authorityCaptures: 0,
          queueEnqueues: 0,
          transactionCreates: 0
        });
        expect(safeEffectCounts(fixture)).toEqual({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          maxPlaintextChunk: 0,
          queueClaims: 0,
          stateCommits: 0,
          workspaceReads: 0
        });
      }
    }, 90_000);

    it.each([
      "subject",
      "workload",
      "grant-role",
      "policy",
      "approval",
      "revocation",
      "risk",
      "operation",
      "resource"
    ])(
      "denies real current %s fact drift before the final permit without publication WAL, custody, plaintext, or temp state",
      async (fact?: any) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `current-authority-drift:${fact}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `current-authority-drift-${fact}`
        );
        const logicalTarget: any =
          `current-authority-drift/${fact}.bin`;
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          { logicalTarget }
        );
        const admittedRecord: any = await runtime.transactionStore.get(
          admitted.payload.requestRef
        );

        fixture.faultHooks
          .afterDirectoryWorkerBoundBeforeReserve =
          async () : Promise<any> => {
            if (fact === "subject") {
              await fixture.consoleAuth.updateUser(
                fixture.owner.subjectId,
                { attributes: { authorityGeneration: "changed" } }
              );
            } else if (fact === "workload") {
              fixture.consoleAuth.revokeSession(
                fixture.loginResult.session.sessionId
              );
            } else if (fact === "grant-role") {
              await fixture.consoleAuth.updateUser(
                fixture.owner.subjectId,
                { roleId: "viewer" }
              );
            } else if (fact === "policy") {
              fixture.consoleAuth.authorizationGovernanceStore
                .upsertUserPolicy({
                  enabled: true,
                  resourcePolicies: [],
                  roleIds: ["owner"],
                  userId: fixture.owner.subjectId
                });
            } else if (fact === "approval") {
              fixture.operationAuthority.safety.approvalScope =
                "changed-approval-scope";
            } else if (fact === "revocation") {
              await fixture.deferredAuthorityPort.revoke({
                authorityRef: admittedRecord.authorityRef,
                reason: "acceptance_revocation_drift"
              });
            } else if (fact === "risk") {
              fixture.operationAuthority.safety.risk =
                fixture.operationAuthority.safety.risk === "safe_write"
                  ? "destructive"
                  : "safe_write";
            } else if (fact === "operation") {
              fixture.operationAuthority.id =
                `${OPERATION_ID}.changed`;
            } else {
              fixture.descriptorTransform = (files?: any) : any =>
                files.map((file?: any) : any => Object.freeze({
                  ...file,
                  contentDigest: sha256(
                    "changed-current-resource-descriptor"
                  )
                }));
            }
          };

        fixture.resetEffects();
        const failed: any = fact === "operation"
          ? (
              await runtime.queueGate.dispatch(),
              await runtime.provider.get(
                admitted.payload.requestRef
              )
            )
          : await dispatchUntilTerminal(
              runtime,
              admitted.payload.requestRef
            );
        expect(failed).toMatchObject({
          evidence: null,
          publication: null,
          stage: "admitted",
          status: fact === "operation" ? "queued" : "failed"
        });
        if (fact === "operation") {
          expect(failed.error).toMatchObject({
            code: "materialization_operation_unavailable"
          });
        }
        expect(safeEffectCounts(fixture)).toMatchObject({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          maxPlaintextChunk: 0,
          stateCommits: 0
        });
        expect(fixture.counters.sourceChunks).toEqual([]);
        const target: any = path.join(
          fixture.workspaceRoot,
          logicalTarget
        );
        expect(await lstatOrMissing(target)).toBeNull();
        expect(
          (await fs.readdir(path.dirname(target))).filter(
            (name?: any) : any =>
              name.startsWith(".meshrix-materialization-")
          )
        ).toEqual([]);
        expect(await fixture.materializationEvents())
          .toHaveLength(0);
      },
      90_000
    );

    it("streams one executable-looking opaque object through bounded custody into one private non-executable inode and replays with zero effects", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const bytes: any = createExecutableLookingPayload();
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "bounded-opaque-success"
      );
      const initialRevision: any = await workspaceRevision(fixture);
      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { expectedWorkspaceRevision: initialRevision }
      );
      fixture.resetEffects();
      const completed: any = await dispatchUntilTerminal(
        runtime,
        admitted.payload.requestRef
      );
      expect({
        errorCode: completed.error?.code || "",
        result: completed.result,
        stage: completed.stage,
        status: completed.status
      }).toMatchObject({
        errorCode: "",
        stage: "completed",
        status: "completed",
        result: {
          byteCount: bytes.length,
          contentDigest: sha256(bytes),
          workspaceRevision: expect.any(String),
          auditRef: expect.stringMatching(/^audit:/u),
          proofRef: expect.stringMatching(/^proof:/u)
        }
      });
      expect(completed.result.workspaceRevision)
        .not.toBe(initialRevision);
      expect(Object.keys(completed.evidence).sort()).toEqual([
        "auditCreatedAt",
        "auditId",
        "auditRef",
        "proofOutcomeKey",
        "proofRef",
        "settlementDigest"
      ]);
      expect(fixture.counters.finalPermits).toBe(1);
      expect(fixture.counters.custodyReads).toBe(1);
      expect(fixture.counters.stateCommits).toBe(1);
      expect(fixture.counters.archiveWrites).toBeGreaterThan(0);
      expect(fixture.counters.sourceChunks.length)
        .toBeGreaterThan(1);
      expect(fixture.counters.maxPlaintextChunk)
        .toBeLessThanOrEqual(MAX_PLAINTEXT_WINDOW);
      expect(fixture.counters.maxOutstandingPlaintext)
        .toBeLessThanOrEqual(MAX_PLAINTEXT_WINDOW);
      expect(fixture.counters.outstandingPlaintext).toBe(0);
      expect(
        Math.max(...fixture.counters.sourceChunks)
      ).toBeLessThanOrEqual(MAX_PLAINTEXT_WINDOW);

      const target: any = path.join(
        fixture.workspaceRoot,
        DEFAULT_LOGICAL_TARGET
      );
      expect(await fs.readFile(target)).toEqual(bytes);
      const stat: any = await fs.lstat(target);
      expect(stat.isFile()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      if (POSIX) {
        expect(stat.mode & 0o777).toBe(0o600);
        expect(stat.mode & 0o111).toBe(0);
        expect(stat.nlink).toBe(1);
      }
      expect(
        (await fs.readdir(path.dirname(target))).filter(
          (name?: any) : any =>
            name.startsWith(".meshrix-materialization-")
        )
      ).toEqual([]);

      const materializationEvents: any =
        await fixture.materializationEvents();
      expect(materializationEvents).toHaveLength(1);
      const [event] = materializationEvents;
      expect(Object.keys(event.payload).sort()).toEqual([
        "action",
        "archiveContentRefsDigest",
        "archiveRootCid",
        "contentSha256",
        "pathDigest",
        "publicationId",
        "publicationProofDigest",
        "publishedIdentityDigest",
        "sizeBytes",
        "workspaceId"
      ]);
      expect(event).toMatchObject({
        beforeRoot: initialRevision,
        afterRoot: completed.result.workspaceRevision,
        payload: {
          action: "file.materialize",
          contentSha256: sha256(bytes),
          sizeBytes: bytes.length,
          workspaceId: fixture.workspace.workspaceId
        }
      });
      const auditBeforeReplay: any =
        await fixture.operationAuditStore.getById(
          completed.evidence.auditId
        );
      expect(auditBeforeReplay).toBeTruthy();
      const proofLedgerEventId: any =
        completed.result.proofRef.replace(/^proof:/u, "");
      const proofBeforeReplay: any =
        await fixture.operationProofSubstrate.getReceipt(
          proofLedgerEventId
        );
      expect(proofBeforeReplay).toMatchObject({
        auditId: completed.evidence.auditId,
        idempotencyKey: completed.bindingDigest,
        ledgerEventId: proofLedgerEventId,
        operationId: OPERATION_ID,
        pactium: {
          intentId: expect.any(String),
          intentLedgerEventId: expect.any(String),
          outcomeLedgerEventId: proofLedgerEventId
        },
        proof: {
          lifecycle: "two-stage",
          terminal: true
        },
        receiptRefs: [
          completed.result.checkpointRef
        ],
        status: "succeeded"
      });
      await expect(
        runtime.transactionStore.recordProofFinalized(
          completed.requestRef,
          {
            ownerFence: "stale-completed-owner-fence",
            proofRef: completed.evidence.proofRef,
            settlementDigest:
              completed.evidence.settlementDigest
          }
        )
      ).rejects.toMatchObject({
        code: "materialization_fenced"
      });
      expect(
        await runtime.transactionStore.get(
          completed.requestRef
        )
      ).toEqual(completed);

      const beforeReplay: any = safeEffectCounts(fixture);
      const evidence: any = clone(completed.evidence);
      const completedBeforeReplay: any = clone(completed);
      const rawRowBeforeReplay: any = readRawTransactionRow(
        fixture.root,
        admitted.payload.requestRef
      );
      const queueBeforeReplay: any = await runtime.queueGate.observe({
        includeJournal: true,
        workItemId:
          `materialization-work:${completed.bindingDigest}`
      });
      const checkpointBeforeReplay: any =
        await fixture.workspaceCheckpointTrees();
      const fileBeforeReplay: any =
        await fileIdentitySnapshot(target);
      const contentDigestBeforeReplay: any =
        sha256(await fs.readFile(target));
      const replay: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { expectedWorkspaceRevision: initialRevision }
      );
      expect(replay.response.statusCode).toBe(200);
      expect(replay.payload).toMatchObject({
        deduped: true,
        requestRef: admitted.payload.requestRef,
        result: {
          replayed: true,
          status: "completed"
        }
      });
      expect(safeEffectCounts(fixture)).toEqual(beforeReplay);
      expect(await fixture.materializationEvents())
        .toEqual(materializationEvents);
      expect(await fixture.workspaceCheckpointTrees())
        .toEqual(checkpointBeforeReplay);
      expect(readRawTransactionRow(
        fixture.root,
        admitted.payload.requestRef
      )).toEqual(rawRowBeforeReplay);
      expect(await runtime.queueGate.observe({
        includeJournal: true,
        workItemId:
          `materialization-work:${completed.bindingDigest}`
      })).toEqual(queueBeforeReplay);
      expect(
        await fixture.operationAuditStore.getById(
          completed.evidence.auditId
        )
      ).toEqual(auditBeforeReplay);
      await expect(
        fixture.operationProofSubstrate.getReceipt(
          proofLedgerEventId
        )
      ).resolves.toEqual(proofBeforeReplay);
      expect(await fileIdentitySnapshot(target))
        .toEqual(fileBeforeReplay);
      expect(sha256(await fs.readFile(target)))
        .toBe(contentDigestBeforeReplay);
      expect(
        await runtime.transactionStore.get(
          admitted.payload.requestRef
        )
      ).toEqual(completedBeforeReplay);
      expect(
        (await runtime.transactionStore.get(
          admitted.payload.requestRef
        )).evidence
      ).toEqual(evidence);
    }, 90_000);

    it.each([
      "truncated",
      "excess",
      "corrupted"
    ])(
      "rejects an exact-content %s custody stream and removes its unpublished inode",
      async (faultKind?: any) : Promise<any> => {
        const fixture: any = await createFixture();
        fixture.custodyStreamTransform =
          custodyStreamFault(faultKind);
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.alloc(
          MAX_PLAINTEXT_WINDOW + 257,
          0x63
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `content-${faultKind}`
        );
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          {
            logicalTarget:
              `content-integrity/${faultKind}.bin`
          }
        );
        fixture.resetEffects();
        const failed: any = await dispatchUntilTerminal(
          runtime,
          admitted.payload.requestRef
        );
        expect(failed).toMatchObject({
          error: {
            code: "materialization_upload_digest_mismatch"
          },
          status: "failed"
        });
        expect(safeEffectCounts(fixture)).toMatchObject({
          archiveWrites: 0,
          custodyReads: 1,
          finalPermits: 1,
          stateCommits: 0
        });
        expect(fixture.counters.maxPlaintextChunk)
          .toBeLessThanOrEqual(MAX_PLAINTEXT_WINDOW);
        expect(fixture.counters.maxOutstandingPlaintext)
          .toBeLessThanOrEqual(MAX_PLAINTEXT_WINDOW);
        expect(fixture.counters.outstandingPlaintext).toBe(0);
        const target: any = path.join(
          fixture.workspaceRoot,
          admitted.input.logicalTarget
        );
        expect(await lstatOrMissing(target)).toBeNull();
        expect(
          (await fs.readdir(path.dirname(target))).filter(
            (name?: any) : any =>
              name.startsWith(".meshrix-materialization-")
          )
        ).toEqual([]);
        expect(await fixture.materializationEvents())
          .toHaveLength(0);
      },
      90_000
    );

    itPosix.each(PATH_SENSITIVE_FAULT_SEAMS)(
      "binds the directory worker across %s parent replacement and never touches the replacement target",
      async (faultSeam?: any) : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const bytes: any = Buffer.from(
        "parent-replacement-must-not-escape",
        "utf8"
      );
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "parent-replacement"
      );
      const target: any = path.join(
        fixture.workspaceRoot,
        DEFAULT_LOGICAL_TARGET
      );
      const originalParent: any = path.dirname(target);
      const displacedParent: any = `${originalParent}.displaced`;
      const outsideParent: any = path.join(
        fixture.root,
        "outside-replacement"
      );
      const outsideSentinel: any = path.join(
        outsideParent,
        "sentinel.keep"
      );
      let replaced: any = false;
      fixture.faultHooks[faultSeam] = async () : Promise<any> => {
          if (replaced) return;
          replaced = true;
          await fs.rename(originalParent, displacedParent);
          await fs.mkdir(outsideParent, {
            recursive: true,
            mode: 0o700
          });
          await fs.writeFile(
            outsideSentinel,
            "outside-sentinel",
            { mode: 0o600 }
          );
          await fs.symlink(outsideParent, originalParent);
        };

      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload
      );
      fixture.resetEffects();
      const failed: any = await dispatchUntilTerminal(
        runtime,
        admitted.payload.requestRef
      );
      expect(failed).toMatchObject({
        status: "failed",
        stage: "rollback_incomplete"
      });
      expect(await fs.readFile(outsideSentinel, "utf8"))
        .toBe("outside-sentinel");
      expect(
        await lstatOrMissing(
          path.join(outsideParent, path.basename(target))
        )
      ).toBeNull();
      expect(
        (await fs.readdir(displacedParent)).filter(
          (name?: any) : any =>
            name.startsWith(".meshrix-materialization-")
        )
      ).toEqual([]);
      expect(fixture.counters.stateCommits).toBe(0);
      expect(await fixture.materializationEvents())
        .toHaveLength(0);
      },
      90_000
    );

    itPosix.each(INODE_REPLACEMENT_CASES)(
      "rejects $subject $replacement replacement at $faultSeam without state publication",
      async ({ faultSeam, replacement, subject }: Record<string, any>) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `inode-replacement:${subject}:${replacement}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `inode-replacement-${subject}-${replacement}`
        );
        const logicalTarget: any =
          `inode-replacement/${subject}-${replacement}.bin`;
        const target: any = path.join(
          fixture.workspaceRoot,
          logicalTarget
        );
        const parent: any = path.dirname(target);
        const outside: any = path.join(
          fixture.root,
          `inode-replacement-${subject}-${replacement}`
        );
        const sentinel: any = path.join(outside, "sentinel.keep");
        const extraLink: any = path.join(outside, "extra-link.keep");
        await fs.mkdir(outside, {
          mode: 0o700,
          recursive: true
        });
        await fs.writeFile(sentinel, "sentinel", {
          mode: 0o600
        });
        let replacedPath: any = "";
        fixture.faultHooks[faultSeam] = async (input?: any) : Promise<any> => {
          const row: any = readRawTransactionRow(
            fixture.root,
            input.requestRef
          );
          const publication: any = JSON.parse(row.publication_json);
          replacedPath = subject === "target"
            ? target
            : path.join(parent, publication.tempLeafRef);
          if (replacement === "mode") {
            await fs.chmod(replacedPath, 0o666);
            return;
          }
          if (replacement === "nlink") {
            await fs.link(replacedPath, extraLink);
            return;
          }
          await fs.unlink(replacedPath);
          if (replacement === "symlink") {
            await fs.symlink(sentinel, replacedPath);
          } else if (replacement === "hardlink") {
            await fs.link(sentinel, replacedPath);
          } else if (replacement === "fifo") {
            await createFifo(replacedPath);
          } else {
            await createUnixSocket(replacedPath);
          }
        };

        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          { logicalTarget }
        );
        fixture.resetEffects();
        const failed: any = await dispatchUntilTerminal(
          runtime,
          admitted.payload.requestRef
        );
        expect(replacedPath).not.toBe("");
        expect(failed).toMatchObject({
          error: {
            code: "materialization_rollback_incomplete"
          },
          stage: replacement === "socket"
            ? "admitted"
            : "rollback_incomplete",
          status: "failed"
        });
        expect(fixture.counters.stateCommits).toBe(0);
        expect(await fixture.materializationEvents())
          .toHaveLength(0);
        expect(await fs.readFile(sentinel, "utf8"))
          .toBe("sentinel");
        if (replacement === "hardlink") {
          expect((await fs.lstat(sentinel)).nlink).toBe(2);
        }
        if (replacement === "nlink") {
          expect((await fs.lstat(extraLink)).nlink)
            .toBeGreaterThanOrEqual(1);
        }
      },
      90_000
    );

    itPosix.each([
      ["target-symlink", "materialization_target_not_missing"],
      ["target-hard-link", "materialization_target_not_missing"],
      ["target-unsafe-type", "materialization_target_not_missing"],
      ["target-already-present", "materialization_target_not_missing"],
      ["unsafe-parent-mode", "materialization_path_invalid"],
      ["symlinked-parent", "materialization_path_invalid"],
      ["stale-revision", "materialization_stale_revision"]
    ])(
      "rejects the filesystem boundary %s before every protected materialization effect",
      async (boundary?: any, expectedCode?: any) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `filesystem-boundary:${boundary}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `filesystem-${boundary}`
        );
        const logicalTarget: any =
          `filesystem-boundaries/${boundary}.bin`;
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          { logicalTarget }
        );
        const target: any = path.join(
          fixture.workspaceRoot,
          logicalTarget
        );
        const parent: any = path.dirname(target);
        const outside: any = path.join(
          fixture.root,
          `outside-${boundary}`
        );
        const sentinel: any = path.join(outside, "sentinel.keep");
        await fs.mkdir(outside, {
          mode: 0o700,
          recursive: true
        });
        if (boundary === "target-symlink") {
          await fs.writeFile(sentinel, "sentinel", {
            mode: 0o600
          });
          await fs.symlink(sentinel, target);
        } else if (boundary === "target-hard-link") {
          await fs.writeFile(sentinel, "sentinel", {
            mode: 0o600
          });
          await fs.link(sentinel, target);
        } else if (boundary === "target-unsafe-type") {
          await fs.mkdir(target, { mode: 0o700 });
        } else if (boundary === "target-already-present") {
          await fs.writeFile(target, "existing", {
            mode: 0o600
          });
        } else if (boundary === "unsafe-parent-mode") {
          await fs.chmod(parent, 0o777);
        } else if (boundary === "symlinked-parent") {
          await fs.writeFile(sentinel, "sentinel", {
            mode: 0o600
          });
          await fs.rmdir(parent);
          await fs.symlink(outside, parent);
        } else {
          const revisionBump: any =
            await fixture.agentWorkspace.uploadWorkspaceFile({
              actorUserId: fixture.owner.subjectId,
              contentBase64: Buffer.from(
                "revision-bump",
                "utf8"
              ).toString("base64"),
              fileName: "revision-bump.txt",
              operationId:
                "jobs.upload_workspace_materialize:revision-fixture",
              overwrite: true,
              path: "revision-bump.txt",
              workspaceId: fixture.workspace.workspaceId
            });
          expect(revisionBump.ok).toBe(true);
        }

        fixture.resetEffects();
        const failed: any = await dispatchUntilTerminal(
          runtime,
          admitted.payload.requestRef
        );
        expect(failed).toMatchObject({
          error: { code: expectedCode },
          status: "failed"
        });
        expect(safeEffectCounts(fixture)).toMatchObject({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          stateCommits: 0
        });
        expect(await fixture.materializationEvents())
          .toHaveLength(0);
        expect(
          (await fs.readdir(parent)).filter(
            (name?: any) : any =>
              name.startsWith(".meshrix-materialization-")
          )
        ).toEqual([]);
        if (
          boundary === "target-symlink" ||
          boundary === "symlinked-parent"
        ) {
          expect(await fs.readFile(sentinel, "utf8"))
            .toBe("sentinel");
        }
        if (boundary === "target-hard-link") {
          expect(await fs.readFile(sentinel, "utf8"))
            .toBe("sentinel");
          expect((await fs.lstat(sentinel)).nlink).toBe(2);
          expect((await fs.lstat(target)).nlink).toBe(2);
        }
        if (boundary === "symlinked-parent") {
          expect(
            await lstatOrMissing(path.join(
              outside,
              path.basename(target)
            ))
          ).toBeNull();
        }
      },
      90_000
    );

    itPosix("fails closed on restart when the persisted publication parent is replaced", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const bytes: any = Buffer.from(
        "restart-parent-mismatch",
        "utf8"
      );
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "restart-parent-mismatch"
      );
      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload
      );
      const admittedRecord: any =
        await runtime.transactionStore.get(
          admitted.payload.requestRef
        );
      await fixture.suspendPersistent();
      const marker: any = await spawnCrashChild(
        fixture.root,
        "after_temp_reserved"
      );
      expect(marker).toMatchObject({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 1,
        kind: "ready",
        queueClaims: 1,
        stage: "after_temp_reserved",
        stateCommits: 0
      });
      await acknowledgeTerminatedCrashExecution(
        fixture.root,
        `materialization-work:${admittedRecord.bindingDigest}`
      );
      const interruptedStore: any =
        createUploadWorkspaceMaterializationTransactionStore({
          leaseMs: RUNTIME_LEASE_MS,
          userDataPath: fixture.root
        });
      const interrupted: any = await interruptedStore.get(
        admitted.payload.requestRef
      );
      const target: any = path.join(
        fixture.workspaceRoot,
        DEFAULT_LOGICAL_TARGET
      );
      const originalParent: any = path.dirname(target);
      const displacedParent: any =
        `${originalParent}.restart-displaced`;
      const temp: any = path.join(
        originalParent,
        interrupted.publication.tempLeafRef
      );
      expect((await fs.lstat(temp)).size).toBe(0);
      await fs.rename(originalParent, displacedParent);
      await fs.mkdir(originalParent, {
        mode: 0o700,
        recursive: true
      });
      const replacementSentinel: any = path.join(
        originalParent,
        "replacement.keep"
      );
      await fs.writeFile(
        replacementSentinel,
        "replacement",
        { mode: 0o600 }
      );
      interruptedStore.close();

      await waitForExpiredCrashLeases();
      await fixture.resumePersistent();
      fixture.resetEffects();
      const recoveredRuntime: any = await fixture.openRuntime();
      const failed: any = await dispatchUntilTerminal(
        recoveredRuntime,
        admitted.payload.requestRef
      );
      expect(failed).toMatchObject({
        error: {
          code: "materialization_rollback_incomplete"
        },
        stage: "rollback_incomplete",
        status: "failed"
      });
      expect(safeEffectCounts(fixture)).toMatchObject({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 0,
        stateCommits: 0
      });
      expect(await fs.readFile(
        replacementSentinel,
        "utf8"
      )).toBe("replacement");
      expect(await lstatOrMissing(target)).toBeNull();
      expect(
        (await fs.readdir(originalParent)).sort()
      ).toEqual(["replacement.keep"]);
      const displacedTemp: any = path.join(
        displacedParent,
        interrupted.publication.tempLeafRef
      );
      expect((await fs.lstat(displacedTemp)).size).toBe(0);
      expect(await fixture.materializationEvents())
        .toHaveLength(0);
      await expectTerminatedQueueRecovery(
        recoveredRuntime,
        admittedRecord.bindingDigest
      );
    }, 420_000);

    it.each(WAL_TAMPER_CASES)(
      "rejects valid-format digest substitution, stale ownership, stage skip, and ordinary failure at $expectedStage without changing the live WAL",
      async ({
        expectedStage,
        hookName,
        hookOwner
      }: Record<string, any>) : Promise<any> => {
        const fixture: any = await createFixture();
        const pause: any = createPausePoint();
        fixture[hookOwner][hookName] = pause.hook;
        const runtime: any = await fixture.openRuntime();
        const upload: any = await createCompletedUpload(
          fixture,
          Buffer.from(
            `wal-tamper:${expectedStage}`,
            "utf8"
          ),
          `wal-tamper-${expectedStage}`
        );
        const logicalTarget: any =
          `wal-tamper/${expectedStage}.bin`;
        await fixture.ensureTargetParent(logicalTarget);
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          { logicalTarget }
        );
        const dispatch: any = runtime.queueGate.dispatch();
        await pause.reached;
        const record: any = await runtime.transactionStore.get(
          admitted.payload.requestRef
        );
        expect(record.stage).toBe(expectedStage);
        const before: any = clone(record);
        const substitutedDigest: any = sha256(
          `substituted:${expectedStage}`
        );
        const invokeTamper: any = (ownerFence?: any) : any => {
          if (expectedStage === "publication_intent") {
            return runtime.transactionStore
              .recordPublicationIntent(record.requestRef, {
                ownerFence,
                publication: {
                  ...record.publication,
                  intentDigest: substitutedDigest
                }
              });
          }
          if (expectedStage === "temp_reserved") {
            return runtime.transactionStore
              .recordTempReserved(record.requestRef, {
                ownerFence,
                publication: {
                  ...record.publication,
                  reservationDigest: substitutedDigest
                }
              });
          }
          if (expectedStage === "publication_prepared") {
            return runtime.transactionStore
              .recordPublicationPrepared(record.requestRef, {
                ownerFence,
                publication: {
                  ...record.publication,
                  proofDigest: substitutedDigest
                }
              });
          }
          if (expectedStage === "published") {
            return runtime.transactionStore.recordPublished(
              record.requestRef,
              {
                ...record.effect,
                ownerFence,
                priorRevision:
                  record.expectedWorkspaceRevision,
                proofDigest: substitutedDigest
              }
            );
          }
          if (expectedStage === "evidence_pending") {
            return runtime.transactionStore
              .recordAuditFinalized(record.requestRef, {
                auditRef:
                  `audit:${record.evidence.auditId}`,
                ownerFence,
                settlementDigest: substitutedDigest
              });
          }
          return runtime.transactionStore
            .recordProofFinalized(record.requestRef, {
              ownerFence,
              proofRef:
                expectedStage === "proof_finalized"
                  ? "proof:substituted-proof-reference"
                  : "proof:wal-tamper-probe",
              settlementDigest:
                expectedStage === "audit_finalized"
                  ? substitutedDigest
                  : record.evidence.settlementDigest
            });
        };
        await expect(
          invokeTamper(record.ownerFence)
        ).rejects.toMatchObject({
          code: "materialization_publication_wal_mismatch"
        });
        await expect(
          invokeTamper("stale-owner-fence")
        ).rejects.toMatchObject({
          code: "materialization_fenced"
        });
        await expect(
          runtime.transactionStore.complete(
            record.requestRef,
            {
              ownerFence: record.ownerFence,
              result: {},
              settlementDigest: substitutedDigest
            }
          )
        ).rejects.toMatchObject({
          code: "materialization_publication_wal_mismatch"
        });
        await expect(
          runtime.transactionStore.fail(
            record.requestRef,
            {
              error: {
                code: "ordinary_failure_must_wait"
              },
              ownerFence: record.ownerFence,
              recoverable: false
            }
          )
        ).rejects.toMatchObject({
          code: "materialization_recovery_required"
        });
        expect(
          await runtime.transactionStore.get(record.requestRef)
        ).toEqual(before);
        pause.release();
        await dispatch;
        expect(
          await dispatchUntilTerminal(runtime, record.requestRef)
        ).toMatchObject({ status: "completed" });
        delete fixture[hookOwner][hookName];
      },
      90_000
    );

    itPosix("fails closed after direct persisted WAL tampering across close and reopen without custody, plaintext, namespace, or queue effects", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const bytes: any = Buffer.from(
        "persisted-wal-tamper-after-close",
        "utf8"
      );
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "persisted-wal-tamper"
      );
      const logicalTarget: any =
        "persisted-wal-tamper/payload.bin";
      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { logicalTarget }
      );
      const admittedRecord: any =
        await runtime.transactionStore.get(
          admitted.payload.requestRef
        );
      await fixture.suspendPersistent();
      const marker: any = await spawnCrashChild(
        fixture.root,
        "after_publication_prepared"
      );
      expect(marker).toMatchObject({
        archiveWrites: 0,
        custodyReads: 1,
        finalPermits: 1,
        kind: "ready",
        queueClaims: 1,
        stage: "after_publication_prepared",
        stateCommits: 0
      });
      await acknowledgeTerminatedCrashExecution(
        fixture.root,
        `materialization-work:${admittedRecord.bindingDigest}`
      );

      const closedStore: any =
        createUploadWorkspaceMaterializationTransactionStore({
          leaseMs: RUNTIME_LEASE_MS,
          userDataPath: fixture.root
        });
      const interrupted: any = await closedStore.get(
        admitted.payload.requestRef
      );
      expect(interrupted.stage).toBe("publication_prepared");
      closedStore.close();

      const databasePath: any = transactionDatabasePath(fixture.root);
      const tamperDb: any = openSqliteDatabase(databasePath);
      const publication: any = JSON.parse(
        tamperDb.prepare(`
          SELECT publication_json
          FROM materialization_requests
          WHERE request_ref = ?
        `).get(admitted.payload.requestRef).publication_json
      );
      publication.proofDigest = sha256(
        "direct-persisted-proof-substitution"
      );
      tamperDb.prepare(`
        UPDATE materialization_requests
        SET publication_json = ?
        WHERE request_ref = ?
      `).run(
        canonicalJson(publication),
        admitted.payload.requestRef
      );
      const tamperedLayout: any = snapshotDatabaseLayout(tamperDb);
      tamperDb.close();
      const targetParent: any = path.dirname(path.join(
        fixture.workspaceRoot,
        logicalTarget
      ));
      const namespaceBefore: any =
        await protectedDirectorySnapshot(targetParent);
      const sidecarsBefore: any = (
        await fs.readdir(path.dirname(databasePath))
      ).sort();

      fixture.resetEffects();
      expect(() : any =>
        createUploadWorkspaceMaterializationTransactionStore({
          leaseMs: RUNTIME_LEASE_MS,
          userDataPath: fixture.root
        })
      ).toThrow(expect.objectContaining({
        code: "materialization_publication_wal_mismatch"
      }));
      expect(safeEffectCounts(fixture)).toEqual({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 0,
        maxPlaintextChunk: 0,
        queueClaims: 0,
        stateCommits: 0,
        workspaceReads: 0
      });
      expect({
        authorityCaptures: fixture.counters.authorityCaptures,
        queueEnqueues: fixture.counters.queueEnqueues,
        transactionCreates: fixture.counters.transactionCreates
      }).toEqual({
        authorityCaptures: 0,
        queueEnqueues: 0,
        transactionCreates: 0
      });
      expect(await protectedDirectorySnapshot(targetParent))
        .toEqual(namespaceBefore);
      expect((
        await fs.readdir(path.dirname(databasePath))
      ).sort()).toEqual(sidecarsBefore);
      const afterDb: any = openSqliteDatabase(databasePath);
      expect(snapshotDatabaseLayout(afterDb))
        .toBe(tamperedLayout);
      afterDb.close();
    }, 420_000);

    itPosix("reconciles a transaction row lost before its first queue enqueue after a real SIGKILL", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const crashUser: any = await fixture.consoleAuth.createUser({
        password: CRASH_ADMISSION_PASSWORD,
        roleId: "owner",
        username: CRASH_ADMISSION_USERNAME
      });
      const crashOwner: Readonly<Record<string, any>> = Object.freeze({
        subjectId: crashUser.userId,
        tenantId: crashUser.tenantId,
        userId: crashUser.userId
      });
      const crashWorkspace: any =
        fixture.agentWorkspace.createWorkspace({
          ownerUserId: crashUser.userId,
          title: "Queue admission crash workspace"
        }).workspace;
      const logicalTarget: any =
        "queue-crash/created-before-enqueue.bin";
      const crashWorkspaceRoot: any = path.join(
        fixture.root,
        "agent-workspaces",
        "folders",
        stableId(
          "workspace-folder",
          crashWorkspace.workspaceId
        )
      );
      await fs.mkdir(
        path.dirname(path.join(
          crashWorkspaceRoot,
          logicalTarget
        )),
        { mode: 0o700, recursive: true }
      );
      const bytes: any = Buffer.from(
        "transaction-created-before-enqueue",
        "utf8"
      );
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "transaction-before-enqueue",
        crashOwner
      );
      const expectedWorkspaceRevision: any =
        await workspaceRevision(
          fixture,
          crashWorkspace.workspaceId,
          crashUser.userId
        );
      await fixture.suspendPersistent();
      const marker: any = await spawnCrashChild(
        fixture.root,
        "after_transaction_created_before_enqueue",
        {
          admission: {
            expectedWorkspaceRevision,
            logicalTarget,
            uploadSessionId: upload.sessionId,
            workspaceId: crashWorkspace.workspaceId
          }
        }
      );
      expect(marker).toMatchObject({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 0,
        kind: "ready",
        queueClaims: 0,
        stage: "after_transaction_created_before_enqueue",
        stateCommits: 0
      });

      const interruptedStore: any =
        createUploadWorkspaceMaterializationTransactionStore({
          leaseMs: RUNTIME_LEASE_MS,
          userDataPath: fixture.root
        });
      const candidates: any =
        await interruptedStore.listReconcileCandidates({
          afterRequestRef: "",
          limit: 10
        });
      expect(candidates).toHaveLength(1);
      const [interrupted] = candidates;
      expect(interrupted).toMatchObject({
        logicalTarget,
        stage: "admitted",
        status: "queued",
        workspaceId: crashWorkspace.workspaceId
      });
      const workItemId: any =
        `materialization-work:${interrupted.bindingDigest}`;
      const queueBeforeRecovery: any = createSqliteWorkQueueStore({
        userDataPath: fixture.root,
        policy: { leaseTimeoutMs: CRASH_LEASE_MS }
      });
      expect(queueBeforeRecovery.inspect({
        includeJournal: true,
        workItemId
      })).toEqual({
        journal: [],
        workItem: null
      });
      await queueBeforeRecovery.close?.();
      interruptedStore.close();

      await fixture.resumePersistent();
      fixture.resetEffects();
      const recoveredRuntime: any = await fixture.openRuntime();
      const completed: any = await dispatchUntilTerminal(
        recoveredRuntime,
        interrupted.requestRef
      );
      expect(completed).toMatchObject({
        stage: "completed",
        status: "completed"
      });
      expect(safeEffectCounts(fixture)).toMatchObject({
        custodyReads: 1,
        finalPermits: 1,
        stateCommits: 1
      });
      expect(
        await fs.readFile(path.join(
          crashWorkspaceRoot,
          logicalTarget
        ))
      ).toEqual(bytes);
      const queueAfterRecovery: any =
        await recoveredRuntime.queueGate.observe({
          includeJournal: true,
          workItemId
        });
      const transitions: any = queueAfterRecovery.journal.map(
        (entry?: any) : any => entry.transition
      );
      expect(
        transitions.filter((entry?: any) : any => entry === "enqueue")
      ).toHaveLength(1);
      expect(transitions).not.toContain("lease_expired");
      expect(transitions.at(-1)).toBe("complete");
      expect(recoveredRuntime.queueGate.recoveredWorkItemIds())
        .not.toContain(workItemId);
    }, 420_000);

    itPosix.each(QUEUE_CRASH_CASES)(
      "recovers the real queue boundary $crashStage and fences its stale acknowledgement",
      async ({
        crashStage,
        interruptedStage,
        interruptedStatus,
        markerEffects,
        recoveryEffects
      }: Record<string, any>) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `queue-crash:${crashStage}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `queue-crash-${crashStage}`
        );
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload
        );
        const admittedRecord: any =
          await runtime.transactionStore.get(
            admitted.payload.requestRef
          );
        const workItemId: any =
          `materialization-work:${admittedRecord.bindingDigest}`;
        await fixture.suspendPersistent();
        const marker: any = await spawnCrashChild(
          fixture.root,
          crashStage
        );
        expect(marker).toMatchObject({
          ...markerEffects,
          kind: "ready",
          queueClaims: 1,
          stage: crashStage
        });
        const staleLease: any =
          await acknowledgeTerminatedCrashExecution(
            fixture.root,
            workItemId
          );

        await waitForExpiredCrashLeases();
        await fixture.resumePersistent();
        const interruptedStore: any =
          createUploadWorkspaceMaterializationTransactionStore({
            leaseMs: RUNTIME_LEASE_MS,
            userDataPath: fixture.root
          });
        const interrupted: any = await interruptedStore.get(
          admitted.payload.requestRef
        );
        expect(interrupted).toMatchObject({
          stage: interruptedStage,
          status: interruptedStatus
        });
        interruptedStore.close();

        fixture.resetEffects();
        const recoveredRuntime: any = await fixture.openRuntime();
        const completed: any = await dispatchUntilTerminal(
          recoveredRuntime,
          admitted.payload.requestRef
        );
        expect(completed).toMatchObject({
          stage: "completed",
          status: "completed"
        });
        expect(safeEffectCounts(fixture)).toMatchObject(
          recoveryEffects
        );
        if (
          crashStage ===
            "after_transaction_completed_before_queue_ack"
        ) {
          const effectsBeforeQueueAck: any =
            safeEffectCounts(fixture);
          await dispatchUntilQueueCompleted(
            recoveredRuntime,
            workItemId
          );
          expect(safeEffectCounts(fixture))
            .toEqual(effectsBeforeQueueAck);
        }
        await expectTerminatedQueueRecovery(
          recoveredRuntime,
          admittedRecord.bindingDigest
        );

        if (
          crashStage ===
            "after_transaction_completed_before_queue_ack"
        ) {
          const staleQueueStore: any = createSqliteWorkQueueStore({
            userDataPath: fixture.root,
            policy: { leaseTimeoutMs: RUNTIME_LEASE_MS }
          });
          const beforeStaleAck: any = staleQueueStore.inspect({
            includeJournal: true,
            workItemId
          });
          let staleAckError: any = null;
          try {
            staleQueueStore.complete({
              leaseId: staleLease.leaseId,
              workItemId
            });
          } catch (error: any) {
            staleAckError = error;
          }
          expect(staleAckError).toBeInstanceOf(Error);
          const afterStaleAck: any = staleQueueStore.inspect({
            includeJournal: true,
            workItemId
          });
          expect(afterStaleAck).toEqual(beforeStaleAck);
          expect(afterStaleAck.workItem.state)
            .toBe("completed");
          const terminalAck: any = afterStaleAck.journal.at(-1);
          expect(terminalAck).toMatchObject({
            transition: "complete"
          });
          expect(terminalAck.leaseId)
            .not.toBe(staleLease.leaseId);
          expect(terminalAck.leaseSeq)
            .toBeGreaterThan(staleLease.leaseSeq);
          await staleQueueStore.close?.();
        }
      },
      420_000
    );

    itPosix("fails closed with an identity-less private inode and retained WAL when SIGKILL lands after inode reserve but before its WAL identity", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const bytes: any = Buffer.alloc(160 * 1024, 0x71);
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "pre-wal-identity-gap"
      );
      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload
      );
      const admittedRecord: any =
        await runtime.transactionStore.get(
          admitted.payload.requestRef
        );
      await fixture.suspendPersistent();
      const marker: any = await spawnCrashChild(
        fixture.root,
        "after_temp_inode_reserved_before_wal"
      );
      expect(marker).toMatchObject({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 1,
        kind: "ready",
        queueClaims: 1,
        stage: "after_temp_inode_reserved_before_wal",
        stateCommits: 0
      });
      await acknowledgeTerminatedCrashExecution(
        fixture.root,
        `materialization-work:${admittedRecord.bindingDigest}`
      );
      await waitForExpiredCrashLeases();
      await fixture.resumePersistent();
      const interruptedStore: any =
        createUploadWorkspaceMaterializationTransactionStore({
          leaseMs: RUNTIME_LEASE_MS,
          userDataPath: fixture.root
        });
      const interrupted: any = await interruptedStore.get(
        admitted.payload.requestRef
      );
      expect(interrupted).toMatchObject({
        effect: null,
        evidence: null,
        publication: {
          preparedIdentity: null,
          proofDigest: "",
          reservationDigest: ""
        },
        result: null,
        stage: "publication_intent",
        status: "running"
      });
      const target: any = path.join(
        fixture.workspaceRoot,
        DEFAULT_LOGICAL_TARGET
      );
      const temp: any = path.join(
        path.dirname(target),
        interrupted.publication.tempLeafRef
      );
      const tempBeforeRecovery: any =
        await fileIdentitySnapshot(temp);
      expect(tempBeforeRecovery).toMatchObject({
        mode: expect.any(Number),
        nlink: 1,
        size: 0
      });
      expect(tempBeforeRecovery.mode & 0o777).toBe(0o600);
      expect(await lstatOrMissing(target)).toBeNull();
      const neighbor: any = path.join(
        path.dirname(target),
        "neighbor-pre-wal.keep"
      );
      await fs.writeFile(
        neighbor,
        "neighbor",
        { mode: 0o600 }
      );
      interruptedStore.close();

      fixture.resetEffects();
      const recoveredRuntime: any = await fixture.openRuntime();
      const failed: any = await dispatchUntilTerminal(
        recoveredRuntime,
        admitted.payload.requestRef
      );
      expect(failed).toMatchObject({
        effect: null,
        evidence: null,
        error: {
          code: "materialization_rollback_incomplete"
        },
        publication: interrupted.publication,
        result: null,
        stage: "rollback_incomplete",
        status: "failed"
      });
      expect(safeEffectCounts(fixture)).toMatchObject({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 0,
        stateCommits: 0
      });
      expect(await fileIdentitySnapshot(temp))
        .toEqual(tempBeforeRecovery);
      expect(await lstatOrMissing(target)).toBeNull();
      expect(await fs.readFile(neighbor, "utf8"))
        .toBe("neighbor");
      expect(await fixture.materializationEvents())
        .toEqual([]);
      await expectTerminatedQueueRecovery(
        recoveredRuntime,
        admittedRecord.bindingDigest
      );
    }, 420_000);

    itPosix.each(PRECOMMIT_CRASH_CASES)(
      "recovers the exact $crashStage precommit namespace after a real SIGKILL without touching its neighbor",
      async ({
        crashStage,
        custodyReads,
        expectsCleanup,
        finalPermits,
        stage,
        tempState,
        targetState
      }: Record<string, any>) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.alloc(160 * 1024, 0x6d);
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `precommit-sigkill-${crashStage}`
        );
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload
        );
        const admittedRecord: any =
          await runtime.transactionStore.get(
            admitted.payload.requestRef
          );
        await fixture.suspendPersistent();
        const marker: any = await spawnCrashChild(
          fixture.root,
          crashStage
        );
        expect(marker).toMatchObject({
          archiveWrites: 0,
          custodyReads,
          finalPermits,
          kind: "ready",
          queueClaims: 1,
          stage: crashStage,
          stateCommits: 0
        });
        await acknowledgeTerminatedCrashExecution(
          fixture.root,
          `materialization-work:${admittedRecord.bindingDigest}`
        );
        await waitForExpiredCrashLeases();
        await fixture.resumePersistent();
        const interruptedStore: any =
          createUploadWorkspaceMaterializationTransactionStore({
            leaseMs: RUNTIME_LEASE_MS,
            userDataPath: fixture.root
          });
        const interrupted: any = await interruptedStore.get(
          admitted.payload.requestRef
        );
        expect(interrupted).toMatchObject({
          stage,
          status: "running"
        });
        if (stage === "admitted") {
          expect(interrupted.publication).toBeNull();
        } else if (stage === "publication_intent") {
          expect(interrupted.publication).toMatchObject({
            contentDigest: sha256(bytes)
          });
          expect(interrupted.publication).toMatchObject({
            preparedIdentity: null,
            proofDigest: "",
            reservationDigest: ""
          });
        } else {
          expect(interrupted.publication).toMatchObject({
            contentDigest: sha256(bytes),
            preparedIdentity: {
              byteCount: bytes.length,
              contentDigest: sha256(bytes),
              mode: 0o600
            },
            reservationDigest:
              expect.stringMatching(/^[a-f0-9]{64}$/u)
          });
          expect(Boolean(interrupted.publication.proofDigest))
            .toBe(stage === "publication_prepared");
        }
        const target: any = path.join(
          fixture.workspaceRoot,
          DEFAULT_LOGICAL_TARGET
        );
        const temp: any = interrupted.publication
          ? path.join(
              path.dirname(target),
              interrupted.publication.tempLeafRef
            )
          : null;
        const [tempStat, targetStat] = await Promise.all([
          temp ? lstatOrMissing(temp) : null,
          lstatOrMissing(target)
        ]);
        expect(Boolean(tempStat)).toBe(tempState !== "missing");
        expect(Boolean(targetStat))
          .toBe(targetState !== "missing");
        if (tempStat) {
          if (tempState === "empty") {
            expect(tempStat.size).toBe(0);
          } else if (tempState === "partial") {
            expect(tempStat.size).toBeGreaterThan(0);
            expect(tempStat.size).toBeLessThan(bytes.length);
          } else {
            expect(tempStat.size).toBe(bytes.length);
          }
          expect(tempStat.mode & 0o777).toBe(0o600);
        }
        if (targetStat) {
          expect(targetStat.size).toBe(bytes.length);
          expect(targetStat.mode & 0o777).toBe(0o600);
        }
        if (tempState === "linked") {
          expect(targetState).toBe("linked");
          expect(tempStat.nlink).toBe(2);
          expect(targetStat.nlink).toBe(2);
          expect({
            dev: tempStat.dev,
            ino: tempStat.ino
          }).toEqual({
            dev: targetStat.dev,
            ino: targetStat.ino
          });
        } else {
          expect(tempStat?.nlink || 1).toBe(1);
          expect(targetStat?.nlink || 1).toBe(1);
        }
        const neighbor: any = path.join(
          path.dirname(target),
          `neighbor-${crashStage}.keep`
        );
        await fs.writeFile(neighbor, "neighbor", { mode: 0o600 });
        interruptedStore.close();

        fixture.resetEffects();
        const recoveredRuntime: any = await fixture.openRuntime();
        const completed: any = await dispatchUntilTerminal(
          recoveredRuntime,
          admitted.payload.requestRef
        );
        expect(completed.status).toBe("completed");
        if (expectsCleanup) {
          expect(fixture.events).toContain(
            "afterPrecommitCleanupBeforeRecord"
          );
        } else {
          expect(fixture.events).not.toContain(
            "afterPrecommitCleanupBeforeRecord"
          );
        }
        if (temp) {
          expect(await lstatOrMissing(temp)).toBeNull();
        }
        expect(await fs.readFile(neighbor, "utf8")).toBe("neighbor");
        expect(await fs.readFile(target)).toEqual(bytes);
        expect(safeEffectCounts(fixture)).toMatchObject({
          custodyReads: 1,
          finalPermits: 1,
          stateCommits: 1
        });
        await expectTerminatedQueueRecovery(
          recoveredRuntime,
          admittedRecord.bindingDigest
        );
      },
      420_000
    );

    it("commits forward from the exact durable Merkle event after SIGKILL with no second permit, custody read, archive, or event", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const bytes: any = Buffer.from(
        "commit-forward-after-real-process-loss",
        "utf8"
      );
      const upload: any = await createCompletedUpload(
        fixture,
        bytes,
        "commit-forward-sigkill"
      );
      const initialRevision: any = await workspaceRevision(fixture);
      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { expectedWorkspaceRevision: initialRevision }
      );
      const admittedRecord: any =
        await runtime.transactionStore.get(
          admitted.payload.requestRef
        );
      const checkpointsBeforeCrash: any =
        await fixture.workspaceCheckpointTrees();
      const eventsBeforeCrash: any =
        await fixture.materializationEvents();
      expect(checkpointsBeforeCrash).toEqual([]);
      expect(eventsBeforeCrash).toEqual([]);
      await fixture.suspendPersistent();
      const marker: any = await spawnCrashChild(
        fixture.root,
        "after_state_commit"
      );
      expect(marker).toMatchObject({
        kind: "ready",
        stage: "after_state_commit",
        queueClaims: 1,
        finalPermits: 1,
        custodyReads: 1,
        stateCommits: 1
      });
      await acknowledgeTerminatedCrashExecution(
        fixture.root,
        `materialization-work:${admittedRecord.bindingDigest}`
      );
      await waitForExpiredCrashLeases();
      await fixture.resumePersistent();
      const eventsBefore: any = await fixture.materializationEvents();
      expect(eventsBefore).toHaveLength(1);
      expect(eventsBefore[0]).toMatchObject({
        beforeRoot: initialRevision,
        payload: {
          action: "file.materialize",
          contentSha256: sha256(bytes),
          sizeBytes: bytes.length
        }
      });
      const checkpointsBeforeRecovery: any =
        await fixture.workspaceCheckpointTrees();
      expect(checkpointsBeforeRecovery).toHaveLength(1);
      const checkpointNodes: any = (Object.values(
        checkpointsBeforeRecovery[0].nodes
      ) as any[]).filter((node?: any) : any =>
        node?.metadata?.action === "file.materialize"
      );
      expect(checkpointNodes).toHaveLength(1);
      const checkpointCommit: any =
        checkpointNodes[0].metadata.stateCommit;
      expect(checkpointNodes[0]).toMatchObject({
        cursor: {
          afterRoot: eventsBefore[0].afterRoot,
          commitId: checkpointCommit.commitId
        },
        metadata: {
          action: "file.materialize",
          operationId: eventsBefore[0].operationId,
          path: DEFAULT_LOGICAL_TARGET,
          stateCommit: {
            afterRoot: eventsBefore[0].afterRoot,
            beforeRoot: eventsBefore[0].beforeRoot,
            eventHash: eventsBefore[0].eventHash
          },
          workspaceId: fixture.workspace.workspaceId
        },
        nodeId: `commit:${checkpointCommit.commitId}`,
        status: "completed"
      });
      fixture.resetEffects();
      const recoveredRuntime: any = await fixture.openRuntime();
      const completed: any = await dispatchUntilTerminal(
        recoveredRuntime,
        admitted.payload.requestRef
      );
      expect(completed).toMatchObject({
        status: "completed",
        result: {
          workspaceRevision: eventsBefore[0].afterRoot
        }
      });
      expect(safeEffectCounts(fixture)).toMatchObject({
        archiveWrites: 0,
        custodyReads: 0,
        finalPermits: 0,
        stateCommits: 0
      });
      const eventsAfter: any = await fixture.materializationEvents();
      expect(eventsAfter).toEqual(eventsBefore);
      expect(await fixture.workspaceCheckpointTrees())
        .toEqual(checkpointsBeforeRecovery);
      expect(
        await fs.readFile(path.join(
          fixture.workspaceRoot,
          DEFAULT_LOGICAL_TARGET
        ))
      ).toEqual(bytes);
      await expectTerminatedQueueRecovery(
        recoveredRuntime,
        admittedRecord.bindingDigest
      );
    }, 420_000);

    itPosix.each(["target-identity", "target-content"])(
      "fails closed when committed recovery observes $0 mismatch after SIGKILL",
      async (mismatch?: any) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `committed-recovery:${mismatch}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `committed-recovery-${mismatch}`
        );
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload
        );
        const admittedRecord: any =
          await runtime.transactionStore.get(
            admitted.payload.requestRef
          );
        await fixture.suspendPersistent();
        await spawnCrashChild(
          fixture.root,
          "after_state_commit"
        );
        await acknowledgeTerminatedCrashExecution(
          fixture.root,
          `materialization-work:${admittedRecord.bindingDigest}`
        );
        const target: any = path.join(
          fixture.workspaceRoot,
          DEFAULT_LOGICAL_TARGET
        );
        if (mismatch === "target-identity") {
          const replacement: any = `${target}.replacement`;
          await fs.writeFile(replacement, bytes, { mode: 0o600 });
          await fs.rename(replacement, target);
        } else {
          await fs.writeFile(
            target,
            Buffer.from("changed-committed-content", "utf8"),
            { mode: 0o600 }
          );
        }
        await waitForExpiredCrashLeases();
        await fixture.resumePersistent();
        fixture.resetEffects();
        const recoveredRuntime: any = await fixture.openRuntime();
        const checkpointsBeforeRecovery: any =
          await fixture.workspaceCheckpointTrees();
        const failed: any = await dispatchUntilTerminal(
          recoveredRuntime,
          admitted.payload.requestRef
        );
        expect(failed).toMatchObject({
          error: {
            code: "materialization_rollback_incomplete"
          },
          stage: "rollback_incomplete",
          status: "failed"
        });
        expect(safeEffectCounts(fixture)).toMatchObject({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          stateCommits: 0
        });
        expect(await fixture.materializationEvents())
          .toHaveLength(1);
        expect(await fixture.workspaceCheckpointTrees())
          .toEqual(checkpointsBeforeRecovery);
      },
      420_000
    );

    itPosix.each([
      [
        "event-anchor",
        "event",
        (event?: any) : any => ({
          ...event,
          eventHash: sha256(`mismatch:${event.eventHash}`)
        })
      ],
      [
        "event-payload",
        "event",
        (event?: any) : any => ({
          ...event,
          payload: {
            ...event.payload,
            archiveRootCid: sha256(
              `mismatch:${event.payload.archiveRootCid}`
            )
          }
        })
      ],
      [
        "operation-id",
        "stateCommit",
        (commit?: any) : any => ({
          ...commit,
          operationId: sha256(
            `mismatch:${commit.operationId}`
          )
        })
      ],
      [
        "before-root",
        "stateCommit",
        (commit?: any) : any => ({
          ...commit,
          beforeRoot: sha256(`mismatch:${commit.beforeRoot}`)
        })
      ],
      [
        "after-root",
        "stateCommit",
        (commit?: any) : any => ({
          ...commit,
          afterRoot: sha256(`mismatch:${commit.afterRoot}`)
        })
      ],
      [
        "publication-proof",
        "stateCommit",
        (commit?: any) : any => ({
          ...commit,
          payload: {
            ...commit.payload,
            publicationProofDigest: sha256(
              `mismatch:${commit.payload.publicationProofDigest}`
            )
          }
        })
      ],
      [
        "checkpoint",
        "checkpoint",
        (checkpoint?: any) : any => ({
          ...checkpoint,
          label: `${checkpoint.label}:mismatch`
        })
      ]
    ])(
      "fails closed when committed recovery observes $0 evidence mismatch after SIGKILL",
      async (mismatch?: any, transformTarget?: any, transform?: any) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `committed-recovery-evidence:${mismatch}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `committed-recovery-evidence-${mismatch}`
        );
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload
        );
        const admittedRecord: any =
          await runtime.transactionStore.get(
            admitted.payload.requestRef
          );
        await fixture.suspendPersistent();
        await spawnCrashChild(
          fixture.root,
          "after_state_commit"
        );
        await acknowledgeTerminatedCrashExecution(
          fixture.root,
          `materialization-work:${admittedRecord.bindingDigest}`
        );
        await waitForExpiredCrashLeases();
        fixture.recoveryTransforms[transformTarget] = transform;
        await fixture.resumePersistent();
        fixture.resetEffects();
        const recoveredRuntime: any = await fixture.openRuntime();
        const checkpointsBeforeRecovery: any =
          await fixture.workspaceCheckpointTrees();
        const failed: any = await dispatchUntilTerminal(
          recoveredRuntime,
          admitted.payload.requestRef
        );
        expect(failed).toMatchObject({
          error: {
            code: "materialization_rollback_incomplete"
          },
          stage: "rollback_incomplete",
          status: "failed"
        });
        expect(safeEffectCounts(fixture)).toMatchObject({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          stateCommits: 0
        });
        expect(await fixture.materializationEvents())
          .toHaveLength(1);
        expect(await fixture.workspaceCheckpointTrees())
          .toEqual(checkpointsBeforeRecovery);
      },
      420_000
    );

    it.each([
      ["after_evidence_pending", "evidence_pending", 1, false],
      ["after_audit_write", "evidence_pending", 1, true],
      ["after_proof_write", "audit_finalized", 0, true],
      ["after_audit_finalized_record", "audit_finalized", 1, true],
      ["after_proof_finalized_record", "proof_finalized", 0, true]
    ])(
      "settles %s evidence idempotently after a real process crash and orphaned queue lease",
      async (
        crashStage?: any,
        expectedStage?: any,
        expectedProofGrowth?: any,
        expectedAuditPresent?: any
      ) : Promise<any> => {
        const fixture: any = await createFixture();
        const runtime: any = await fixture.openRuntime();
        const bytes: any = Buffer.from(
          `evidence-crash:${crashStage}`,
          "utf8"
        );
        const upload: any = await createCompletedUpload(
          fixture,
          bytes,
          `evidence-${crashStage}`
        );
        const admitted: any = await submitMaterialization(
          fixture,
          runtime,
          upload
        );
        const admittedRecord: any =
          await runtime.transactionStore.get(
            admitted.payload.requestRef
          );
        await fixture.suspendPersistent();
        const marker: any = await spawnCrashChild(
          fixture.root,
          crashStage
        );
        expect(marker).toMatchObject({
          kind: "ready",
          stage: crashStage,
          queueClaims: 1,
          finalPermits: 1,
          custodyReads: 1,
          stateCommits: 1
        });
        await acknowledgeTerminatedCrashExecution(
          fixture.root,
          `materialization-work:${admittedRecord.bindingDigest}`
        );
        await waitForExpiredCrashLeases();
        await fixture.resumePersistent();
        const interruptedStore: any =
          createUploadWorkspaceMaterializationTransactionStore({
            leaseMs: RUNTIME_LEASE_MS,
            userDataPath: fixture.root
          });
        const interrupted: any = await interruptedStore.get(
          admitted.payload.requestRef
        );
        expect(interrupted).toMatchObject({
          stage: expectedStage,
          evidence: {
            auditId: expect.any(String),
            settlementDigest:
              expect.stringMatching(/^[a-f0-9]{64}$/u)
          }
        });
        expect(Object.keys(interrupted.evidence).sort())
          .toEqual([
            "auditCreatedAt",
            "auditId",
            "auditRef",
            "proofOutcomeKey",
            "proofRef",
            "settlementDigest"
          ]);
        const evidenceRowBeforeFence: any = clone(interrupted);
        const staleEvidenceWrite: any =
          expectedStage === "evidence_pending"
            ? interruptedStore.recordAuditFinalized(
                interrupted.requestRef,
                {
                  auditRef:
                    `audit:${interrupted.evidence.auditId}`,
                  ownerFence: "stale-evidence-owner-fence",
                  settlementDigest:
                    interrupted.evidence.settlementDigest
                }
              )
            : interruptedStore.recordProofFinalized(
                interrupted.requestRef,
                {
                  ownerFence: "stale-evidence-owner-fence",
                  proofRef: "proof:stale-fence-probe",
                  settlementDigest:
                    interrupted.evidence.settlementDigest
                }
              );
        await expect(staleEvidenceWrite)
          .rejects.toMatchObject({
            code: "materialization_fenced"
          });
        expect(await interruptedStore.get(
          interrupted.requestRef
        )).toEqual(evidenceRowBeforeFence);
        const auditBefore: any =
          await fixture.operationAuditStore.getById(
            interrupted.evidence.auditId
          );
        if (expectedAuditPresent) {
          expect(auditBefore).toBeTruthy();
        } else {
          expect(auditBefore).toBeFalsy();
        }
        const boundProofEntry: any =
          await fixture.operationProofSubstrate.beginLifecycle({
            idempotencyKey: admittedRecord.bindingDigest,
            input: {
              bindingDigest: admittedRecord.bindingDigest,
              resourceRevision:
                admittedRecord.resourceRevision
            },
            operationId: admittedRecord.operationId,
            workspaceId: admittedRecord.workspaceId
          });
        expect(boundProofEntry).toMatchObject({
          idempotencyKey: admittedRecord.bindingDigest,
          operationId: OPERATION_ID,
          pactium: {
            intentId: expect.any(String)
          },
          replayed: true,
          workspaceId: fixture.workspace.workspaceId
        });
        const proofReceiptsBefore: any =
          await listBoundSucceededMaterializationReceipts(
            fixture.operationProofSubstrate,
            {
              intentId: boundProofEntry.pactium.intentId,
              workspaceId: fixture.workspace.workspaceId
            }
          );
        expect(proofReceiptsBefore).toHaveLength(
          expectedProofGrowth === 0 ? 1 : 0
        );
        const eventsBefore: any =
          await fixture.materializationEvents();
        interruptedStore.close();

        fixture.resetEffects();
        const recoveredRuntime: any = await fixture.openRuntime();
        const completed: any = await dispatchUntilTerminal(
          recoveredRuntime,
          admitted.payload.requestRef
        );
        expect(completed.status).toBe("completed");
        expect(Object.keys(completed.evidence).sort())
          .toEqual([
            "auditCreatedAt",
            "auditId",
            "auditRef",
            "proofOutcomeKey",
            "proofRef",
            "settlementDigest"
          ]);
        expect(safeEffectCounts(fixture)).toMatchObject({
          archiveWrites: 0,
          custodyReads: 0,
          finalPermits: 0,
          stateCommits: 0
        });
        const auditAfter: any =
          await fixture.operationAuditStore.getById(
            interrupted.evidence.auditId
          );
        expect(auditAfter).toBeTruthy();
        if (expectedAuditPresent) {
          expect(auditAfter).toEqual(auditBefore);
        }
        const proofReceiptsAfter: any =
          await listBoundSucceededMaterializationReceipts(
            fixture.operationProofSubstrate,
            {
              intentId: boundProofEntry.pactium.intentId,
              workspaceId: fixture.workspace.workspaceId
            }
          );
        expect(proofReceiptsAfter).toHaveLength(1);
        expect(proofReceiptsAfter[0]).toMatchObject({
          auditId: interrupted.evidence.auditId,
          idempotencyKey: admittedRecord.bindingDigest,
          ledgerEventId:
            completed.result.proofRef.replace(/^proof:/u, ""),
          pactium: {
            intentId: boundProofEntry.pactium.intentId,
            intentLedgerEventId: expect.any(String),
            outcomeLedgerEventId:
              completed.result.proofRef.replace(
                /^proof:/u,
                ""
              )
          },
          proof: {
            lifecycle: "two-stage",
            terminal: true
          },
          receiptRefs: [
            completed.result.checkpointRef
          ]
        });
        expect(await fixture.materializationEvents())
          .toEqual(eventsBefore);
        const proofLedgerEventId: any =
          completed.result.proofRef.replace(/^proof:/u, "");
        expect(proofReceiptsAfter[0].ledgerEventId)
          .toBe(proofLedgerEventId);
        if (proofReceiptsBefore.length === 1) {
          expect(proofReceiptsBefore[0].ledgerEventId)
            .toBe(proofLedgerEventId);
        }
        expect(completed.result).toMatchObject({
          byteCount: bytes.length,
          contentDigest: sha256(bytes),
          proofRef: `proof:${proofLedgerEventId}`,
          workspaceRevision: eventsBefore[0].afterRoot
        });
        await expect(
          fixture.operationProofSubstrate.getReceipt(
            proofLedgerEventId
          )
        ).resolves.toEqual(proofReceiptsAfter[0]);
        await expectTerminatedQueueRecovery(
          recoveredRuntime,
          admittedRecord.bindingDigest
        );
      },
      420_000
    );

    it("migrates a fully recognizable current-layout v0 transaction set and refuses sparse effectful or unknown layouts unchanged", async () : Promise<any> => {
      const fixture: any = await createFixture();
      const runtime: any = await fixture.openRuntime();
      const upload: any = await createCompletedUpload(
        fixture,
        Buffer.from("schema-fixture", "utf8"),
        "schema-fixture"
      );
      const rows: any[] = [];
      const expectedRecords: any = new Map<any, any>();
      const captureRow: any = async (requestRef?: any) : Promise<any> => {
        const row: any = readRawTransactionRow(
          fixture.root,
          requestRef
        );
        rows.push(row);
        expectedRecords.set(
          requestRef,
          clone(await runtime.transactionStore.get(requestRef))
        );
        return row;
      };

      await fixture.ensureTargetParent(
        "migration/completed.bin"
      );
      const completedAdmission: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { logicalTarget: "migration/completed.bin" }
      );
      await dispatchUntilTerminal(
        runtime,
        completedAdmission.payload.requestRef
      );
      await captureRow(
        completedAdmission.payload.requestRef
      );

      for (const [
        hookOwner,
        hookName,
        logicalTarget,
        expectedStage
      ] of [
        [
          "faultHooks",
          "afterPublicationIntentBeforeCustodyOpen",
          "migration/publication-intent.bin",
          "publication_intent"
        ],
        [
          "faultHooks",
          "afterTempReservedBeforeFirstWrite",
          "migration/temp-reserved.bin",
          "temp_reserved"
        ],
        [
          "faultHooks",
          "afterPublicationPreparedBeforeLink",
          "migration/publication-prepared.bin",
          "publication_prepared"
        ],
        [
          "faultHooks",
          "afterWorkspacePublish",
          "migration/published.bin",
          "published"
        ],
        [
          "faultHooks",
          "afterEvidencePending",
          "migration/evidence-pending.bin",
          "evidence_pending"
        ],
        [
          "faultHooks",
          "afterProofWriteBeforeRecord",
          "migration/audit-finalized.bin",
          "audit_finalized"
        ],
        [
          "transactionHooks",
          "afterProofFinalizedRecord",
          "migration/proof-finalized.bin",
          "proof_finalized"
        ]
      ]) {
        const pause: any = createPausePoint();
        fixture[hookOwner][hookName] = pause.hook;
        await fixture.ensureTargetParent(logicalTarget);
        const admission: any = await submitMaterialization(
          fixture,
          runtime,
          upload,
          { logicalTarget }
        );
        const dispatch: any = runtime.queueGate.dispatch();
        await pause.reached;
        const raw: any = await captureRow(
          admission.payload.requestRef
        );
        expect(raw.stage).toBe(expectedStage);
        pause.release();
        await dispatch;
        await dispatchUntilTerminal(
          runtime,
          admission.payload.requestRef
        );
        delete fixture[hookOwner][hookName];
      }

      const rollbackTarget: any =
        "migration/rollback/recovery.bin";
      await fixture.ensureTargetParent(rollbackTarget);
      const rollbackParent: any = path.dirname(path.join(
        fixture.workspaceRoot,
        rollbackTarget
      ));
      const displacedRollbackParent: any =
        `${rollbackParent}.displaced`;
      fixture.faultHooks
        .afterDirectoryWorkerBoundBeforeReserve =
        async () : Promise<any> => {
          await fs.rename(
            rollbackParent,
            displacedRollbackParent
          );
          await fs.mkdir(rollbackParent, {
            mode: 0o700,
            recursive: true
          });
        };
      const rollbackAdmission: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { logicalTarget: rollbackTarget }
      );
      const rollbackRecord: any = await dispatchUntilTerminal(
        runtime,
        rollbackAdmission.payload.requestRef
      );
      expect(rollbackRecord).toMatchObject({
        stage: "rollback_incomplete",
        status: "failed"
      });
      await captureRow(rollbackAdmission.payload.requestRef);
      delete fixture.faultHooks
        .afterDirectoryWorkerBoundBeforeReserve;

      const failedAdmission: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { logicalTarget: "migration/failed.bin" }
      );
      const originalRole: any =
        fixture.loginResult.session.user.roleId || "owner";
      try {
        await fixture.consoleAuth.updateUser(
          fixture.owner.subjectId,
          { roleId: "viewer" }
        );
        await dispatchUntilTerminal(
          runtime,
          failedAdmission.payload.requestRef
        );
      } finally {
        await fixture.consoleAuth.updateUser(
          fixture.owner.subjectId,
          { roleId: originalRole }
        );
      }
      const failedRow: any = readRawTransactionRow(
        fixture.root,
        failedAdmission.payload.requestRef
      );
      expect(failedRow.status).toBe("failed");
      await captureRow(failedAdmission.payload.requestRef);

      const cancelledAdmission: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { logicalTarget: "migration/cancelled.bin" }
      );
      await runtime.provider.cancel(
        cancelledAdmission.payload.requestRef,
        { subject: fixture.owner }
      );
      const cancelledRow: any = readRawTransactionRow(
        fixture.root,
        cancelledAdmission.payload.requestRef
      );
      expect(cancelledRow.status).toBe("cancelled");
      await captureRow(cancelledAdmission.payload.requestRef);

      const admitted: any = await submitMaterialization(
        fixture,
        runtime,
        upload,
        { logicalTarget: "migration/admitted.bin" }
      );
      const admittedRow: any = readRawTransactionRow(
        fixture.root,
        admitted.payload.requestRef
      );
      expect(admittedRow).toMatchObject({
        status: "queued",
        stage: "admitted"
      });
      await captureRow(admitted.payload.requestRef);
      expect(rows.map((row?: any) : any =>
        `${row.status}:${row.stage}`
      ).sort()).toEqual([
        "cancelled:admitted",
        "completed:completed",
        "failed:admitted",
        "failed:rollback_incomplete",
        "queued:admitted",
        "running:audit_finalized",
        "running:evidence_pending",
        "running:proof_finalized",
        "running:publication_intent",
        "running:publication_prepared",
        "running:published",
        "running:temp_reserved"
      ]);

      const migrationRoot: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-materialization-v0-")
      );
      cleanupTasks.push(() : any =>
        fs.rm(migrationRoot, { recursive: true, force: true })
      );
      const initialized: any =
        createUploadWorkspaceMaterializationTransactionStore({
          userDataPath: migrationRoot
        });
      initialized.close();
      const migrationDb: any = openSqliteDatabase(
        transactionDatabasePath(migrationRoot)
      );
      const currentColumns: any = migrationDb.prepare(
        "PRAGMA table_info(materialization_requests)"
      ).all().map((entry?: any) : any => entry.name);
      const insert: any = migrationDb.prepare(`
        INSERT INTO materialization_requests (
          ${currentColumns.join(", ")}
        ) VALUES (
          ${currentColumns.map(() : any => "?").join(", ")}
        )
      `);
      migrationDb.prepare(
        "DELETE FROM materialization_requests"
      ).run();
      for (const row of rows) {
        insert.run(...currentColumns.map(
          (column?: any) : any => row[column]
        ));
      }
      migrationDb.exec(`
        DROP TABLE materialization_schema_meta;
        DROP INDEX idx_materialization_requests_reconcile;
      `);
      migrationDb.pragma("user_version = 0");
      migrationDb.close();

      const migrated: any =
        createUploadWorkspaceMaterializationTransactionStore({
          userDataPath: migrationRoot
        });
      expect(migrated.count()).toBe(rows.length);
      for (const row of rows) {
        const record: any = await migrated.get(row.request_ref);
        expect(record).toEqual(
          expectedRecords.get(row.request_ref)
        );
      }
      migrated.close();
      const migratedDb: any = openSqliteDatabase(
        transactionDatabasePath(migrationRoot)
      );
      expect(
        Number(migratedDb.pragma(
          "user_version",
          { simple: true }
        ))
      ).toBe(1);
      expect(
        migratedDb.prepare(`
          SELECT 1
          FROM materialization_schema_meta
          WHERE singleton = 1
        `).get()
      ).toBeTruthy();
      expect(
        migratedDb.prepare(`
          SELECT 1
          FROM sqlite_master
          WHERE type = 'index' AND
                name = 'idx_materialization_requests_reconcile'
        `).get()
      ).toBeTruthy();
      migratedDb.close();

      const preparedRow: any = rows.find(
        (row?: any) : any => row.stage === "publication_prepared"
      );
      const canonicalPublication: any =
        preparedRow.publication_json;
      const canonicalDigest: any =
        JSON.parse(canonicalPublication).contentDigest;
      const conflictingPublication: any =
        canonicalPublication.replace(
          `"contentDigest":"${canonicalDigest}"`,
          [
            `"contentDigest":"${sha256(
              "conflicting-publication-digest"
            )}"`,
            `"contentDigest":"${canonicalDigest}"`
          ].join(",")
        );
      expect(JSON.parse(conflictingPublication))
        .toEqual(JSON.parse(canonicalPublication));
      expect(canonicalJson(
        JSON.parse(conflictingPublication)
      )).toBe(canonicalPublication);
      expect(conflictingPublication)
        .not.toBe(canonicalPublication);
      const conflictingRow: Record<string, any> = {
        ...preparedRow,
        publication_json: conflictingPublication
      };
      for (const [name, unversioned] of [
        ["conflicting-v0", true],
        ["persisted-current", false]
      ]) {
        const conflictingRoot: any = await fs.mkdtemp(
          path.join(
            os.tmpdir(),
            `meshrix-materialization-${name}-`
          )
        );
        cleanupTasks.push(() : any =>
          fs.rm(
            conflictingRoot,
            { recursive: true, force: true }
          )
        );
        seedCurrentLayoutRows(
          conflictingRoot,
          [conflictingRow],
          { unversioned }
        );
        const conflictingDbPath: any =
          transactionDatabasePath(conflictingRoot);
        const beforeDb: any = openSqliteDatabase(
          conflictingDbPath
        );
        const beforeLayout: any =
          snapshotDatabaseLayout(beforeDb);
        beforeDb.close();
        const beforeSidecars: any = (
          await fs.readdir(path.dirname(conflictingDbPath))
        ).sort();
        expect(() : any =>
          createUploadWorkspaceMaterializationTransactionStore({
            userDataPath: conflictingRoot
          })
        ).toThrow(expect.objectContaining({
          code: "materialization_schema_data_invalid"
        }));
        const afterDb: any = openSqliteDatabase(
          conflictingDbPath
        );
        expect(snapshotDatabaseLayout(afterDb))
          .toBe(beforeLayout);
        afterDb.close();
        expect((
          await fs.readdir(path.dirname(conflictingDbPath))
        ).sort()).toEqual(beforeSidecars);
      }

      const sparseRoot: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-materialization-sparse-")
      );
      cleanupTasks.push(() : any =>
        fs.rm(sparseRoot, { recursive: true, force: true })
      );
      await fs.mkdir(path.dirname(
        transactionDatabasePath(sparseRoot)
      ), { recursive: true });
      const sparseDb: any = openSqliteDatabase(
        transactionDatabasePath(sparseRoot)
      );
      sparseDb.exec(`
        CREATE TABLE materialization_requests (
          request_ref TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          stage TEXT NOT NULL,
          owner_fence TEXT NOT NULL DEFAULT '',
          lease_until INTEGER NOT NULL DEFAULT 0,
          request_json TEXT NOT NULL,
          preimage_json TEXT,
          target_state_digest TEXT NOT NULL DEFAULT '',
          parent_fingerprint TEXT NOT NULL DEFAULT '',
          publication_json TEXT,
          prior_revision TEXT NOT NULL DEFAULT '',
          published_revision TEXT NOT NULL DEFAULT '',
          result_json TEXT,
          error_json TEXT,
          updated_at TEXT NOT NULL
        );
      `);
      sparseDb.prepare(`
        INSERT INTO materialization_requests (
          request_ref,
          status,
          stage,
          owner_fence,
          lease_until,
          request_json,
          preimage_json,
          target_state_digest,
          parent_fingerprint,
          publication_json,
          prior_revision,
          published_revision,
          result_json,
          error_json,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        preparedRow.request_ref,
        preparedRow.status,
        preparedRow.stage,
        preparedRow.owner_fence,
        preparedRow.lease_until,
        preparedRow.request_json,
        preparedRow.preimage_json,
        preparedRow.target_state_digest,
        preparedRow.parent_fingerprint,
        preparedRow.publication_json,
        preparedRow.prior_revision,
        preparedRow.published_revision,
        preparedRow.result_json,
        preparedRow.error_json,
        preparedRow.updated_at
      );
      const sparseBefore: any = snapshotDatabaseLayout(sparseDb);
      sparseDb.close();
      const sparseSidecarsBefore: any = (
        await fs.readdir(path.dirname(
          transactionDatabasePath(sparseRoot)
        ))
      ).sort();
      expect(() : any =>
        createUploadWorkspaceMaterializationTransactionStore({
          userDataPath: sparseRoot
        })
      ).toThrow(expect.objectContaining({
        code: "materialization_schema_unsafe_legacy_data"
      }));
      const sparseAfterDb: any = openSqliteDatabase(
        transactionDatabasePath(sparseRoot)
      );
      expect(snapshotDatabaseLayout(sparseAfterDb))
        .toBe(sparseBefore);
      sparseAfterDb.close();
      expect((
        await fs.readdir(path.dirname(
          transactionDatabasePath(sparseRoot)
        ))
      ).sort()).toEqual(sparseSidecarsBefore);

      const unknownRoot: any = await fs.mkdtemp(
        path.join(os.tmpdir(), "meshrix-materialization-unknown-")
      );
      cleanupTasks.push(() : any =>
        fs.rm(unknownRoot, { recursive: true, force: true })
      );
      await fs.mkdir(path.dirname(
        transactionDatabasePath(unknownRoot)
      ), { recursive: true });
      const unknownDb: any = openSqliteDatabase(
        transactionDatabasePath(unknownRoot)
      );
      unknownDb.exec(`
        CREATE TABLE materialization_requests (
          request_ref TEXT PRIMARY KEY,
          unknown_state TEXT
        );
      `);
      const unknownBefore: any = snapshotDatabaseLayout(unknownDb);
      unknownDb.close();
      const unknownSidecarsBefore: any = (
        await fs.readdir(path.dirname(
          transactionDatabasePath(unknownRoot)
        ))
      ).sort();
      expect(() : any =>
        createUploadWorkspaceMaterializationTransactionStore({
          userDataPath: unknownRoot
        })
      ).toThrow(expect.objectContaining({
        code: "materialization_schema_layout_unknown"
      }));
      const unknownAfterDb: any = openSqliteDatabase(
        transactionDatabasePath(unknownRoot)
      );
      expect(snapshotDatabaseLayout(unknownAfterDb))
        .toBe(unknownBefore);
      unknownAfterDb.close();
      expect((
        await fs.readdir(path.dirname(
          transactionDatabasePath(unknownRoot)
        ))
      ).sort()).toEqual(unknownSidecarsBefore);
    }, 60_000);
  }
);
