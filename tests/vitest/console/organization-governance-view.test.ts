// @vitest-environment jsdom

import { flushPromises, mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import OrganizationGovernanceView from "../../../apps/console/views/admin/OrganizationGovernanceView.vue";
import OrganizationAdministratorRoles from "../../../apps/console/views/admin/organization-governance/OrganizationAdministratorRoles.vue";
import { useConsoleOrganizationGovernanceController } from "../../../apps/console/composables/console-organization-governance-controller.ts";
import { organizationGovernanceTemplateName } from "../../../apps/console/i18n/organization-governance.ts";
import {
  ORGANIZATION_GOVERNANCE_PROTOCOL_VERSION,
  ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
  getOrganizationGovernance,
  importOrganizationGovernance,
  previewOrganizationGovernance,
  publishOrganizationGovernance,
  type OrganizationGovernanceTemplateDraft
} from "../../../apps/console/lib/organization-governance-template-client.ts";
import { getJson, postJson } from "@meshrix/ui-console/bridge-http";

vi.mock("@meshrix/ui-console/bridge-http", () : any => ({ getJson: vi.fn(), postJson: vi.fn() }));

const draft: OrganizationGovernanceTemplateDraft = {
  schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
  templateKey: "enterprise-group",
  templateName: "Enterprise group",
  description: "Explicit hierarchy",
  organizationDepth: 0,
  nodes: [{ nodeId: "organization:group", nodeType: "group", parentId: "", name: "Group" }],
  tags: [{ tagId: "organization:group", kind: "organization", label: "Group", parentTagId: "", description: "Group scope", scopePrerequisites: [] }],
  roles: [{
    roleId: "organization-administrator:group",
    name: "Group administrator",
    scopeNodeId: "organization:group",
    scopeNodeType: "group",
    managementActions: ["organization.structure.read"],
    businessResourceActions: [],
    assignedSubjectIds: []
  }]
};
const emptySnapshot: any = {
  protocolVersion: ORGANIZATION_GOVERNANCE_PROTOCOL_VERSION,
  ...draft,
  configured: false,
  revision: 0,
  templateKey: "",
  templateName: "",
  description: "",
  nodes: [], tags: [], roles: [], publishedAt: ""
};

describe("organization governance client", () : any => {
  it("uses catalog, import, preview, and confirmed publish endpoints", async () : Promise<any> => {
    vi.mocked(getJson).mockResolvedValue({ snapshot: emptySnapshot, templates: [] });
    vi.mocked(postJson).mockResolvedValue({ draft });
    await getOrganizationGovernance();
    await importOrganizationGovernance({ templateKey: "enterprise-group" });
    await previewOrganizationGovernance(draft);
    await publishOrganizationGovernance({ ...draft, expectedRevision: 0 });
    expect(getJson).toHaveBeenCalledWith("/api/authorization/organization-governance");
    expect(postJson).toHaveBeenNthCalledWith(1, "/api/authorization/organization-governance/import", { templateKey: "enterprise-group" });
    expect(postJson).toHaveBeenNthCalledWith(2, "/api/authorization/organization-governance/preview", draft);
    expect(postJson).toHaveBeenNthCalledWith(3, "/api/authorization/organization-governance/publish", { ...draft, expectedRevision: 0 }, { safetyConfirm: true });
  });
});

describe("organization governance console flow", () : any => {
  it("distinguishes imported, server-validated, and published administrator roles", async () : Promise<any> => {
    const wrapper: any = mount(OrganizationAdministratorRoles, {
      props: { draft, projection: draft },
      global: { stubs: { HelpTooltip: true } }
    });
    expect(wrapper.text()).toContain("已验证");
    expect(wrapper.text()).not.toContain("已发布");

    await wrapper.setProps({ draft: null, projection: { ...draft, configured: true, revision: 1 } });
    expect(wrapper.text()).toContain("已发布");
  });

  it("presents the built-in enterprise template as the Group option", () : any => {
    expect(organizationGovernanceTemplateName("enterprise-group", "Enterprise group")).toBe("集团");
    expect(organizationGovernanceTemplateName("local-template", "Local template")).toBe("Local template");
  });

  it("stores only the server-normalized built-in draft", async () : Promise<any> => {
    const storage: any = { getItem: vi.fn(() : any => null), setItem: vi.fn(), removeItem: vi.fn() };
    const client: any = {
      get: vi.fn().mockResolvedValue({ snapshot: emptySnapshot, templates: [{ templateKey: "enterprise-group", templateName: "Enterprise group" }] }),
      import: vi.fn().mockResolvedValue({ draft }),
      preview: vi.fn().mockResolvedValue({ preview: draft }),
      publish: vi.fn()
    };
    const controller: any = useConsoleOrganizationGovernanceController({ client, storage });
    await controller.refresh();
    await controller.importBuiltIn("enterprise-group");
    expect(client.import).toHaveBeenCalledWith({ templateKey: "enterprise-group" });
    expect(controller.draft.value).toEqual(draft);
    expect(storage.setItem).toHaveBeenCalled();
  });

  it("imports exactly one bounded local TOML file through the server", async () : Promise<any> => {
    const client: any = { get: vi.fn(), import: vi.fn().mockResolvedValue({ draft }), preview: vi.fn(), publish: vi.fn() };
    const controller: any = useConsoleOrganizationGovernanceController({ client, storage: null });
    const file: any = new File(["schema_version = 'x'"], "local.toml", { type: "application/toml" });
    await controller.importLocalFiles([file]);
    expect(client.import).toHaveBeenCalledWith({ source: "schema_version = 'x'", fileName: "local.toml" });
  });

  it("asks whether to publish the selected template without exposing revision internals", async () : Promise<any> => {
    const confirmAction: any = vi.fn().mockResolvedValue(false);
    const client: any = {
      get: vi.fn().mockResolvedValue({ snapshot: emptySnapshot, templates: [] }),
      import: vi.fn().mockResolvedValue({ draft }),
      preview: vi.fn(),
      publish: vi.fn(),
    };
    const controller: any = useConsoleOrganizationGovernanceController({ client, confirmAction, storage: null });

    await controller.refresh();
    await controller.importBuiltIn("enterprise-group");
    await controller.publishDraft();

    expect(confirmAction).toHaveBeenCalledWith("是否发布集团模板？", {
      title: "发布集团模板",
      confirmLabel: "发布",
      tone: "danger",
    });
    expect(client.preview).not.toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("validates automatically before publishing the selected template", async () : Promise<any> => {
    const publishedSnapshot: any = { ...emptySnapshot, ...draft, configured: true, revision: 1 };
    const client: any = {
      get: vi.fn().mockResolvedValue({ snapshot: emptySnapshot, templates: [] }),
      import: vi.fn().mockResolvedValue({ draft }),
      preview: vi.fn().mockResolvedValue({ preview: draft }),
      publish: vi.fn().mockResolvedValue({ snapshot: publishedSnapshot }),
    };
    const controller: any = useConsoleOrganizationGovernanceController({
      client,
      confirmAction: vi.fn().mockResolvedValue(true),
      storage: null,
    });

    await controller.refresh();
    await controller.importBuiltIn("enterprise-group");
    await controller.publishDraft();

    expect(client.preview).toHaveBeenCalledWith(draft);
    expect(client.publish).toHaveBeenCalledWith({ expectedRevision: 0, ...draft });
    expect(controller.status.value).toBe("集团模板已发布。");
    expect(controller.status.value).not.toContain("修订");
  });

  it("stops publishing when automatic validation fails", async () : Promise<any> => {
    const client: any = {
      get: vi.fn().mockResolvedValue({ snapshot: emptySnapshot, templates: [] }),
      import: vi.fn().mockResolvedValue({ draft }),
      preview: vi.fn().mockRejectedValue(new Error("invalid organization governance")),
      publish: vi.fn(),
    };
    const controller: any = useConsoleOrganizationGovernanceController({
      client,
      confirmAction: vi.fn().mockResolvedValue(true),
      storage: null,
    });

    await controller.refresh();
    await controller.importBuiltIn("enterprise-group");
    await controller.publishDraft();

    expect(client.preview).toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
    expect(controller.error.value).toBe("模板无效，请检查 TOML 结构、层级、标签和角色。");
  });

  it("cancels editing by discarding the browser draft without publishing", async () : Promise<any> => {
    const storage: any = {
      getItem: vi.fn(() : any => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    const confirmAction: any = vi.fn().mockResolvedValue(true);
    const client: any = {
      get: vi.fn().mockResolvedValue({ snapshot: emptySnapshot, templates: [] }),
      import: vi.fn().mockResolvedValue({ draft }),
      preview: vi.fn(),
      publish: vi.fn(),
    };
    const controller: any = useConsoleOrganizationGovernanceController({ client, confirmAction, storage });

    await controller.refresh();
    await controller.importBuiltIn("enterprise-group");
    expect(controller.draft.value).toEqual(draft);

    await controller.cancelEditDraft();

    expect(confirmAction).toHaveBeenCalledWith("是否取消编辑并丢弃当前浏览器草稿？已发布状态不会改变。", {
      title: "取消编辑",
      confirmLabel: "取消编辑",
      tone: "danger",
    });
    expect(controller.draft.value).toBeNull();
    expect(controller.status.value).toBe("已取消编辑并丢弃浏览器草稿。");
    expect(storage.removeItem).toHaveBeenCalled();
    expect(client.publish).not.toHaveBeenCalled();
  });

  it("renders built-in selection and local TOML browse control", async () : Promise<any> => {
    vi.mocked(getJson).mockResolvedValue({
      snapshot: emptySnapshot,
      templates: [{
        templateKey: "enterprise-group",
        templateName: "Enterprise group",
        nodeCount: 5,
        tagCount: 5,
        roleCount: 5,
      }],
    });
    const wrapper: any = mount(OrganizationGovernanceView, {
      global: { stubs: { ConsoleInlineAlert: true, BrowseSelectButton: { template: "<button class='browse-stub'>Import</button>" } } }
    });
    await flushPromises();
    expect(wrapper.find(".organization-governance-layout").exists()).toBe(true);
    expect(wrapper.findAll(".organization-governance-actions.horizontal-action-group")).toHaveLength(1);
    expect(wrapper.text()).toContain("集团");
    expect(wrapper.text()).not.toContain("5/5/5");
    expect(wrapper.text()).not.toContain("服务端修订");
    expect(wrapper.text()).not.toContain("当前修订");
    expect(wrapper.text()).not.toContain("刷新已发布状态");
  });
});
