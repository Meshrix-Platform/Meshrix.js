import { computed, onMounted, ref } from "vue";
import { usePageRefreshHandler } from "@meshrix/ui-console/page-refresh";
import { useConsoleUrlState } from "../../../composables/use-console-url-state";
import {
  getUpstreamGatewayMetrics,
  listUpstreamGatewayAudit,
  listUpstreamGatewayServices,
  type UpstreamGatewayAuditItem,
  type UpstreamGatewayMetrics,
  type UpstreamGatewayService,
} from "../../../lib/upstream-gateway-client";

export function useUpstreamGatewayView() : any {
  const loading: any = ref(false);
  const error: any = ref("");
  const status: any = ref("");
  const services: any = ref<UpstreamGatewayService[]>([]);
  const selectedServiceId: any = useConsoleUrlState("gateway.service", "");
  const audit: any = ref<UpstreamGatewayAuditItem[]>([]);
  const metrics: any = ref<UpstreamGatewayMetrics>({});

  const selectedService: any = computed(() : any =>
    services.value.find((service?: any) : any => service.serviceId === selectedServiceId.value) || services.value[0] || null,
  );

  const selectedOperation: any = computed(() : any => selectedService.value?.operations?.[0] || null);

  function gatewayStateClass(disabled?: boolean) : any {
    return disabled ? "disabled" : "active";
  }

  function gatewayAuditStatus(item: UpstreamGatewayAuditItem) : any {
    return item.status || item.result || item.reasonCode || "recorded";
  }

  function gatewayAuditTime(item: UpstreamGatewayAuditItem) : any {
    return item.createdAt || item.finishedAt || item.startedAt || "";
  }

  function syncSelectedService(nextServices: UpstreamGatewayService[]) : any {
    if (nextServices.some((service?: any) : any => service.serviceId === selectedServiceId.value)) {
      return;
    }
    selectedServiceId.value = nextServices[0]?.serviceId || "";
  }

  async function refreshGateway() : Promise<any> {
    loading.value = true;
    error.value = "";
    status.value = "";
    try {
      const [servicePayload, auditPayload, metricsPayload] = await Promise.all([
        listUpstreamGatewayServices(),
        listUpstreamGatewayAudit(),
        getUpstreamGatewayMetrics(),
      ]);
      const nextServices: any = Array.isArray(servicePayload.items) ? servicePayload.items : [];
      services.value = nextServices;
      audit.value = Array.isArray(auditPayload.items) ? auditPayload.items : [];
      metrics.value = metricsPayload;
      syncSelectedService(nextServices);
      status.value = "已同步";
    } catch (err: any) {
      error.value = err instanceof Error ? err.message : "刷新失败";
    } finally {
      loading.value = false;
    }
  }

  onMounted(() : any => {
    void refreshGateway();
  });

  usePageRefreshHandler(
    (detail?: any) : any => detail.viewId === "admin" && detail.adminView === "upstreamServices",
    refreshGateway,
  );

  return {
    audit,
    error,
    gatewayAuditStatus,
    gatewayAuditTime,
    gatewayStateClass,
    loading,
    metrics,
    refreshGateway,
    selectedOperation,
    selectedService,
    selectedServiceId,
    services,
    status,
  };
}
