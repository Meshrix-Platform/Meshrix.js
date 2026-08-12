import crypto from "node:crypto";
import path from "node:path";
import { sandboxDigest } from "./skill-hub-contracts.mjs";
import {
  isSkillHubStorageRelativePath,
  SKILL_HUB_SKILL_STORAGE_DIR,
  SKILL_HUB_STORAGE_ROOT_DIR
} from "./skill-hub-storage.mjs";
import { SKILL_HUB_PACKAGE_PATH } from "./skill-hub-package.mjs";

const SKILL_HUB_MAX_PACKAGE_BYTES = 1024 * 1024;
const SKILL_HUB_EXECUTABLE_EXTENSIONS = new Set([
  ".app",
  ".bat",
  ".cmd",
  ".command",
  ".dmg",
  ".exe",
  ".msi",
  ".ps1",
  ".sh"
]);

function defaultObjectOrNull(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function requiredFunction(name, value) {
  if (typeof value !== "function") {
    throw new Error(`Skill Hub executor requires ${name}.`);
  }
  return value;
}

function asArrayLike(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function stableSkillHubJson(value) {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableSkillHubJson(item)).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSkillHubJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function skillHubSha256(value, length = 64) {
  const content = Buffer.isBuffer(value) ? value : String(value || "");
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, length);
}

function publicSkillHubActorId(subject = {}, actorId = "") {
  const normalized = String(actorId || "").trim();
  if (subject.type !== "tool-grant" || !normalized) return normalized;
  return `tool-grant-${skillHubSha256(normalized, 18)}`;
}

function normalizeSkillHubRef(ref = "") {
  const value = String(ref || "").trim().replace(/\\/g, "/");
  if (!value || value.includes("\0") || value.startsWith("/") || value.startsWith("~")) {
    throw new Error("Skill package references must be non-empty repository-relative paths.");
  }
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error("Skill package references must not traverse outside the package boundary.");
  }
  if (SKILL_HUB_EXECUTABLE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase())) {
    throw new Error("Skill package references must not declare executable auto-run artifacts.");
  }
  return normalized;
}

