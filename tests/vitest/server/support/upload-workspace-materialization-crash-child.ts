import path from "node:path";

import { SERVER_API_OPERATIONS } from "../../../../packages/contracts/src/operations/operation-registry.ts";
import { createSqliteWorkQueueStore } from "../../../../packages/foundation/src/work-queue/sqlite-store.ts";
import { createServerCompositionRoot } from "../../../../packages/server-runtime/src/composition/composition-root.ts";
import { createQueueApplicationPort } from "../../../../packages/server-runtime/src/composition/queue-application-port.ts";
import { createUploadWorkspaceMaterializationTransactionStore } from "../../../../packages/server-runtime/src/composition/upload-workspace-materialization-provider.ts";

const OPERATION_ID: any = "jobs.upload_workspace_materialize";
const LEASE_MS: any = 250;
const ADMISSION_USERNAME: any = "materialization-crash-owner";
const ADMISSION_PASSWORD: any =
  "Synthetic-Materialization-Crash-Owner-42!";
const CRASH_STAGES: any = new Set<any>([
  "after_transaction_created_before_enqueue",
  "after_queue_claim",
  "after_publication_intent",
  "after_directory_worker_bound",
  "after_temp_inode_reserved_before_wal",
  "after_temp_reserved",
  "after_first_chunk_written",
  "after_publication_prepared",
  "after_publication_linked",
  "after_published_file_durable",
  "after_state_commit",
  "after_evidence_pending",
  "after_audit_write",
  "after_audit_finalized_record",
  "after_proof_write",
  "after_proof_finalized_record",
  "after_transaction_completed_before_queue_ack"
]);
const SAFE_CODE: any = /^[a-z0-9][a-z0-9._:-]{0,79}$/u;

let started: any = false;
let keepAlive: any = null;

function boundedCount(value?: any) : any {
  const number: any = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? Math.min(number, 1_000_000)
    : 0;
}

function safeCode(value?: any, fallback: any = "child_failure") : any {
  const normalized: any = String(value || "").trim().toLowerCase();
  return SAFE_CODE.test(normalized) ? normalized : fallback;
}

function boundedText(value?: any) : any {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 768 &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function emitMarker(marker?: any) : any {
  const payload: Readonly<Record<string, any>> = Object.freeze({
    kind: marker.kind === "ready" ? "ready" : "failed",
    stage: CRASH_STAGES.has(marker.stage)
      ? marker.stage
      : "after_queue_claim",
    code: safeCode(marker.code, marker.kind === "ready"
      ? "ready"
      : "child_failure"),
    queueClaims: boundedCount(marker.queueClaims),
    finalPermits: boundedCount(marker.finalPermits),
    custodyReads: boundedCount(marker.custodyReads),
    archiveWrites: boundedCount(marker.archiveWrites),
    stateCommits: boundedCount(marker.stateCommits)
  });
  return new Promise((resolve?: any) : any => {
    if (typeof process.send !== "function") {
      resolve();
      return;
    }
    process.send(payload, () : any => resolve());
  });
}

function validateConfiguration(value?: any) : any {
  const crashStage: any = String(value?.crashStage || "");
  const admissionCrash: any =
    crashStage === "after_transaction_created_before_enqueue";
  const expectedKeys: any = admissionCrash
    ? ["admission", "crashStage", "root"]
    : ["crashStage", "root"];
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !==
      expectedKeys.join("\0")
  ) {
    throw Object.assign(
      new TypeError("Crash-child configuration is invalid."),
      { code: "child_configuration_invalid" }
    );
  }
  const root: any = String(value.root || "");
  if (!path.isAbsolute(root) || !CRASH_STAGES.has(crashStage)) {
    throw Object.assign(
      new TypeError("Crash-child configuration is invalid."),
      { code: "child_configuration_invalid" }
    );
  }
  let admission: any = null;
  if (admissionCrash) {
    const candidate: any = value.admission;
    const keys: any[] = [
      "expectedWorkspaceRevision",
      "logicalTarget",
      "uploadSessionId",
      "workspaceId"
    ];
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join("\0") !==
        keys.join("\0") ||
      keys.some((key?: any) : any => !boundedText(candidate[key]))
    ) {
      throw Object.assign(
        new TypeError("Crash-child admission is invalid."),
        { code: "child_configuration_invalid" }
      );
    }
    admission = Object.freeze(
      Object.fromEntries(keys.map((key?: any) : any => [key, candidate[key]]))
    );
  }
  return Object.freeze({ admission, root, crashStage });
}

