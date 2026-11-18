// @vitest-environment jsdom
import { mount, flushPromises } from "@vue/test-utils";
import { computed, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readinessClients: any = vi.hoisted(() : any => ({
  getOperationPermissionCatalog: vi.fn(),
  getOperationPermissionGrants: vi.fn(),
  listApiKeys: vi.fn(),
}));

vi.mock("../../../apps/console/lib/api-key-distribution-client", () : any => ({
  listApiKeys: readinessClients.listApiKeys,
}));
vi.mock("../../../apps/console/lib/operation-permission-client", () : any => ({
  getOperationPermissionCatalog: readinessClients.getOperationPermissionCatalog,
  getOperationPermissionGrants: readinessClients.getOperationPermissionGrants,
}));
vi.mock("@meshrix/ui-console/page-refresh", () : any => ({
  usePageRefreshHandler: vi.fn(),
}));

import { useServiceReadiness } from "../../../apps/console/views/admin/upstream-gateway/useServiceReadiness";

let wrapper: any = null;

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  readinessClients.getOperationPermissionCatalog.mockResolvedValue({ tools: [] });
  readinessClients.getOperationPermissionGrants.mockResolvedValue({ grants: [] });
  readinessClients.listApiKeys.mockResolvedValue({ records: [] });
});

describe("upstream service readiness reads", () => {
  it("waits for a selected service before loading readiness datasets", async () => {
    const services: any = ref<any[]>([]);
    const audit: any = ref<any[]>([]);
    const selectedService: any = computed(() => services.value[0] || null);
    const Harness: any = defineComponent({
      setup() {
        useServiceReadiness({ services, audit, selectedService });
        return () => h("div");
      },
    });
    wrapper = mount(Harness);

    await flushPromises();
    expect(readinessClients.getOperationPermissionCatalog).not.toHaveBeenCalled();
    expect(readinessClients.getOperationPermissionGrants).not.toHaveBeenCalled();
    expect(readinessClients.listApiKeys).not.toHaveBeenCalled();

    services.value = [{ serviceId: "service-fixture" }];
    await nextTick();
    await flushPromises();

    expect(readinessClients.getOperationPermissionCatalog).toHaveBeenCalledTimes(1);
    expect(readinessClients.getOperationPermissionGrants).toHaveBeenCalledTimes(1);
    expect(readinessClients.listApiKeys).toHaveBeenCalledTimes(1);
  });
});