export function createSkillHubOperationExecutor(dependencies = {}) {
  const assetRecordProjector = requiredFunction("assetRecordProjector", dependencies.assetRecordProjector);
  const buildContributionStatsDashboard = requiredFunction(
    "buildContributionStatsDashboard",
    dependencies.buildContributionStatsDashboard
  );
  const callerIdClaim = requiredFunction("callerIdClaim", dependencies.callerIdClaim);
  const callerKindClaim = requiredFunction("callerKindClaim", dependencies.callerKindClaim);
  const contributionRegistryFor = requiredFunction("contributionRegistryFor", dependencies.contributionRegistryFor);
  const errorPayload = requiredFunction("errorPayload", dependencies.errorPayload);
  const filterContributionsForWorkspace = requiredFunction(
    "filterContributionsForWorkspace",
    dependencies.filterContributionsForWorkspace
  );
  const objectOrNull = typeof dependencies.objectOrNull === "function"
    ? dependencies.objectOrNull
    : defaultObjectOrNull;
  const projectPublicContribution = requiredFunction(
    "projectPublicSkillHubContribution",
    dependencies.projectPublicSkillHubContribution
  );
  const protocolPayload = requiredFunction("protocolPayload", dependencies.protocolPayload);
  const result = requiredFunction("result", dependencies.result);
  const workspaceIdFrom = requiredFunction("workspaceIdFrom", dependencies.workspaceIdFrom);

  function skillHubSkillId(input = {}, context = {}) {
    return String(
      context.skillId ||
        context.contributionId ||
        input.skillId ||
        input["skill-id"] ||
        input.contributionId ||
        input["contribution-id"] ||
        input.id ||
        ""
    ).trim();
  }

  function visibleContribution(contribution = {}) {
    return ["published", "adopted", "deprecated"].includes(String(contribution.status || ""));
  }

  async function skillHubItemsForInput(registry, input = {}, { visibleOnly = true } = {}) {
    const query = String(input.query || input.q || input.search || "").trim().toLowerCase();
    const limit = Number(input.limit || 0);
    const items = filterContributionsForWorkspace(await registry.listContributions(), input)
      .filter((item) => item.contributionType === "skill")
      .filter((item) => !visibleOnly || visibleContribution(item))
      .filter((item) => {
        if (!query) return true;
        const haystack = [
          item.contributionId,
          item.title,
          item.contributorId,
          item.skillManifestRef,
          ...(Array.isArray(item.payloadRefs) ? item.payloadRefs : []),
          ...(Array.isArray(item.requestedActions) ? item.requestedActions : [])
        ].map((value) => String(value || "").toLowerCase()).join("\n");
        return haystack.includes(query);
      });
    return limit > 0 ? items.slice(0, Math.min(limit, 500)) : items;
  }

  function assertSkillHubPackagePolicy(input = {}) {
    const license = String(input.license || "").trim();
    if (!license || license === "UNREVIEWED") {
      throw new Error("Skill package submissions require an explicit reviewed license.");
    }
    const declaredPermissions = asArrayLike(input.declaredPermissions || input.permissions || input.requestedActions || input.actions)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    if (declaredPermissions.length === 0) {
      throw new Error("Skill package submissions require declared permissions.");
    }
    const refs = [
      input.skillManifestRef || input.manifestRef,
      input.skillPackageRef || input.packageRef,
      ...asArrayLike(input.payloadRefs)
    ].filter(Boolean).map(normalizeSkillHubRef);
    if (!refs.length) {
      throw new Error("Skill package submissions require a manifest or payload reference.");
    }
    if (input.contentBase64 !== undefined || input.packageBundleBase64 !== undefined) {
      throw new Error("Skill package transport must be normalized before domain execution.");
    }
    const packageBundle = objectOrNull(input.packageBundle);
    const allowedBundleFields = new Set([
      "schemaVersion", "custodyRef", "contentDigest", "envelopeDigest", "byteCount"
    ]);
    if (!packageBundle || packageBundle.schemaVersion !== "v0.0.1:skill-hub:package-handle-1" ||
        Object.keys(packageBundle).some((field) => !allowedBundleFields.has(field)) ||
        !/^service-package:[a-f0-9]{64}$/u.test(String(packageBundle.custodyRef || "")) ||
        !/^[a-f0-9]{64}$/u.test(String(packageBundle.contentDigest || "")) ||
        !/^[a-f0-9]{64}$/u.test(String(packageBundle.envelopeDigest || ""))) {
      throw new Error("Skill package submissions require one valid service-custodied package bundle.");
    }
    const packageSize = Number(packageBundle.byteCount);
    if (input.skillManifest !== undefined || input.manifest !== undefined) {
      throw new Error("Skill package manifest content must be carried only inside the package bundle.");
    }
    const runtimeKind = String(input.runtimeKind || "").trim();
    const entryPoint = String(input.entryPoint || "").trim();
    if (runtimeKind && !new Set(["skill-runtime", "wasi-component", "oci-tool"]).has(runtimeKind)) {
      throw new Error("Skill package runtime kind is not supported.");
    }
    const normalizedEntryPoint = entryPoint ? normalizeSkillHubRef(entryPoint) : "";
    if (normalizedEntryPoint && !refs.includes(normalizedEntryPoint)) {
      throw new Error("Skill package entry point must identify declared package content.");
    }
    if (Boolean(runtimeKind) !== Boolean(normalizedEntryPoint)) {
      throw new Error("Skill package runtime kind and entry point must be declared together.");
    }
    if (!Number.isFinite(packageSize) || packageSize <= 0 || packageSize > SKILL_HUB_MAX_PACKAGE_BYTES) {
      throw new Error("Skill package size exceeds the governed Skill Hub limit.");
    }
    const autoRun = input.autoRun === true ||
      input.autorun === true ||
      Boolean(input.installCommand || input.postInstall || input.preInstall);
    if (autoRun) {
      throw new Error("Skill package auto-run behavior is not allowed.");
    }
    return {
      refs,
      declaredPermissions,
      license,
      packageSize,
      packageBundle,
      runtimeKind,
      entryPoint: normalizedEntryPoint
    };
  }

  async function readSkillHubAssetManifest(contribution = {}, context = {}) {
    const asset = objectOrNull(contribution.currentAssetRef) || {};
    const assetPath = normalizeSkillHubRef(asset.assetPath || "");
    const appendSkillHubAlert = (reasonCode, title, details = {}) => {
      try {
        context.securityAlertStore?.appendAlert?.({
          category: "skill-hub",
          severity: "critical",
          reasonCode,
          title,
          subjectRef: "skill-hub-contribution",
          resourceRef: "skill-hub.asset",
          details
        });
      } catch {
        // Alert persistence must not mask the primary package safety denial.
      }
    };
    if (!isSkillHubStorageRelativePath(assetPath)) {
      appendSkillHubAlert("skill_hub_asset_path_escape_denied", "Skill Hub asset path escape denied");
      throw new Error("Skill package asset path must stay inside the Skill Hub storage boundary.");
    }
    if (!context.serviceData || typeof context.serviceData.stat !== "function" || typeof context.serviceData.readFile !== "function") {
      throw new Error("Skill package integrity requires service data access.");
    }
    let assetStat;
    try {
      assetStat = await context.serviceData.stat(assetPath);
    } catch (error) {
      appendSkillHubAlert(
        error?.code === "SERVICE_DATA_BOUNDARY_REJECTED"
          ? "skill_hub_asset_symlink_denied"
          : "skill_hub_asset_access_denied",
        "Skill Hub asset access denied"
      );
      throw error;
    }
    if (assetStat.type !== "file") throw new Error("Stored asset must be a regular file.");
    if (assetStat.executable === true) {
      appendSkillHubAlert("skill_hub_executable_asset_denied", "Skill Hub executable asset denied");
      throw new Error("Stored asset file has executable permissions.");
    }
    const manifest = JSON.parse(await context.serviceData.readFile(assetPath, "utf8"));
    const { assetId, assetPath: storedAssetPath, manifestHash, fixedSkillHubAssetBuckets, ...hashableManifest } = manifest;
    if (storedAssetPath !== assetPath) {
      throw new Error("Skill package manifest path metadata mismatch.");
    }
    const expectedAssetBuckets = [SKILL_HUB_STORAGE_ROOT_DIR, SKILL_HUB_SKILL_STORAGE_DIR];
    if (
      !Array.isArray(fixedSkillHubAssetBuckets) ||
      fixedSkillHubAssetBuckets.length !== expectedAssetBuckets.length ||
      fixedSkillHubAssetBuckets.some((bucket, index) => bucket !== expectedAssetBuckets[index])
    ) {
      throw new Error("Skill package storage bucket metadata is missing or invalid.");
    }
    if (manifest.sandboxPolicy?.storageRoot !== SKILL_HUB_STORAGE_ROOT_DIR ||
        manifest.sandboxPolicy?.serverExecution !== "blocked" ||
        manifest.sandboxPolicy?.executableBitsAllowed !== false) {
      throw new Error("Skill package sandbox policy metadata is missing or invalid.");
    }
    const expectedHash = skillHubSha256(stableSkillHubJson(hashableManifest), 32);
    if (expectedHash !== asset.manifestHash || manifestHash !== asset.manifestHash) {
      throw new Error("Skill package manifest checksum verification failed.");
    }
    if (manifest.packageChecksum && contribution.packageChecksum && manifest.packageChecksum !== contribution.packageChecksum) {
      throw new Error("Skill package checksum metadata mismatch.");
    }
    return {
      manifest,
      expectedHash,
      integrityVerified: true
    };
  }

  function skillHubPackageReference(contribution = {}, integrity = {}) {
    const asset = objectOrNull(contribution.currentAssetRef) || {};
    return {
      skillId: String(contribution.contributionId || ""),
      title: String(contribution.title || ""),
      status: String(contribution.status || ""),
      contributionType: String(contribution.contributionType || ""),
      packageRef: {
        assetId: String(asset.assetId || ""),
        assetPath: String(asset.assetPath || ""),
        manifestHash: String(asset.manifestHash || ""),
        checksum: String(asset.manifestHash || ""),
        packageChecksum: String(contribution.packageChecksum || ""),
        packageSize: Number(contribution.packageSize || 0),
        declaredPermissions: Array.isArray(contribution.declaredPermissions) ? contribution.declaredPermissions : [],
        payloadRefs: Array.isArray(asset.payloadRefs) ? asset.payloadRefs : [],
        lifecycleState: String(asset.lifecycleState || ""),
        sandboxPolicy: objectOrNull(integrity.manifest?.sandboxPolicy),
        integrityVerified: integrity.integrityVerified === true
      },
      requestedActions: Array.isArray(contribution.requestedActions) ? contribution.requestedActions : [],
      requestedVisibility: String(contribution.requestedVisibility || ""),
      skillManifestRef: String(contribution.skillManifestRef || ""),
      skillPackageRef: String(contribution.skillPackageRef || ""),
      license: String(contribution.license || ""),
      runtimeKind: String(contribution.runtimeKind || ""),
      entryPoint: String(contribution.entryPoint || "")
    };
  }

  return async function executeSkillHubOperation({ operationId, input = {}, context = {} }) {
    if (!String(operationId || "").startsWith("skill_hub.")) {
      return null;
    }
    const registry = context.contributionRegistry || await contributionRegistryFor(input, context);
    const runtimeSubject = objectOrNull(context.subject) || {};
    const subject = {
      ...runtimeSubject,
      subjectId: runtimeSubject.subjectId || runtimeSubject.id || "",
      username: runtimeSubject.username || runtimeSubject.label || "",
      scopes: Array.isArray(runtimeSubject.scopes) ? runtimeSubject.scopes : []
    };
    const publicCallerIdClaim = (keys = undefined) => publicSkillHubActorId(
      subject,
      keys === undefined
        ? callerIdClaim(context, input, subject)
        : callerIdClaim(context, input, subject, keys)
    );
    const callerId = publicCallerIdClaim();
    const contributorId = publicCallerIdClaim(["contributorId", "contributor-id"]);
    const contributorKind = callerKindClaim(context, input, subject);
    const id = String(operationId || "");

    try {
      if (id === "skill_hub.search" || id === "skill_hub.list") {
        const internalItems = await skillHubItemsForInput(registry, input);
        const items = internalItems.map(projectPublicContribution);
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          items,
          count: items.length
        }));
      }

      if (id === "skill_hub.stats") {
        const items = await skillHubItemsForInput(registry, input, { visibleOnly: false });
        return result(200, protocolPayload({
          ...buildContributionStatsDashboard({
            items,
            auditEvents: typeof registry.listAuditEvents === "function" ? await registry.listAuditEvents() : [],
            protocolVersion: "v0.0.1:skill-hub:runtime-1",
            workspaceId: workspaceIdFrom(input),
            contributionType: "skill",
            assetRecordProjector
          }),
          dashboardSchemaVersion: "v0.0.1:skill-hub:contribution-dashboard-1",
          skillCount: items.length
        }));
      }

      if (id === "skill_hub.leaderboard") {
        const skillIds = new Set((await skillHubItemsForInput(registry, input)).map((item) => item.contributionId));
        const items = (await registry.getLeaderboard())
          .filter((item) => skillIds.has(item.contributionId))
          .map((item, index) => ({ ...item, rank: index + 1 }));
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          items,
          count: items.length
        }));
      }

      if (id === "skill_hub.submit") {
        const packagePolicy = assertSkillHubPackagePolicy(input);
        if (!context.packageCustody ||
            typeof context.packageCustody.delete !== "function") {
          throw new Error("Skill package submission requires service package custody.");
        }
        const workspaceId = workspaceIdFrom(input);
        const sealed = {
          handle: packagePolicy.packageBundle.custodyRef,
          contentDigest: packagePolicy.packageBundle.contentDigest,
          envelopeDigest: packagePolicy.packageBundle.envelopeDigest,
          byteCount: packagePolicy.packageBundle.byteCount
        };
        let committed = false;
        try {
          const packageChecksum = sealed.contentDigest;
          const resultPayload = await registry.submitContribution({
            ...input,
            workspaceId,
            contributorId,
            contributorKind,
            sourceAgentId: subject.type === "tool-grant"
              ? callerId
              : input.sourceAgentId || subject.subjectId || subject.username || contributorId,
            sourceAgentKind: input.sourceAgentKind || contributorKind,
            contributionType: "skill",
            title: input.title || input.name || "Skill Hub contribution",
            payloadRefs: packagePolicy.refs,
            skillManifestRef: packagePolicy.refs[0],
            packageSize: packagePolicy.packageSize,
            packageChecksum,
            packageBundle: {
              path: SKILL_HUB_PACKAGE_PATH,
              digest: packageChecksum,
              size: packagePolicy.packageSize,
              custodyRef: sealed.handle,
              envelopeDigest: sealed.envelopeDigest
            },
            packageCustodyRef: sealed.handle,
            packageContentDigest: sealed.contentDigest,
            packageEnvelopeDigest: sealed.envelopeDigest,
            custodyState: "blocked",
            executionState: "blocked",
            runtimeKind: packagePolicy.runtimeKind,
            entryPoint: packagePolicy.entryPoint,
            declaredPermissions: packagePolicy.declaredPermissions,
            license: packagePolicy.license,
            requestedVisibility: input.requestedVisibility || "public",
            requestedActions: input.requestedActions || input.actions || packagePolicy.declaredPermissions
          });
          committed = true;
          return result(201, protocolPayload({
            protocolVersion: "v0.0.1:skill-hub:runtime-1",
            skill: projectPublicContribution(resultPayload.contribution)
          }));
        } catch (error) {
          if (sealed.handle && !committed) {
            try {
              await context.packageCustody.delete({
                handle: sealed.handle,
                authorizationRef: `skill-hub-submission-rollback:${skillHubSha256(sealed.handle, 32)}`,
                ownerBinding: {
                  tenantRef: context.principal?.tenantRef || workspaceId,
                  workspaceRef: workspaceId
                }
              });
            } catch (rollbackError) {
              throw new AggregateError(
                [error, rollbackError],
                "Skill package submission failed and service custody rollback did not complete."
              );
            }
          }
          throw error;
        }
      }

      const targetSkillId = skillHubSkillId(input, context);
      if (!targetSkillId) {
        return result(400, errorPayload(new Error("Skill Hub operation requires skillId."), "Skill Hub operation failed."));
      }

      if (id === "skill_hub.get") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill" || !visibleContribution(skill)) {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          skill: projectPublicContribution(skill)
        }));
      }

      if (id === "skill_hub.download") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill") {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        if (skill.status === "revoked") {
          return result(410, errorPayload(new Error(`Skill has been revoked: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        if (!visibleContribution(skill)) {
          throw Object.assign(new Error("Skill download requires a published revision."), {
            code: "contribution_download_not_published"
          });
        }
        const integrity = await readSkillHubAssetManifest(skill, context);
        const downloadEvent = await registry.recordDownload(targetSkillId, {
          actorId: callerId,
          workspaceId: workspaceIdFrom(input)
        });
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          skill: projectPublicContribution(await registry.getContribution(targetSkillId)),
          download: skillHubPackageReference(await registry.getContribution(targetSkillId), integrity),
          downloadEvent
        }));
      }

      if (id === "skill_hub.review") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill") {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        await readSkillHubAssetManifest(skill, context);
        const currentInputDigest = sandboxDigest([{
          path: SKILL_HUB_PACKAGE_PATH,
          digest: skill.packageChecksum
        }]);
        const scanReceipt = [...(skill.executionReceipts || [])].reverse().find((receipt) =>
          receipt.workloadKind === "skill_scan" &&
          receipt.status === "succeeded" &&
          receipt.cleanupStatus === "destroyed" &&
          receipt.packageDigest === skill.packageChecksum &&
          receipt.inputDigest === currentInputDigest &&
          /^[a-f0-9]{64}$/u.test(String(receipt.workloadArtifactDigest || ""))
        );
        if (!scanReceipt) {
          throw new Error("Skill review requires a successful sandbox scan receipt for the current revision.");
        }
        const reviewed = await registry.reviewContribution(targetSkillId, {
          ...input,
          actorId: callerId,
          reviewerId: publicCallerIdClaim(["reviewerId", "reviewer-id"])
        });
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          scanReceipt,
          review: reviewed.review,
          lifecycleDecision: reviewed.lifecycleDecision,
          skill: projectPublicContribution(reviewed.contribution)
        }));
      }

      if (id === "skill_hub.publish") {
        const resultPayload = await registry.publishContribution(targetSkillId, {
          ...input,
          actorId: callerId
        });
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          lifecycleDecision: resultPayload.lifecycleDecision,
          skill: projectPublicContribution(resultPayload.contribution)
        }));
      }

      if (id === "skill_hub.install") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill") {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        if (skill.status === "revoked") {
          return result(410, errorPayload(new Error(`Skill has been revoked: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        if (!["published", "adopted"].includes(skill.status)) {
          throw Object.assign(new Error("Skill adoption requires a published revision."), {
            code: "contribution_adoption_not_published"
          });
        }
        await readSkillHubAssetManifest(skill, context);
        const resultPayload = await registry.adoptContribution(targetSkillId, {
          ...input,
          actorId: callerId,
          adopterId: publicCallerIdClaim(["adopterId", "adopter-id"]),
          targetWorkspaceId: input.targetWorkspaceId || input.workspaceId || workspaceIdFrom(input)
        });
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          adoption: resultPayload.adoption,
          lifecycleDecision: resultPayload.lifecycleDecision,
          skill: projectPublicContribution(resultPayload.contribution)
        }));
      }

      if (id === "skill_hub.usage.record") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill") {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        if (skill.status === "revoked") {
          return result(410, errorPayload(new Error(`Skill has been revoked: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        const resultPayload = await registry.recordUsage(targetSkillId, {
          ...input,
          actorId: callerId,
          action: input.action || "skill.used",
          workspaceId: workspaceIdFrom(input)
        });
        return result(201, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          ...resultPayload
        }));
      }

      if (id === "skill_hub.revoke") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill") {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        const resultPayload = await registry.revokeContribution(targetSkillId, {
          ...input,
          actorId: callerId,
          reason: input.reason || "skill_hub_revoke"
        });
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          lifecycleDecision: resultPayload.lifecycleDecision,
          skill: projectPublicContribution(resultPayload.contribution)
        }));
      }

      if (id === "skill_hub.rollback.record") {
        const skill = await registry.getContribution(targetSkillId);
        if (skill.contributionType !== "skill") {
          return result(404, errorPayload(new Error(`Skill not found: ${targetSkillId}`), "Skill Hub operation failed."));
        }
        const resultPayload = await registry.recordRollback(targetSkillId, {
          ...input,
          actorId: callerId,
          reason: input.reason || "skill_hub_rollback"
        });
        return result(201, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          ...resultPayload
        }));
      }

      if (id === "skill_hub.permission.request") {
        const skill = await registry.getContribution(targetSkillId);
        if (!["published", "adopted", "deprecated"].includes(skill.status)) {
          throw Object.assign(new Error("Permission requests require a published revision."), {
            code: "contribution_permission_not_published"
          });
        }
        const resultPayload = await registry.requestPermission(targetSkillId, {
          ...input,
          requesterId: publicCallerIdClaim(["requesterId", "requester-id"])
        });
        return result(201, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          ...resultPayload
        }));
      }

      if (id === "skill_hub.permission.grant") {
        const skill = await registry.getContribution(targetSkillId);
        if (!["published", "adopted", "deprecated"].includes(skill.status)) {
          throw Object.assign(new Error("Permission grants require a published revision."), {
            code: "contribution_permission_not_published"
          });
        }
        if (context.governance?.authorized !== true || context.governance?.current !== true) {
          throw Object.assign(new Error("Permission grant requires current Operation Permission authorization."), {
            code: "skill_hub_operation_permission_denied"
          });
        }
        if (typeof context.operationPermissionGrant?.recordPluginGrant !== "function") {
          throw Object.assign(new Error("Operation Permission grant recording is unavailable."), {
            code: "skill_hub_operation_permission_unavailable"
          });
        }
        const resultPayload = await registry.grantPermission(targetSkillId, {
          ...input,
          granteeId: publicCallerIdClaim(["granteeId", "grantee-id"]),
          recordPluginGrant: (request) => context.operationPermissionGrant.recordPluginGrant(request)
        });
        const { loanRecord: _privateLoanRecord, ...publicResult } = resultPayload;
        return result(200, protocolPayload({
          protocolVersion: "v0.0.1:skill-hub:runtime-1",
          ...publicResult
        }));
      }
    } catch (error) {
      return result(400, errorPayload(error, "Skill Hub operation failed."));
    }

    return null;
  };
}
