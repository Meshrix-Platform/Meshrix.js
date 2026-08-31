import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  buildSkillHubStatsDashboard,
  createSkillHubContributionRegistry
} from "./skill-hub-registry.mjs";
import { createStateMutationQueue } from "./state-mutation-queue.mjs";
import {
  callerIdClaim,
  callerKindClaim,
  errorPayload,
  objectOrNull,
  protocolPayload,
  requiredWorkspaceId,
  result,
  workspaceIdFrom
} from "./operation-helpers.mjs";
import { createSkillHubOperationExecutor } from "./skill-hub-executor.mjs";
import { createSkillHubSandboxOperations } from "./skill-hub-sandbox.mjs";
import { materializeSkillHubAsset } from "./skill-hub-assets.mjs";
import {
  normalizeSkillHubContribution,
  projectPublicSkillHubContribution,
  projectSkillHubAssetRecord,
  SKILL_HUB_ASSET_BUCKETS,
  skillHubAssetBucketForType
} from "./skill-hub-contribution.mjs";

const MAX_PACKAGE_BYTES = 1024 * 1024;
const SANDBOX_OPERATIONS = new Set(["skill_hub.scan", "skill_hub.build", "skill_hub.execute"]);
const GLOBAL_REGISTRY_PARTITION = "default";
const WORKSPACE_BINDING_FIELDS = Object.freeze({
  "skill_hub.submit": "workspaceId",
  "skill_hub.scan": "workspaceId",
  "skill_hub.build": "workspaceId",
  "skill_hub.execute": "workspaceId",
  "skill_hub.download": "workspaceId",
  "skill_hub.install": "targetWorkspaceId",
  "skill_hub.usage.record": "workspaceId",
  "skill_hub.permission.request": "targetWorkspaceId",
  "skill_hub.permission.grant": "targetWorkspaceId"
});
const HOST_CONTEXT_SCHEMA = "v0.0.1:skill-hub:host-context-1";
const HOST_CONTEXT_FIELDS = new Set([
  "schemaVersion",
  "phase",
  "principal",
  "sandboxOutcome",
  "permissionGrantOutcome"
]);
const PRINCIPAL_FIELDS = new Set(["subjectRef", "tenantRef"]);
const SANDBOX_OUTCOME_FIELDS = new Set([
  "runRef",
  "workloadKind",
  "status",
  "artifactDigest",
  "inputDigests",
  "policyDigest",
  "cleanupState",
  "outputDisposition",
  "reasonCode",
  "failureStage",
  "createdAt"
]);
const PERMISSION_OUTCOME_FIELDS = new Set(["recorded", "receiptRef"]);

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function strictPackageBytes(value) {
  if (typeof value !== "string" || value.length < 4 || value.length % 4 !== 0 ||
      value.length > Math.ceil(MAX_PACKAGE_BYTES / 3) * 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw Object.assign(new Error("Skill package transport is invalid."), { code: "skill_hub_package_invalid" });
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength < 1 || bytes.byteLength > MAX_PACKAGE_BYTES || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw Object.assign(new Error("Skill package transport is invalid."), { code: "skill_hub_package_invalid" });
  }
  return bytes;
}

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32)}`;
}

function hostContextError() {
  return Object.assign(new Error("Skill Hub Host context is invalid."), {
    code: "skill_hub_host_context_invalid"
  });
}

function closedObject(value, fields) {
  if (!plainObject(value) || Object.keys(value).some((field) => !fields.has(field))) throw hostContextError();
  return value;
}

function contextText(value, maximum = 256) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw hostContextError();
  }
  return normalized;
}

function optionalContextText(value, maximum = 256) {
  const normalized = String(value || "").trim();
  if (normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) throw hostContextError();
  return normalized;
}

function digest(value, { prefixed = false, optional = false } = {}) {
  const normalized = String(value || "").trim();
  if (optional && !normalized) return "";
  const pattern = prefixed ? /^sha256:[a-f0-9]{64}$/u : /^[a-f0-9]{64}$/u;
  if (!pattern.test(normalized)) throw hostContextError();
  return normalized;
}

function parseHostContext(operationId, value) {
  const source = closedObject(value, HOST_CONTEXT_FIELDS);
  if (source.schemaVersion !== HOST_CONTEXT_SCHEMA) throw hostContextError();
  const phase = contextText(source.phase, 16);
  if (!["execute", "prepare", "commit"].includes(phase)) throw hostContextError();
  const principal = closedObject(source.principal, PRINCIPAL_FIELDS);
  const subjectRef = contextText(principal.subjectRef);
  const tenantRef = contextText(principal.tenantRef);
  if (!/^skill_hub_subject_[a-f0-9]{64}$/u.test(subjectRef) ||
      !/^skill_hub_tenant_[a-f0-9]{64}$/u.test(tenantRef)) {
    throw hostContextError();
  }

  let sandboxOutcome = null;
  if (source.sandboxOutcome !== undefined) {
    const outcome = closedObject(source.sandboxOutcome, SANDBOX_OUTCOME_FIELDS);
    if (!Array.isArray(outcome.inputDigests) || outcome.inputDigests.length !== 1) throw hostContextError();
    const createdAt = contextText(outcome.createdAt, 64);
    if (!Number.isFinite(Date.parse(createdAt))) throw hostContextError();
    sandboxOutcome = Object.freeze({
      runId: digest(outcome.runRef, { prefixed: true }),
      workloadKind: contextText(outcome.workloadKind, 64),
      status: contextText(outcome.status, 64),
      artifactDigest: digest(outcome.artifactDigest, { optional: true }),
      inputDigests: Object.freeze(outcome.inputDigests.map((entry) => digest(entry))),
      policyDigest: digest(outcome.policyDigest),
      cleanupState: optionalContextText(outcome.cleanupState, 64),
      outputDisposition: optionalContextText(outcome.outputDisposition, 64),
      reasonCode: optionalContextText(outcome.reasonCode, 128),
      failureStage: optionalContextText(outcome.failureStage, 128),
      createdAt: new Date(Date.parse(createdAt)).toISOString()
    });
  }

  let permissionGrantOutcome = null;
  if (source.permissionGrantOutcome !== undefined) {
    const outcome = closedObject(source.permissionGrantOutcome, PERMISSION_OUTCOME_FIELDS);
    if (outcome.recorded !== true) throw hostContextError();
    permissionGrantOutcome = Object.freeze({
      ok: true,
      receiptId: digest(outcome.receiptRef, { prefixed: true })
    });
  }

  const sandboxOperation = SANDBOX_OPERATIONS.has(operationId);
  const permissionOperation = operationId === "skill_hub.permission.grant";
  const prepareInvalid = phase === "prepare" && (
    !sandboxOperation && !permissionOperation || Boolean(sandboxOutcome) || Boolean(permissionGrantOutcome)
  );
  const commitInvalid = phase === "commit" && (
    !sandboxOperation && !permissionOperation ||
    sandboxOperation !== Boolean(sandboxOutcome) ||
    permissionOperation !== Boolean(permissionGrantOutcome)
  );
  const executeInvalid = phase === "execute" && (
    sandboxOperation || permissionOperation || Boolean(sandboxOutcome) || Boolean(permissionGrantOutcome)
  );
  if (prepareInvalid || commitInvalid || executeInvalid) {
    throw hostContextError();
  }

  return Object.freeze({
    phase,
    principal: Object.freeze({ subjectRef, tenantRef }),
    sandboxOutcome,
    permissionGrantOutcome
  });
}

function bindExplicitWorkspace(operationId, input) {
  const field = WORKSPACE_BINDING_FIELDS[operationId];
  if (!field) return input;
  return { ...input, [field]: requiredWorkspaceId(input[field], field) };
}

export async function createSkillHubApplication({ serviceData }) {
  if (!serviceData) throw new TypeError("Skill Hub application requires service data.");
  await serviceData.initialize();
  const lifecycleDefinition = Object.freeze(JSON.parse(await readFile(
    new URL("../state-machines/contribution.lifecycle.json", import.meta.url),
    "utf8"
  )));
  const mutationQueue = createStateMutationQueue();
  const registrySessions = new Map();
  let closed = false;

  function registryDescriptor(input = {}) {
    const requestedPartition = String(
      input.registryWorkspaceId || input.contributionRegistryWorkspaceId || ""
    ).trim();
    const workspaceId = requestedPartition || GLOBAL_REGISTRY_PARTITION;
    const registryId = crypto.createHash("sha256").update(workspaceId).digest("hex");
    return Object.freeze({
      workspaceId,
      registryRelativePath: path.posix.join("SkillHub", "registries", `${registryId}.json`),
      queueKey: `skill-hub-registry:${registryId}`
    });
  }

  async function contributionRegistryFor(input = {}) {
    const descriptor = registryDescriptor(input);
    if (!registrySessions.has(descriptor.registryRelativePath)) {
      registrySessions.set(descriptor.registryRelativePath, (async () => {
        let initialPersistedState;
        try {
          initialPersistedState = JSON.parse(await serviceData.readFile(descriptor.registryRelativePath, "utf8"));
        } catch (error) {
          if (error?.code !== "SERVICE_DATA_NOT_FOUND") throw error;
        }
        let persistenceTail = Promise.resolve();
        const schedulePersistence = (operation) => {
          persistenceTail = persistenceTail.then(operation);
          return persistenceTail;
        };
        const registry = createSkillHubContributionRegistry({
          workspaceId: descriptor.workspaceId,
          initialPersistedState,
          schedulePersistence,
          serviceData: serviceData,
          registryRelativePath: descriptor.registryRelativePath,
          contributionNormalizer: normalizeSkillHubContribution,
          materializeAsset: materializeSkillHubAsset,
          assetRecordProjector: projectSkillHubAssetRecord,
          assetBucketResolver: skillHubAssetBucketForType,
          assetBuckets: SKILL_HUB_ASSET_BUCKETS,
          lifecycleDefinition
        });
        const asynchronous = { protocolVersion: registry.protocolVersion };
        for (const [name, method] of Object.entries(registry)) {
          if (typeof method !== "function" || name.startsWith("_")) continue;
          asynchronous[name] = async (...args) => {
            await persistenceTail;
            const snapshot = registry._snapshotState();
            try {
              const output = await Reflect.apply(method, registry, args);
              await persistenceTail;
              return output;
            } catch (error) {
              registry._restoreState(snapshot);
              persistenceTail = Promise.resolve();
              throw error;
            }
          };
        }
        return Object.freeze(asynchronous);
      })());
    }
    return registrySessions.get(descriptor.registryRelativePath);
  }

  function filterContributionsForWorkspace(items = [], input = {}) {
    const workspaceId = String(input.workspaceId || input.workspace || "").trim();
    if (!workspaceId || !items.some((item) => Object.hasOwn(item, "workspaceId"))) return items;
    return items.filter((item) => item.workspaceId === workspaceId);
  }

  const executeOperation = createSkillHubOperationExecutor({
    assetRecordProjector: projectSkillHubAssetRecord,
    buildContributionStatsDashboard: buildSkillHubStatsDashboard,
    callerIdClaim,
    callerKindClaim,
    contributionRegistryFor,
    errorPayload,
    filterContributionsForWorkspace,
    objectOrNull,
    projectPublicSkillHubContribution,
    protocolPayload,
    result,
    workspaceIdFrom
  });
  const sandboxOperations = createSkillHubSandboxOperations({ contributionRegistryFor, workspaceIdFrom });

  function callContext(input, hostContext) {
    const { subjectRef, tenantRef } = hostContext.principal;
    return {
      serviceData: serviceData,
      transport: "http-service",
      subject: {
        type: "meshrix-service-principal",
        subjectId: subjectRef,
        scopes: []
      },
      governance: {
        authorized: true,
        current: true
      },
      principal: { subjectRef, tenantRef },
      contributionRegistryWorkspaceId: String(input.contributionRegistryWorkspaceId || input.registryWorkspaceId || ""),
      skillId: String(input.skillId || ""),
      contributionId: String(input.contributionId || "")
    };
  }

  async function prepareSubmission(input) {
    const bytes = strictPackageBytes(input.packageBundleBase64);
    const byteCount = bytes.byteLength;
    const digest = crypto.createHash("sha256").update(bytes).digest("hex");
    const resource = serviceData.packageResource(digest);
    await serviceData.writeFile(resource, bytes, null);
    bytes.fill(0);
    const prepared = { ...input };
    delete prepared.packageBundleBase64;
    const custodyRef = `service-package:${digest}`;
    prepared.packageBundle = {
      schemaVersion: "v0.0.1:skill-hub:package-handle-1",
      custodyRef,
      contentDigest: digest,
      envelopeDigest: crypto.createHash("sha256").update(`skill-hub-service\0${digest}`).digest("hex"),
      byteCount
    };
    return { prepared, resource, custodyRef };
  }

  async function packagePayload(prepared) {
    const resource = serviceData.packageResource(prepared.packageDigest);
    const bytes = await serviceData.readFile(resource, null);
    if (!Buffer.isBuffer(bytes) || crypto.createHash("sha256").update(bytes).digest("hex") !== prepared.packageDigest) {
      throw Object.assign(new Error("Stored skill package integrity failed."), { code: "skill_hub_package_integrity_failed" });
    }
    const encoded = bytes.toString("base64");
    bytes.fill(0);
    return encoded;
  }

  async function prepareGrant(input, context) {
    const registry = await contributionRegistryFor(input, context);
    const contribution = await registry.getContribution(input.skillId);
    if (!["published", "adopted", "deprecated"].includes(contribution.status)) {
      throw Object.assign(new Error("Permission grants require a published revision."), {
        code: "contribution_permission_not_published"
      });
    }
    const targetWorkspaceId = requiredWorkspaceId(input.targetWorkspaceId, "targetWorkspaceId");
    const actions = [...new Set((Array.isArray(input.actions) ? input.actions : contribution.requestedActions).map(String))].sort();
    const request = [...contribution.permissionRequests].reverse().find((item) =>
      item.status === "requested" && item.targetWorkspaceId === targetWorkspaceId &&
      actions.every((action) => item.actions.includes(action))
    );
    if (!request) throw Object.assign(new Error("Contribution grant requires a matching permission request."), {
      code: "contribution_grant_request_required"
    });
    const grant = {
      contributionId: contribution.contributionId,
      granteeId: context.principal.subjectRef,
      targetWorkspaceId,
      actions,
      expiresAt: String(input.expiresAt || ""),
      revocationPolicy: String(input.revocationPolicy || "revoke-on-policy-change")
    };
    return Object.freeze({
      loanRecordId: stableId("contribution_loan_record", grant),
      ...grant,
      workspaceId: contribution.workspaceId,
      canShare: input.canShare === true,
      canRetain: input.canRetain === true
    });
  }

  async function invoke(operationId, rawInput = {}) {
    if (closed) return { statusCode: 503, body: errorPayload({ code: "skill_hub_service_closed" }) };
    if (!plainObject(rawInput)) return { statusCode: 400, body: errorPayload({ code: "skill_hub_request_invalid" }) };
    const receivedInput = { ...rawInput };
    let hostContext;
    try {
      hostContext = parseHostContext(operationId, receivedInput.meshrixContext);
    } catch (error) {
      return { statusCode: 400, body: errorPayload(error) };
    }
    delete receivedInput.meshrixContext;
    let input;
    try {
      input = bindExplicitWorkspace(operationId, receivedInput);
    } catch (error) {
      return { statusCode: 400, body: errorPayload(error) };
    }
    const { phase, sandboxOutcome: remoteReceipt, permissionGrantOutcome: hostReceipt } = hostContext;
    const context = callContext(input, hostContext);
    const descriptor = registryDescriptor(input);

    return mutationQueue.run(descriptor.queueKey, async () => {
      try {
        context.contributionRegistry = await contributionRegistryFor(input, context);
        if (operationId === "skill_hub.submit") {
          const submission = await prepareSubmission(input);
          context.packageCustody = Object.freeze({
            async delete() {
              await serviceData.deleteFile(submission.resource);
              return Object.freeze({ ok: true });
            }
          });
          const response = await executeOperation({ operationId, input: submission.prepared, context });
          return { statusCode: response.status, body: response.payload };
        }
        if (SANDBOX_OPERATIONS.has(operationId)) {
          if (phase === "prepare") {
            const prepared = await sandboxOperations.prepare({ operationId, input, context });
            return {
              statusCode: 200,
              body: protocolPayload({
                protocolVersion: "v0.0.1:skill-hub:service-1",
                execution: {
                  request: prepared.request,
                  packageDigest: prepared.packageDigest,
                  packagePath: prepared.packageBundle.path,
                  packageBundleBase64: await packagePayload(prepared)
                }
              })
            };
          }
          if (phase !== "commit" || !remoteReceipt) {
            throw Object.assign(new Error("Sandbox completion receipt is required."), {
              code: "skill_hub_sandbox_receipt_required"
            });
          }
          const committed = await sandboxOperations.commit({ operationId, input, context, rawReceipt: remoteReceipt });
          return {
            statusCode: 200,
            body: protocolPayload({
              protocolVersion: "v0.0.1:skill-hub:service-1",
              receipt: committed.receipt,
              ...(committed.scan ? { scan: {
                contribution: projectPublicSkillHubContribution(committed.scan.contribution),
                lifecycleDecision: committed.scan.lifecycleDecision
              } } : {})
            })
          };
        }
        if (operationId === "skill_hub.permission.grant" && phase === "prepare") {
          return {
            statusCode: 200,
            body: protocolPayload({
              protocolVersion: "v0.0.1:skill-hub:service-1",
              loanRecord: await prepareGrant(input, context)
            })
          };
        }
        if (operationId === "skill_hub.permission.grant") {
          context.operationPermissionGrant = Object.freeze({
            async recordPluginGrant() {
              return hostReceipt || Object.freeze({ ok: false });
            }
          });
        }
        const response = await executeOperation({ operationId, input, context });
        if (!response) return { statusCode: 404, body: errorPayload({ code: "skill_hub_operation_not_found" }) };
        return { statusCode: response.status, body: response.payload };
      } catch (error) {
        return { statusCode: 400, body: errorPayload(error) };
      }
    });
  }

  return Object.freeze({
    invoke,
    async close() {
      if (closed) return Object.freeze({ ok: true, alreadyClosed: true });
      closed = true;
      await mutationQueue.close();
      await Promise.allSettled([...registrySessions.values()]);
      return Object.freeze({ ok: true, alreadyClosed: false });
    }
  });
}
