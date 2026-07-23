import { computed, onMounted, ref } from "vue";
import { usePageRefreshHandler } from "@lico/ui-console/page-refresh";
import {
  getUpstreamGatewayMetrics,
  listUpstreamGatewayAudit,
  listUpstreamGatewayServices,
  type UpstreamGatewayAuditItem,
  type UpstreamGatewayMetrics,
  type UpstreamGatewayService,
} from "../../../lib/upstream-gateway-client";

export function useUpstreamGatewayView() {
  const loading = ref(false);
  const error = ref("");
  const status = ref("");
  const services = ref<UpstreamGatewayService[]>([]);
  const selectedServiceId = ref("");
  const audit = ref<UpstreamGatewayAuditItem[]>([]);
  const metrics = ref<UpstreamGatewayMetrics>({});

  const selectedService = computed(() =>
    services.value.find((service) => service.serviceId === selectedServiceId.value) || services.value[0] || null,
  );

  const selectedOperation = computed(() => selectedService.value?.operations?.[0] || null);

  function gatewayStateClass(disabled?: boolean) {
    return disabled ? "disabled" : "active";
  }

  function gatewayAuditStatus(item: UpstreamGatewayAuditItem) {
    return item.status || item.result || item.reasonCode || "recorded";
  }

  function gatewayAuditTime(item: UpstreamGatewayAuditItem) {
    return item.createdAt || item.finishedAt || item.startedAt || "";
  }

  function syncSelectedService(nextServices: UpstreamGatewayService[]) {
    if (nextServices.some((service) => service.serviceId === selectedServiceId.value)) {
      return;
    }
    selectedServiceId.value = nextServices[0]?.serviceId || "";
  }

  async function refreshGateway() {
    loading.value = true;
    error.value = "";
    status.value = "";
    try {
      const [servicePayload, auditPayload, metricsPayload] = await Promise.all([
        listUpstreamGatewayServices(),
        listUpstreamGatewayAudit(),
        getUpstreamGatewayMetrics(),
      ]);
      const nextServices = Array.isArray(servicePayload.items) ? servicePayload.items : [];
      services.value = nextServices;
      audit.value = Array.isArray(auditPayload.items) ? auditPayload.items : [];
      metrics.value = metricsPayload;
      syncSelectedService(nextServices);
      status.value = "已同步";
    } catch (err) {
      error.value = err instanceof Error ? err.message : "刷新失败";
    } finally {
      loading.value = false;
    }
  }

  onMounted(() => {
    void refreshGateway();
  });

  usePageRefreshHandler(
    (detail) => detail.viewId === "admin" && detail.adminView === "upstreamServices",
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
