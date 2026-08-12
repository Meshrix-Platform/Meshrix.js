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
    const workspaceId = workspaceIdFrom({
      workspaceId: input.registryWorkspaceId || input.contributionRegistryWorkspaceId
    }, "default");
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

  function callContext(input, metadata) {
    const actorId = String(metadata.actorId || "anonymous").trim() || "anonymous";
    const tenantRef = String(metadata.tenantRef || input.workspaceId || input.workspace || "default").trim() || "default";
    return {
      serviceData: serviceData,
      transport: "http-service",
      subject: {
        type: String(metadata.actorKind || "meshrix-adapter"),
        subjectId: actorId,
        scopes: []
      },
      governance: {
        authorized: metadata.authorized === true,
        current: metadata.current === true
      },
      principal: { subjectRef: actorId, tenantRef },
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
    const targetWorkspaceId = String(input.targetWorkspaceId || input.workspaceId || contribution.workspaceId);
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
    const input = { ...rawInput };
    const metadata = plainObject(input.__meshrix) ? input.__meshrix : {};
    const phase = String(metadata.phase || "execute");
    const remoteReceipt = plainObject(metadata.receipt) ? metadata.receipt : null;
    const hostReceipt = plainObject(metadata.operationPermissionReceipt) ? metadata.operationPermissionReceipt : null;
    delete input.__meshrix;
    const context = callContext(input, metadata);
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