async function run(configuration?: any) : Promise<any> {
  keepAlive = setInterval(() : any => {}, 1_000);
  const counters: Record<string, any> = {
    queueClaims: 0,
    finalPermits: 0,
    custodyReads: 0,
    archiveWrites: 0,
    stateCommits: 0
  };
  let halted: any = false;
  let signalStageReached: any;
  const stageReached: any = new Promise((resolve?: any) : any => {
    signalStageReached = resolve;
  });
  const halt: any = async (stage?: any) : Promise<any> => {
    if (halted || configuration.crashStage !== stage) return;
    halted = true;
    await emitMarker({
      kind: "ready",
      stage,
      code: "ready",
      ...counters
    });
    signalStageReached();
    await new Promise(() : any => {});
  };

  const operation: any = SERVER_API_OPERATIONS.find(
    (candidate?: any) : any => candidate.id === OPERATION_ID
  );
  if (!operation) {
    throw Object.assign(
      new Error("Materialization operation is unavailable."),
      { code: "child_operation_unavailable" }
    );
  }

  const runtimeLogger: Readonly<Record<string, any>> = Object.freeze({
    debug() : any {},
    error() : any {},
    info() : any {},
    warn() : any {}
  });
  const compositionRoot: any = await createServerCompositionRoot({
    runtimeLogger,
    runtimeOptions: {
      enabledPlugins: [],
      pluginConfigurations: {},
      profile: "minimal"
    },
    userDataPath: configuration.root
  });
  const {
    consoleAuth,
    dataStructureSubstrate,
    deferredProtectedSinkAuthorityPort: authorityPort,
    operationAuditStore,
    operationProofSubstrate,
    securityPermissions,
    uploadNoRunCustody: noRunCustody,
    uploadSessionStore
  } = compositionRoot;
  const uploadCustodyReadPort: Readonly<Record<string, any>> = Object.freeze({
    async open(input?: any) : Promise<any> {
      counters.custodyReads += 1;
      return noRunCustody.readPort.open(input);
    }
  });
  const runtimeProviders: any =
    await compositionRoot.createBoundRuntimeProviders({
      activeFeatureIds:
        compositionRoot.featureRuntime.activeFeatureIds,
      dataStructureSubstrate,
      getControllers: () : any => Object.freeze({}),
      getDiscoveryState: () : any => Object.freeze({}),
      getJobWorkflowProvider: () : any => null,
      getListenUrl: () : any => "",
      getOperationPermissionPlatform: () : any => null,
      isAnyFeatureActive: compositionRoot.isAnyFeatureActive,
      isFeatureActive: compositionRoot.isFeatureActive,
      jobManager: null,
      operationAuditStore,
      operationConcurrencyScope:
        compositionRoot.operationConcurrencyScope,
      operationLockManager:
        compositionRoot.operationLockManager,
      operationProofSubstrate,
      protocolEventBus: compositionRoot.protocolEventBus,
      queueApplicationPort:
        compositionRoot.queueApplicationPort,
      runtime: compositionRoot.runtime,
      runtimeLogger,
      securityPermissions,
      userDataPath: configuration.root
    });
  if (!runtimeProviders.agentWorkspace) {
    throw Object.assign(
      new Error("Root-owned agent workspace is unavailable."),
      { code: "child_workspace_unavailable" }
    );
  }

  const transactionStore: any =
    createUploadWorkspaceMaterializationTransactionStore({
      leaseMs: LEASE_MS,
      userDataPath: configuration.root
    });
  const observedTransactionStore: Readonly<Record<string, any>> = Object.freeze({
    ...transactionStore,
    async recordAuditFinalized(...args: any[]) : Promise<any> {
      const recorded: any =
        await transactionStore.recordAuditFinalized(...args);
      await halt("after_audit_finalized_record");
      return recorded;
    },
    async recordProofFinalized(...args: any[]) : Promise<any> {
      const recorded: any =
        await transactionStore.recordProofFinalized(...args);
      await halt("after_proof_finalized_record");
      return recorded;
    }
  });
  const queueStore: any = createSqliteWorkQueueStore({
    userDataPath: configuration.root,
    policy: { leaseTimeoutMs: LEASE_MS }
  });
  const queueApplicationPort: any = await createQueueApplicationPort({
    dispatchIntervalMs: 60_000,
    store: queueStore,
    userDataPath: configuration.root
  });
  let queueFacet: any = null;
  const queueRegistrationPort: Readonly<Record<string, any>> = Object.freeze({
    async registerQueue(definition?: any) : Promise<any> {
      queueFacet = await queueApplicationPort.registerQueue(definition);
      return queueFacet;
    }
  });

  const provider: any =
    await compositionRoot
      .createBoundUploadWorkspaceMaterializationProvider({
    deferredProtectedSinkAuthorityPort: authorityPort,
    faultInjector: Object.freeze({
      async afterTransactionCreatedBeforeEnqueue() : Promise<any> {
        await halt("after_transaction_created_before_enqueue");
      },
      async afterQueueClaim() : Promise<any> {
        counters.queueClaims += 1;
        await halt("after_queue_claim");
      },
      async afterTransactionCompletedBeforeQueueAck() : Promise<any> {
        await halt("after_transaction_completed_before_queue_ack");
      },
      async afterFinalPermitConsumed() : Promise<any> {
        counters.finalPermits += 1;
      },
      async afterPublicationIntentBeforeCustodyOpen() : Promise<any> {
        await halt("after_publication_intent");
      },
      async afterDirectoryWorkerBoundBeforeReserve() : Promise<any> {
        await halt("after_directory_worker_bound");
      },
      async afterTempInodeReservedBeforeWal() : Promise<any> {
        await halt("after_temp_inode_reserved_before_wal");
      },
      async afterTempReservedBeforeFirstWrite() : Promise<any> {
        await halt("after_temp_reserved");
      },
      async afterFirstChunkWrittenBeforeContinue() : Promise<any> {
        await halt("after_first_chunk_written");
      },
      async afterPublicationPreparedBeforeLink() : Promise<any> {
        await halt("after_publication_prepared");
      },
      async afterPublicationLinkedBeforeTempUnlink() : Promise<any> {
        await halt("after_publication_linked");
      },
      async afterPublishedFileDurableBeforeStateCommit() : Promise<any> {
        await halt("after_published_file_durable");
      },
      async afterStateAndCheckpointDurableBeforeReceipt() : Promise<any> {
        counters.stateCommits += 1;
        await halt("after_state_commit");
      },
      async afterEvidencePending() : Promise<any> {
        await halt("after_evidence_pending");
      },
      async afterAuditWriteBeforeRecord() : Promise<any> {
        await halt("after_audit_write");
      },
      async afterProofWriteBeforeRecord() : Promise<any> {
        await halt("after_proof_write");
      }
    }),
    operationAuditStore,
    operationProofSubstrate,
    queueApplicationPort: queueRegistrationPort,
    resolveOperation(operationId?: any) : any {
      return operationId === OPERATION_ID ? operation : null;
    },
    transactionStore: observedTransactionStore,
    uploadCustodyReadPort,
    uploadSessionStore,
    userDataPath: configuration.root
  });
  if (!queueFacet) {
    throw Object.assign(
      new Error("Materialization queue binding failed."),
      { code: "child_queue_unavailable" }
    );
  }
  if (
    configuration.crashStage ===
      "after_transaction_created_before_enqueue"
  ) {
    const loginRequest: Readonly<Record<string, any>> = Object.freeze({
      headers: Object.freeze({
        host: "console.local",
        origin: "http://console.local",
        "user-agent": "meshrix-materialization-crash-child"
      }),
      method: "POST",
      socket: Object.freeze({
        encrypted: false,
        remoteAddress: "127.0.0.1"
      }),
      url: "/api/console/auth/login"
    });
    const login: any = await consoleAuth.login({
      password: ADMISSION_PASSWORD,
      username: ADMISSION_USERNAME
    }, loginRequest);
    const cookie: any = login.cookies.map((value?: any) : any =>
      String(value).split(";", 1)[0]
    ).join("; ");
    const request: Readonly<Record<string, any>> = Object.freeze({
      headers: Object.freeze({
        cookie,
        host: "console.local",
        origin: "http://console.local",
        "user-agent": "meshrix-materialization-crash-child",
        "x-meshrix-csrf": login.csrfToken,
        "x-meshrix-safety-confirm": "true"
      }),
      method: "POST",
      socket: Object.freeze({
        encrypted: false,
        remoteAddress: "127.0.0.1"
      }),
      url: "/api/jobs/upload-workspace-materializations"
    });
    await provider.submit({
      authSession: login.session,
      input: Object.freeze({
        ...configuration.admission,
        safetyConfirm: true
      }),
      operation,
      request
    });
  } else {
    await queueFacet.requestDispatch();
  }
  await Promise.race([
    stageReached,
    new Promise((_?: any, reject?: any) : any => {
      const timeout: any = setTimeout(() : any => {
        reject(Object.assign(
          new Error("Crash stage was not reached."),
          { code: "child_crash_stage_not_reached" }
        ));
      }, 20_000);
      timeout.unref?.();
    })
  ]);
  await new Promise(() : any => {});
}

process.once("message", (value?: any) : any => {
  if (started) return;
  started = true;
  let configuration: any;
  try {
    configuration = validateConfiguration(value);
  } catch (error: any) {
    void emitMarker({
      kind: "failed",
      stage: "after_queue_claim",
      code: error?.code
    }).finally(() : any => {
      process.exitCode = 1;
    });
    return;
  }
  void run(configuration).catch(async (error?: any) : Promise<any> => {
    if (keepAlive) clearInterval(keepAlive);
    await emitMarker({
      kind: "failed",
      stage: configuration.crashStage,
      code: error?.code || error?.name
    });
    process.exitCode = 1;
  });
});
