import { createHash } from "node:crypto";
import { compileUpstreamOperationProjection } from "./operation-projection.ts";
import {
  AUDIENCE_PUBLICATION_TOPIC,
  compileAudienceProjection,
  createAudiencePublicationEvent
} from "./audience-projection.ts";

const PUBLICATION_EVENT_SCHEMA_VERSION: any = "v0.0.1:upstream-gateway:catalog-publication-1";
const PUBLICATION_EVENT_TOPIC: any = "upstream.catalog_published";

function digest(value?: any) : any {
  return createHash("sha256").update(String(value)).digest("base64url");
}

function publicationKey(snapshot: Record<string, any> = {}) : any {
  return `${snapshot.setRevision}:${snapshot.setDigest}`;
}

function mergeBaseAndProjectedOperations(baseOperations: any = [], projectedOperations: any = []) : any {
  const staticOperations: any = (Array.isArray(baseOperations) ? baseOperations : [])
    .filter((operation?: any) : any => operation?._meta?.upstreamProjectedOperation !== true);
  return Object.freeze([...staticOperations, ...projectedOperations]);
}

function affectedServiceOperations(projection: Record<string, any> = {}) : any {
  return Object.freeze((projection.operations || []).map((operation?: any) : any => Object.freeze({
    operationId: operation.id,
    toolId: operation.toolId,
    serviceId: operation._meta?.serviceId || "",
    operationKey: operation._meta?.operationKey || ""
  })));
}

