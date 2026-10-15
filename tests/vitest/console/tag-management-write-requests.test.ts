// @vitest-environment jsdom
import { defineComponent, nextTick } from "vue";
import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTagManagementConsole } from "../../../apps/console/composables/console-tag-management-controller";

const clientMock = vi.hoisted(() => ({
  archiveTagManagementTag: vi.fn(),
  listTagManagementAudit: vi.fn(),
  listTagManagementProjections: vi.fn(),
  listTagManagementTags: vi.fn(),
  rebuildTagManagementProjections: vi.fn(),
  restoreTagManagementTag: vi.fn(),
  upsertTagManagementTag: vi.fn(),
}));

vi.mock("../../../apps/console/lib/tag-management-client", () => clientMock);
vi.mock("../../../apps/console/composables/console-browser-effects", () => ({
  confirmConsoleAction: vi.fn(async () => true),
}));
vi.mock("@meshrix/ui-console/page-refresh", () => ({
  usePageRefreshHandler: vi.fn(),
}));

const tag = (overrides: Record<string, unknown> = {}) => ({
  protocolVersion: "v0.0.1:platform:tag-management-1",
  tagId: "custom:one",
  kind: "custom",
  label: "One",
  description: "",
  parentTagId: "",
  enabled: true,
  system: false,
  status: "active",
  scopePrerequisites: [],
  metadata: {},
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => Promise.resolve()).then(() => nextTick());
}

describe("tag management write requests", () => {
  let wrapper: ReturnType<typeof mount> | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.listTagManagementTags.mockResolvedValue({ items: [tag()], count: 1 });
    clientMock.listTagManagementProjections.mockResolvedValue({ items: [], count: 0 });
    clientMock.listTagManagementAudit.mockResolvedValue({ items: [], count: 0 });
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });

  it("uses the committed tag row and preserves filters without rereading the tag list", async () => {
    let controller: ReturnType<typeof useTagManagementConsole> | undefined;
    wrapper = mount(defineComponent({
      setup() {
        controller = useTagManagementConsole();
        return () => null;
      },
    }));
    await flushPromises();

    controller!.kindFilter.value = "custom";
    await flushPromises();
    expect(clientMock.listTagManagementTags).toHaveBeenCalledTimes(2);

    clientMock.upsertTagManagementTag.mockResolvedValue({
      tag: tag({ kind: "organization", label: "Updated", updatedAt: "2026-10-08T00:00:00.000Z" }),
    });
    await controller!.saveEditor();

    expect(controller!.tags.value).toEqual([]);
    expect(clientMock.upsertTagManagementTag).toHaveBeenCalledTimes(1);
    expect(clientMock.listTagManagementTags).toHaveBeenCalledTimes(2);
    expect(clientMock.listTagManagementProjections).toHaveBeenCalledTimes(3);
    expect(clientMock.listTagManagementAudit).toHaveBeenCalledTimes(3);
  });
});
