import { computed, onMounted, ref } from "vue";
import type { ComputedRef, Ref } from "vue";
import type { RouteLocationRaw } from "vue-router";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import { listApiKeys } from "../../../lib/api-key-distribution-client";
import {
  getOperationPermissionCatalog,
  getOperationPermissionGrants,
} from "../../../lib/operation-permission-client";
import type { ApiKeyRecord } from "../../../lib/api-key-distribution-client";
import type {
  OperationPermissionCatalog,
  OperationPermissionGrant,
} from "../../../lib/types/operation-permission";
import type {
  UpstreamGatewayAuditItem,
  UpstreamGatewayService,
} from "../../../lib/upstream-gateway-client";

export type ServiceReadinessStageId =
  | "published"
  | "inToolCatalog"
  | "grantExists"
  | "keyIssued"
  | "firstCallSeen";

export type ServiceReadinessStageState = "done" | "pending" | "unknown";

export type ServiceReadinessStage = {
  id: ServiceReadinessStageId;
  /** Flat dictionary key into the `readiness` group of the keyed dictionary (REQ-004). */
  label: string;
  state: ServiceReadinessStageState;
  link?: RouteLocationRaw;
};

export type ServiceReadinessData = {
  service: UpstreamGatewayService | null | undefined;
  services: UpstreamGatewayService[];
  audit: UpstreamGatewayAuditItem[];
  catalog: OperationPermissionCatalog | null;
  grants: OperationPermissionGrant[] | null;
  apiKeys: ApiKeyRecord[] | null;
};

/** Flat dictionary keys into the `readiness` group (REQ-004), both locales. */
export const SERVICE_READINESS_LABEL_KEYS: Record<ServiceReadinessStageId, string> = {
  published: "stagePublished",
  inToolCatalog: "stageInToolCatalog",
  grantExists: "stageGrantExists",
  keyIssued: "stageKeyIssued",
  firstCallSeen: "stageFirstCallSeen",
};

/** Flat dictionary keys into the `readiness` group (REQ-004), both locales. */
export const SERVICE_READINESS_STATE_LABEL_KEYS: Record<ServiceReadinessStageState, string> = {
  done: "stateDone",
  pending: "statePending",
  unknown: "stateUnknown",
};

/** Dictionary key for a stage state label; consumers resolve it in the view. */
export function readinessStateLabelKey(state: ServiceReadinessStageState): string {
  return SERVICE_READINESS_STATE_LABEL_KEYS[state];
}

const PUBLISH_PATH = "/admin/publish-upstream-service";
const TOOL_CATALOG_PATH = "/admin/tool-list";
const OPERATION_PERMISSION_PATH = "/admin/operation-permission";
const API_KEY_DISTRIBUTION_PATH = "/admin/api-key-distribution";

// The gateway audit endpoint records forward events (eventType
// "upstream.forward.completed" per verify-upstream-gateway-e2e.ts).
function isForwardEvent(item: UpstreamGatewayAuditItem): boolean {
  return /^upstream\.forward\./u.test(String(item.eventType || ""));
}

/**
 * Derived, read-only five-stage readiness projection for one upstream
 * service. Each stage is computed from existing endpoint data only; a stage
 * whose data source has not loaded renders "unknown" — never fabricated as
 * done. Non-done stages carry a link to their owning surface; done stages
 * render without links.
 */