export function createUpstreamManifestSnapshotCommitter({
  registry,
  getBaseOperations = () : any => [],
  getOperationPermissionPlatform = () : any => null,
  getGrants = null,
  getTagStore = () : any => null,
  getPolicyRevision = () : any => 0,
  getTagRevision = () : any => 0,
  protocolEventBus = null,
  onAudiencePublished = null,
  now = () : any => new Date().toISOString()
}: Record<string, any> = {}) : any {
  if (!registry || typeof registry.replaceFromManifestSnapshot !== "function") {
    throw new TypeError("Upstream manifest snapshot committer requires a gateway registry.");
  }
  let lastCommittedKey: any = "";
  let lastPublishedEventDigest: any = "";
  let lastAudienceEventDigest: any = "";
  let lastAudienceAdmissionDigest: any = "";
  let lastMergedOperations: any = mergeBaseAndProjectedOperations(getBaseOperations(), []);
  let lastAudienceProjection: any = null;
  let lastCatalogFingerprint: any = "";
  let lastSnapshot: any = null;
  let lastOperationProjection: any = null;
  let mutationLane: any = Promise.resolve();
  let pendingPublication: any = null;

  function serializeMutation(task?: any) : any {
    const result: any = mutationLane.catch(() : any => {}).then(task);
    mutationLane = result.catch(() : any => {});
    return result;
  }

  async function finishPendingPublication() : Promise<any> {
    if (!pendingPublication) return null;
    const pending: any = pendingPublication;
    const catalogPublication: any = await emitCatalogPublicationEvent({
      snapshot: pending.snapshot,
      projection: pending.projection,
      catalogResult: pending.catalogResult,
      gatewayDiff: pending.gatewayDiff
    });
    const audiencePublication: any = await emitAudiencePublicationEvent(
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

  function resolveGrants(platform?: any) : any {
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
  }: Record<string, any> = {}) : Promise<any> {
    const affectedOperations: any = affectedServiceOperations(projection);
    const eventDigest: any = digest(JSON.stringify({
      sourceRevision: snapshot.setRevision,
      sourceDigest: snapshot.setDigest,
      catalogFingerprint: catalogResult?.catalogFingerprint || "",
      affectedOperationIds: affectedOperations.map((item?: any) : any => item.operationId)
    }));
    if (eventDigest === lastPublishedEventDigest) {
      return Object.freeze({
        emitted: false,
        replayed: true,
        reasonCode: "catalog_publication_replayed"
      });
    }
    const event: Readonly<Record<string, any>> = Object.freeze({
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

  async function emitAudiencePublicationEvent(audienceProjection?: any, previousProjection: any = null) : Promise<any> {
    if (audienceProjection.replayed === true) {
      return Object.freeze({
        emitted: false,
        replayed: true,
        reasonCode: "audience_publication_replayed",
        audienceRevision: audienceProjection.audienceRevision
      });
    }
    const event: any = createAudiencePublicationEvent(audienceProjection, { now });
    const eventDigest: any = digest(JSON.stringify({
      audienceRevision: event.audienceRevision,
      projectionDigest: event.projectionDigest,
      affectedPartitions: event.affectedPartitions
    }));
    const eventReplayed: any = eventDigest === lastAudienceEventDigest;
    if (!eventReplayed && typeof protocolEventBus?.publish === "function") {
      await protocolEventBus.publish(AUDIENCE_PUBLICATION_TOPIC, event, { delivery: "best-effort" });
    }
    const publication: Readonly<Record<string, any>> = Object.freeze({
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

  function rollbackPair(priorRegistryState?: any, priorPlatformState?: any, priorMergedOperations?: any, priorAudienceProjection?: any) : any {
    if (priorRegistryState && typeof registry.restoreManifestSnapshotState === "function") {
      registry.restoreManifestSnapshotState(priorRegistryState);
    }
    const platform: any = getOperationPermissionPlatform?.();
    if (priorPlatformState && typeof platform?.restoreOperationLayersState === "function") {
      platform.restoreOperationLayersState(priorPlatformState);
    } else if (typeof platform?.refreshOperations === "function") {
      platform.refreshOperations(priorMergedOperations);
    }
    lastAudienceProjection = priorAudienceProjection;
  }

  function compileCurrentAudience({ snapshot, projection, platform, previousProjection }: Record<string, any>) : any {
    const catalogFingerprint: any = String(platform?.catalog?.()?.fingerprint || "");
    const operationLayers: any = platform?.captureOperationLayersState?.() || {};
    const effectiveOperations: any[] = [
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

  async function refreshAudienceProjectionNow() : Promise<any> {
    await finishPendingPublication();
    const platform: any = getOperationPermissionPlatform?.();
    if (!lastSnapshot || !lastOperationProjection || !platform) {
      return Object.freeze({ outcome: "unavailable", emitted: false });
    }
    const previousProjection: any = lastAudienceProjection;
    const audienceProjection: any = compileCurrentAudience({
      snapshot: lastSnapshot,
      projection: lastOperationProjection,
      platform,
      previousProjection
    });
    if (audienceProjection.ready !== true) {
      throw new Error("Audience projection is not ready after policy refresh.");
    }
    const audiencePublication: any = await emitAudiencePublicationEvent(
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

  async function commitManifestSnapshotNow(snapshot?: any) : Promise<any> {
    const projection: any = compileUpstreamOperationProjection(snapshot);
    if (projection.sourceRevision !== snapshot.setRevision) {
      throw new Error("Upstream manifest snapshot and operation projection revisions disagree.");
    }
    if (projection.sourceDigest !== snapshot.setDigest) {
      throw new Error("Upstream manifest snapshot and operation projection digests disagree.");
    }
    const nextKey: any = publicationKey(snapshot);
    const completedPending: any = await finishPendingPublication();
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
    const currentRevision: any = typeof registry.getManifestSnapshotRevision === "function"
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

    const priorRegistryState: any = typeof registry.captureManifestSnapshotState === "function"
      ? registry.captureManifestSnapshotState()
      : null;
    const priorMergedOperations: any = lastMergedOperations;
    const priorAudienceProjection: any = lastAudienceProjection;
    const nextMergedOperations: any = mergeBaseAndProjectedOperations(getBaseOperations(), projection.operations);
    const platform: any = getOperationPermissionPlatform?.();
    const priorPlatformState: any = typeof platform?.captureOperationLayersState === "function"
      ? platform.captureOperationLayersState()
      : null;

    let gatewayDiff: any;
    try {
      gatewayDiff = registry.replaceFromManifestSnapshot(snapshot, { deferSideEffects: true });
    } catch (error: any) {
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

    let catalogResult: any;
    try {
      catalogResult = typeof platform.replaceUpstreamOperations === "function"
        ? platform.replaceUpstreamOperations({
            sourceRevision: snapshot.setRevision,
            sourceDigest: snapshot.setDigest,
            operations: projection.operations,
            notify: false
          })
        : platform.refreshOperations([...nextMergedOperations]);
    } catch (error: any) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw error;
    }

    const catalogFingerprint: any = String(catalogResult?.catalogFingerprint || "");
    const projectedOperationIds: any = new Set<any>(projection.operations.map((operation?: any) : any => operation.id));
    const catalogOperationIds: any = new Set<any>(
      (platform.catalog?.().tools || [])
        .map((tool?: any) : any => tool.operationId)
        .filter((operationId?: any) : any => projectedOperationIds.has(operationId))
    );
    if (catalogOperationIds.size !== projectedOperationIds.size ||
        [...projectedOperationIds].some((operationId?: any) : any => !catalogOperationIds.has(operationId))) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw new Error("Operation Permission catalog did not publish every projected upstream operation.");
    }

    let audienceProjection: any;
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
    } catch (error: any) {
      rollbackPair(priorRegistryState, priorPlatformState, priorMergedOperations, priorAudienceProjection);
      throw error;
    }

    try {
      await registry.finalizeManifestSnapshot?.(gatewayDiff);
    } catch (error: any) {
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
    commitManifestSnapshot: (snapshot?: any) : any => serializeMutation(
      () : any => commitManifestSnapshotNow(snapshot)
    ),
    refreshAudienceProjection: () : any => serializeMutation(refreshAudienceProjectionNow),
    getLastCommittedKey: () : any => lastCommittedKey,
    getLastMergedOperations: () : any => lastMergedOperations,
    getAudienceProjection: () : any => lastAudienceProjection,
    getPublicationFacts() : any {
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
    getAudiencePartitionKeysForGrant(grantId: any = "") : any {
      const grantIdDigest: any = digest(String(grantId || "").trim());
      if (!grantId || !lastAudienceProjection?.partitions) return Object.freeze([]);
      return Object.freeze(
        [...lastAudienceProjection.partitions.entries()]
          .filter(([, partition]: any[]) : any => partition.grantIdDigest === grantIdDigest)
          .map(([partitionKey]: any[]) : any => partitionKey)
          .sort()
      );
    },
    getAudienceCatalogFactsForGrant(grantId: any = "") : any {
      const partitionKeys: any = this.getAudiencePartitionKeysForGrant(grantId);
      const projection: any = lastAudienceProjection;
      if (!projection?.ready || partitionKeys.length === 0) return null;
      return Object.freeze({
        sourceRevision: projection.sourceRevision,
        catalogRevision: projection.catalogRevision || projection.catalogFingerprint || "",
        audienceRevision: projection.audienceRevision,
        partitionKeys
      });
    },
    isAudienceReady: () : any => lastAudienceProjection?.ready === true
  });
}
