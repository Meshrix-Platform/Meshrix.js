import { createHash } from "node:crypto";
import { compileUpstreamOperationProjection } from "./operation-projection.mjs";
import {
  AUDIENCE_PUBLICATION_TOPIC,
  compileAudienceProjection,
  createAudiencePublicationEvent
} from "./audience-projection.mjs";

const PUBLICATION_EVENT_SCHEMA_VERSION = "v0.0.1:upstream-gateway:catalog-publication-1";
const PUBLICATION_EVENT_TOPIC = "upstream.catalog_published";

function digest(value) {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function publicationKey(snapshot = {}) {
  return `${snapshot.setRevision}:${snapshot.setDigest}`;
}

function mergeBaseAndProjectedOperations(baseOperations = [], projectedOperations = []) {
  const staticOperations = (Array.isArray(baseOperations) ? baseOperations : [])
    .filter((operation) => operation?._meta?.upstreamProjectedOperation !== true);
  return Object.freeze([...staticOperations, ...projectedOperations]);
}

function affectedServiceOperations(projection = {}) {
  return Object.freeze((projection.operations || []).map((operation) => Object.freeze({
    operationId: operation.id,
    toolId: operation.toolId,
    serviceId: operation._meta?.serviceId || "",
    operationKey: operation._meta?.operationKey || ""
  })));
}

export function createUpstreamManifestSnapshotCommitter({
  registry,
  getBaseOperations = () => [],
  getOperationPermissionPlatform = () => null,
  getGrants = null,
  getTagStore = () => null,
  getPolicyRevision = () => 0,
  getTagRevision = () => 0,
  protocolEventBus = null,
  onAudiencePublished = null,
  now = () => new Date().toISOString()
} = {}) {
  if (!registry || typeof registry.replaceFromManifestSnapshot !== "function") {
    throw new TypeError("Upstream manifest snapshot committer requires a gateway registry.");
  }
  let lastCommittedKey = "";
  let lastPublishedEventDigest = "";
  let lastAudienceEventDigest = "";
  let lastAudienceAdmissionDigest = "";
  let lastMergedOperations = mergeBaseAndProjectedOperations(getBaseOperations(), []);
  let lastAudienceProjection = null;
  let lastCatalogFingerprint = "";
  let lastSnapshot = null;
  let lastOperationProjection = null;
  let mutationLane = Promise.resolve();
  let pendingPublication = null;

  function serializeMutation(task) {
    const result = mutationLane.catch(() => {}).then(task);
    mutationLane = result.catch(() => {});
    return result;
  }

  async function finishPendingPublication() {
    if (!pendingPublication) return null;
    const pending = pendingPublication;
    const catalogPublication = await emitCatalogPublicationEvent({
      snapshot: pending.snapshot,
      projection: pending.projection,
      catalogResult: pending.catalogResult,
      gatewayDiff: pending.gatewayDiff
    });
    const audiencePublication = await emitAudiencePublicationEvent(
      pending.audienceProjection,
      pending.priorAudienceProjection
    );
    lastCommittedKey = pending.key;
    lastMergedOperations = pending.nextMergedOperations;
    lastAudienceProjection = pending.audienceProjection;
    lastCatalogFingerprint = pending.catalogFingerprint;
    lastSnapshot = pending.snapshot;
    lastOperationProjection = pending.projection;
    pendingPublication = null;
    return Object.freeze({
      key: pending.key,
      result: Object.freeze({
        outcome: "committed",
        replayed: false,
        sourceRevision: pending.snapshot.setRevision,
        sourceDigest: pending.snapshot.setDigest,
        catalogFingerprint: pending.catalogFingerprint,
        operationCount: pending.projection.operations.length,
        gatewayDiff: Object.freeze({
          added: Object.freeze([...(pending.gatewayDiff.added || [])]),
          updated: Object.freeze([...(pending.gatewayDiff.updated || [])]),
          removed: Object.freeze([...(pending.gatewayDiff.removed || [])])
        }),
        catalogPublication,
        audiencePublication,
        audienceReady: true,
        audienceRevision: pending.audienceProjection.audienceRevision,
        affectedPartitions: pending.audienceProjection.affectedPartitions
      })
    });
  }

  function resolveGrants(platform) {
    if (typeof getGrants === "function") {
      return getGrants() || [];
    }
    if (typeof platform?.store?.listGrants === "function") {
      return platform.store.listGrants({ includeRevoked: false }) || [];
    }
    return [];
  }

  async function emitCatalogPublicationEvent({
    snapshot,
    projection,
    catalogResult,
    gatewayDiff
  } = {}) {
    const affectedOperations = affectedServiceOperations(projection);
    const eventDigest = digest(JSON.stringify({
      sourceRevision: snapshot.setRevision,
      sourceDigest: snapshot.setDigest,
      catalogFingerprint: catalogResult?.catalogFingerprint || "",
      affectedOperationIds: affectedOperations.map((item) => item.operationId)
    }));
    if (eventDigest === lastPublishedEventDigest) {
      return Object.freeze({
        emitted: false,
        replayed: true,
        reasonCode: "catalog_publication_replayed"
      });
    }
    const event = Object.freeze({
      schemaVersion: PUBLICATION_EVENT_SCHEMA_VERSION,
      source: "upstream-gateway",
      type: PUBLICATION_EVENT_TOPIC,
      reasonCode: "upstream_catalog_published",
      sourceRevision: snapshot.setRevision,
      sourceDigest: snapshot.setDigest,
      catalogRevision: catalogResult?.catalogFingerprint || "",
      catalogFingerprint: catalogResult?.catalogFingerprint || "",
      affectedOperations,
      invalidation: Object.freeze({
        added: Object.freeze([...(gatewayDiff?.added || [])]),
        updated: Object.freeze([...(gatewayDiff?.updated || [])]),
        removed: Object.freeze([...(gatewayDiff?.removed || [])])
      }),
      at: now()
    });
    if (typeof protocolEventBus?.publish === "function") {
      await protocolEventBus.publish(PUBLICATION_EVENT_TOPIC, event, { delivery: "best-effort" });
    }
    lastPublishedEventDigest = eventDigest;
    return Object.freeze({
      emitted: true,
      replayed: false,
      reasonCode: "catalog_publication_emitted",
      event
    });
  }

  async function emitAudiencePublicationEvent(audienceProjection, previousProjection = null) {
    if (audienceProjection.replayed === true) {
      return Object.freeze({
        emitted: false,
        replayed: true,
        reasonCode: "audience_publication_replayed",
        audienceRevision: audienceProjection.audienceRevision
      });
    }
    const event = createAudiencePublicationEvent(audienceProjection, { now });
    const eventDigest = digest(JSON.stringify({
      audienceRevision: event.audienceRevision,
      projectionDigest: event.projectionDigest,
      affectedPartitions: event.affectedPartitions
    }));
    const eventReplayed = eventDigest === lastAudienceEventDigest;
    if (!eventReplayed && typeof protocolEventBus?.publish === "function") {
      await protocolEventBus.publish(AUDIENCE_PUBLICATION_TOPIC, event, { delivery: "best-effort" });
    }
    const publication = Object.freeze({
      emitted: !eventReplayed,
      replayed: eventReplayed,
      reasonCode: eventReplayed ? "audience_publication_replayed" : "audience_publication_emitted",
      audienceRevision: audienceProjection.audienceRevision,
      event
    });
    if (!eventReplayed) {
      lastAudienceEventDigest = eventDigest;
    }
    if (eventDigest !== lastAudienceAdmissionDigest && typeof onAudiencePublished === "function") {
      await onAudiencePublished({
        projection: audienceProjection,
        previousProjection,
        publication
      });
    }
    lastAudienceAdmissionDigest = eventDigest;
    return publication;
  }

  function rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection) {
    if (priorRegistryState && typeof registry.restoreManifestSnapshotState === "function") {
      registry.restoreManifestSnapshotState(priorRegistryState);
    }
    const platform = getOperationPermissionPlatform?.();
    if (priorPlatformState && typeof platform?.restoreOperationLayersState === "function") {
      platform.restoreOperationLayersState(priorPlatformState);
    } else if (typeof platform?.refreshOperations === "function") {
      platform.refreshOperations(priorMergedOperations);
    }
    lastAudienceProjection = priorAudienceProjection;
  }

  function compileCurrentAudience({ snapshot, projection, platform, previousProjection }) {
    const catalogFingerprint = String(platform?.catalog?.()?.fingerprint || "");
    const operationLayers = platform?.captureOperationLayersState?.() || {};
    const effectiveOperations = [
      ...(operationLayers.baseOperations || []),
      ...(operationLayers.upstreamOperations || projection.operations || [])
    ];
    return compileAudienceProjection({
      sourceRevision: snapshot.setRevision,
      sourceDigest: snapshot.setDigest,
      catalogFingerprint,
      catalogRevision: catalogFingerprint,
      snapshot,
      projectedOperations: effectiveOperations,
      grants: resolveGrants(platform),
      tagStore: getTagStore?.() || null,
      previousProjection,
      policyRevision: Number(getPolicyRevision?.() || 0) || 0,
      tagRevision: Number(getTagRevision?.() || 0) || 0
    });
  }

  async function refreshAudienceProjectionNow() {
    await finishPendingPublication();
    const platform = getOperationPermissionPlatform?.();
    if (!lastSnapshot || !lastOperationProjection || !platform) {
      return Object.freeze({ outcome: "unavailable", emitted: false });
    }
    const previousProjection = lastAudienceProjection;
    const audienceProjection = compileCurrentAudience({
      snapshot: lastSnapshot,
      projection: lastOperationProjection,
      platform,
      previousProjection
    });
    if (audienceProjection.ready !== true) {
      throw new Error("Audience projection is not ready after policy refresh.");
    }
    const audiencePublication = await emitAudiencePublicationEvent(
      audienceProjection,
      previousProjection
    );
    lastAudienceProjection = audienceProjection;
    return Object.freeze({
      outcome: audienceProjection.replayed === true ? "unchanged" : "refreshed",
      emitted: audiencePublication.emitted === true,
      audienceRevision: audienceProjection.audienceRevision,
      affectedPartitions: audienceProjection.affectedPartitions
    });
  }

  async function commitManifestSnapshotNow(snapshot) {
    const projection = compileUpstreamOperationProjection(snapshot);
    if (projection.sourceRevision !== snapshot.setRevision) {
      throw new Error("Upstream manifest snapshot and operation projection revisions disagree.");
    }
    if (projection.sourceDigest !== snapshot.setDigest) {
      throw new Error("Upstream manifest snapshot and operation projection digests disagree.");
    }
    const nextKey = publicationKey(snapshot);
    const completedPending = await finishPendingPublication();
    if (completedPending?.key === nextKey) return completedPending.result;
    if (nextKey === lastCommittedKey) {
      return Object.freeze({
        outcome: "unchanged",
        replayed: true,
        sourceRevision: snapshot.setRevision,
        sourceDigest: snapshot.setDigest,
        operationCount: projection.operations.length,
        catalogPublication: Object.freeze({
          emitted: false,
          replayed: true,
          reasonCode: "identical_snapshot_replayed"
        }),
        audiencePublication: Object.freeze({
          emitted: false,
          replayed: true,
          reasonCode: "identical_snapshot_replayed",
          audienceRevision: lastAudienceProjection?.audienceRevision || 0
        }),
        audienceReady: lastAudienceProjection?.ready === true
      });
    }
    const currentRevision = typeof registry.getManifestSnapshotRevision === "function"
      ? registry.getManifestSnapshotRevision()
      : null;
    if (currentRevision && currentRevision.sourceRevision === snapshot.setRevision &&
        currentRevision.sourceDigest && currentRevision.sourceDigest !== snapshot.setDigest) {
      throw new Error("Upstream manifest snapshot revision conflicts with its accepted digest.");
    }
    if (currentRevision && Number.isSafeInteger(currentRevision.sourceRevision) &&
        snapshot.setRevision < currentRevision.sourceRevision) {
      return Object.freeze({
        outcome: "stale",
        replayed: true,
        sourceRevision: snapshot.setRevision,
        sourceDigest: snapshot.setDigest,
        authoritativeRevision: currentRevision.sourceRevision,
        catalogPublication: Object.freeze({
          emitted: false,
          replayed: true,
          reasonCode: "stale_snapshot_ignored"
        }),
        audiencePublication: Object.freeze({
          emitted: false,
          replayed: true,
          reasonCode: "stale_snapshot_ignored",
          audienceRevision: lastAudienceProjection?.audienceRevision || 0
        }),
        audienceReady: lastAudienceProjection?.ready === true
      });
    }

    const priorRegistryState = typeof registry.captureManifestSnapshotState === "function"
      ? registry.captureManifestSnapshotState()
      : null;
    const priorMergedOperations = lastMergedOperations;
    const priorAudienceProjection = lastAudienceProjection;
    const nextMergedOperations = mergeBaseAndProjectedOperations(getBaseOperations(), projection.operations);
    const platform = getOperationPermissionPlatform?.();
    const priorPlatformState = typeof platform?.captureOperationLayersState === "function"
      ? platform.captureOperationLayersState()
      : null;

    let gatewayDiff;
    try {
      gatewayDiff = registry.replaceFromManifestSnapshot(snapshot, { deferSideEffects: true });
    } catch (error) {
      throw error;
    }
    if (gatewayDiff.setRevision !== projection.sourceRevision || gatewayDiff.setDigest !== projection.sourceDigest) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw new Error("Gateway snapshot revision did not agree with compiled projection.");
    }

    if (!platform || (typeof platform.replaceUpstreamOperations !== "function" && typeof platform.refreshOperations !== "function")) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw new Error("Operation Permission platform is unavailable for upstream catalog commit.");
    }

    let catalogResult;
    try {
      catalogResult = typeof platform.replaceUpstreamOperations === "function"
        ? platform.replaceUpstreamOperations({
            sourceRevision: snapshot.setRevision,
            sourceDigest: snapshot.setDigest,
            operations: projection.operations,
            notify: false
          })
        : platform.refreshOperations([...nextMergedOperations]);
    } catch (error) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw error;
    }

    const catalogFingerprint = String(catalogResult?.catalogFingerprint || "");
    const projectedOperationIds = new Set(projection.operations.map((operation) => operation.id));
    const catalogOperationIds = new Set(
      (platform.catalog?.().tools || [])
        .map((tool) => tool.operationId)
        .filter((operationId) => projectedOperationIds.has(operationId))
    );
    if (catalogOperationIds.size !== projectedOperationIds.size ||
        [...projectedOperationIds].some((operationId) => !catalogOperationIds.has(operationId))) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw new Error("Operation Permission catalog did not publish every projected upstream operation.");
    }

    let audienceProjection;
    try {
      audienceProjection = compileCurrentAudience({
        snapshot,
        projection,
        platform,
        previousProjection: lastAudienceProjection
      });
      if (audienceProjection.ready !== true) {
        throw new Error("Audience projection is not ready after catalog commit.");
      }
    } catch (error) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw error;
    }

    try {
      await registry.finalizeManifestSnapshot?.(gatewayDiff);
    } catch (error) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw error;
    }
    pendingPublication = Object.freeze({
      key: nextKey,
      snapshot,
      projection,
      catalogResult,
      gatewayDiff,
      audienceProjection,
      priorAudienceProjection,
      nextMergedOperations,
      catalogFingerprint
    });
    return (await finishPendingPublication()).result;
  }

  return Object.freeze({
    commitManifestSnapshot: (snapshot) => serializeMutation(
      () => commitManifestSnapshotNow(snapshot)
    ),
    refreshAudienceProjection: () => serializeMutation(refreshAudienceProjectionNow),
    getLastCommittedKey: () => lastCommittedKey,
    getLastMergedOperations: () => lastMergedOperations,
    getAudienceProjection: () => lastAudienceProjection,
    getPublicationFacts() {
      if (!lastSnapshot || !lastAudienceProjection?.ready || !lastCatalogFingerprint) return null;
      return Object.freeze({
        ready: true,
        sourceRevision: lastSnapshot.setRevision,
        sourceDigest: lastSnapshot.setDigest,
        catalogRevision: lastCatalogFingerprint,
        audienceRevision: lastAudienceProjection.audienceRevision,
        protocolRevision: lastAudienceProjection.audienceRevision
      });
    },
    getAudiencePartitionKeysForGrant(grantId = "") {
      const grantIdDigest = digest(String(grantId || "").trim());
      if (!grantId || !lastAudienceProjection?.partitions) return Object.freeze([]);
      return Object.freeze(
        [...lastAudienceProjection.partitions.entries()]
          .filter(([, partition]) => partition.grantIdDigest === grantIdDigest)
          .map(([partitionKey]) => partitionKey)
          .sort()
      );
    },
    getAudienceCatalogFactsForGrant(grantId = "") {
      const partitionKeys = this.getAudiencePartitionKeysForGrant(grantId);
      const projection = lastAudienceProjection;
      if (!projection?.ready || partitionKeys.length === 0) return null;
      return Object.freeze({
        sourceRevision: projection.sourceRevision,
        catalogRevision: projection.catalogRevision || projection.catalogFingerprint || "",
        audienceRevision: projection.audienceRevision,
        partitionKeys
      });
    },
    isAudienceReady: () => lastAudienceProjection?.ready === true
  });
}