export function buildServiceReadinessStages(data: ServiceReadinessData): ServiceReadinessStage[] {
  const { service, services, audit, catalog, grants, apiKeys } = data;
  if (!service) {
    return [];
  }

  const stage = (
    id: ServiceReadinessStageId,
    state: ServiceReadinessStageState,
    link?: RouteLocationRaw,
  ): ServiceReadinessStage => ({ id, label: SERVICE_READINESS_LABEL_KEYS[id], state, link });

  const published = services.some((entry: any) => entry.serviceId === service.serviceId);

  const catalogTools = (catalog?.tools || []).filter(
    (tool: any) => tool.serviceId === service.serviceId,
  );
  const catalogToolIds = new Set(catalogTools.map((tool: any) => tool.id));
  const catalogToolsetIds = new Set(catalogTools.flatMap((tool: any) => tool.toolsets || []));
  const coveringGrant = (grants || []).some((grant: any) =>
    grant.enabled !== false &&
    ((grant.toolsets || []).some((toolsetId: any) => catalogToolsetIds.has(toolsetId)) ||
      (grant.toolAllow || []).some((toolId: any) => catalogToolIds.has(toolId))),
  );
  const issuedKey = (apiKeys || []).some((record: any) =>
    (record.policy?.serviceIds || []).includes(service.serviceId),
  );
  const callSeen = audit.some(
    (item: any) => item.serviceId === service.serviceId && isForwardEvent(item),
  );

  return [
    stage(
      "published",
      published ? "done" : "pending",
      published ? undefined : { path: PUBLISH_PATH, query: { serviceId: service.serviceId } },
    ),
    stage(
      "inToolCatalog",
      catalog === null ? "unknown" : catalogTools.length > 0 ? "done" : "pending",
      catalog !== null && catalogTools.length > 0 ? undefined : { path: TOOL_CATALOG_PATH },
    ),
    stage(
      "grantExists",
      catalog === null || grants === null ? "unknown" : coveringGrant ? "done" : "pending",
      coveringGrant ? undefined : { path: OPERATION_PERMISSION_PATH },
    ),
    stage(
      "keyIssued",
      apiKeys === null ? "unknown" : issuedKey ? "done" : "pending",
      issuedKey ? undefined : { path: API_KEY_DISTRIBUTION_PATH },
    ),
    // First call seen is observed on this view's own audit panel — no off-view link.
    stage("firstCallSeen", callSeen ? "done" : "pending"),
  ];
}

export function useServiceReadiness(options: {
  services: Ref<UpstreamGatewayService[]>;
  audit: Ref<UpstreamGatewayAuditItem[]>;
  selectedService: ComputedRef<UpstreamGatewayService | null>;
}): any {
  const catalog: any = ref<OperationPermissionCatalog | null>(null);
  const grants: any = ref<OperationPermissionGrant[] | null>(null);
  const apiKeys: any = ref<ApiKeyRecord[] | null>(null);
  const loading: any = ref(false);
  const error: any = ref("");

  async function refreshReadiness(): Promise<any> {
    loading.value = true;
    error.value = "";
    try {
      const [catalogPayload, grantsPayload, apiKeysPayload] = await Promise.all([
        getOperationPermissionCatalog(),
        getOperationPermissionGrants(),
        listApiKeys(),
      ]);
      catalog.value = catalogPayload || null;
      grants.value = Array.isArray(grantsPayload?.grants) ? grantsPayload.grants : [];
      apiKeys.value = Array.isArray(apiKeysPayload?.records) ? apiKeysPayload.records : [];
    } catch (err: any) {
      error.value = err instanceof Error ? err.message : String(err || "");
      catalog.value = null;
      grants.value = null;
      apiKeys.value = null;
    } finally {
      loading.value = false;
    }
  }

  onMounted(() : any => {
    void refreshReadiness();
  });

  usePageRefreshHandler(
    (detail?: any) : any => detail.viewId === "admin" && detail.adminView === "upstreamServices",
    refreshReadiness,
  );

  const readinessStages = computed<ServiceReadinessStage[]>(() =>
    buildServiceReadinessStages({
      service: options.selectedService.value,
      services: options.services.value,
      audit: options.audit.value,
      catalog: catalog.value,
      grants: grants.value,
      apiKeys: apiKeys.value,
    }),
  );

  return {
    apiKeys,
    catalog,
    error,
    grants,
    loading,
    readinessStages,
    refreshReadiness,
  };
}
