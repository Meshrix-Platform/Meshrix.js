import { computed, ref } from "vue";
import { confirmConsoleAction } from "./console-browser-effects";
import {
  getOrganizationGovernance,
  importOrganizationGovernance,
  ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
  previewOrganizationGovernance,
  publishOrganizationGovernance,
  type OrganizationGovernanceGetResponse,
  type OrganizationGovernancePreview,
  type OrganizationGovernanceSnapshot,
  type OrganizationGovernanceTemplateDraft,
  type OrganizationTemplateSummary,
} from "../lib/organization-governance-template-client";
import { browserWindow } from "../lib/browser-window";
import {
  organizationGovernanceTemplateName,
  organizationGovernanceText,
} from "../i18n/organization-governance";

export const ORGANIZATION_GOVERNANCE_DRAFT_STORAGE_KEY = "meshrix.organization-governance.draft";
export const ORGANIZATION_GOVERNANCE_DRAFT_SCHEMA_VERSION = ORGANIZATION_TEMPLATE_SCHEMA_VERSION;

type DraftEnvelope = {
  schemaVersion: typeof ORGANIZATION_TEMPLATE_SCHEMA_VERSION;
  expectedRevision: number;
  draft: OrganizationGovernanceTemplateDraft;
};
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
export type OrganizationGovernanceClient = {
  get: () => Promise<OrganizationGovernanceGetResponse>;
  import: typeof importOrganizationGovernance;
  preview: typeof previewOrganizationGovernance;
  publish: typeof publishOrganizationGovernance;
};
export type OrganizationGovernanceControllerOptions = {
  client?: OrganizationGovernanceClient;
  confirmAction?: typeof confirmConsoleAction;
  storage?: StorageLike | null;
};
const defaultClient: OrganizationGovernanceClient = {
  get: getOrganizationGovernance,
  import: importOrganizationGovernance,
  preview: previewOrganizationGovernance,
  publish: publishOrganizationGovernance,
};

function copyDraft(draft: OrganizationGovernanceTemplateDraft): OrganizationGovernanceTemplateDraft {
  return JSON.parse(JSON.stringify(draft));
}

function isDraft(value: any): value is OrganizationGovernanceTemplateDraft {
  return Boolean(value) && value.schemaVersion === ORGANIZATION_TEMPLATE_SCHEMA_VERSION &&
    typeof value.templateKey === "string" && typeof value.templateName === "string" &&
    typeof value.description === "string" && Number.isInteger(value.organizationDepth) &&
    Array.isArray(value.nodes) && Array.isArray(value.tags) && Array.isArray(value.roles);
}

function readEnvelope(storage: StorageLike | null): DraftEnvelope | null {
  try {
    const value: any = JSON.parse(storage?.getItem(ORGANIZATION_GOVERNANCE_DRAFT_STORAGE_KEY) || "null");
    return value?.schemaVersion === ORGANIZATION_TEMPLATE_SCHEMA_VERSION &&
      Number.isSafeInteger(value.expectedRevision) && value.expectedRevision >= 0 && isDraft(value.draft)
      ? { schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION, expectedRevision: value.expectedRevision, draft: copyDraft(value.draft) }
      : null;
  } catch { return null; }
}

type OrganizationGovernanceErrorKind =
  | "revision_conflict"
  | "collision"
  | "invalid"
  | "not_found"
  | "unavailable";

function organizationGovernanceErrorKind(error: unknown): OrganizationGovernanceErrorKind {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("revision_conflict") || message.includes("组织治理架构已更新")) return "revision_conflict";
  if (message.includes("collision") || message.includes("非模板管理的权限记录冲突")) return "collision";
  if (message.includes("invalid") || message.includes("组织治理架构无效")) return "invalid";
  if (message.includes("not_found") || message.includes("组织治理模板不存在")) return "not_found";
  return "unavailable";
}

function boundedError(error: unknown): string {
  const kind: OrganizationGovernanceErrorKind = organizationGovernanceErrorKind(error);
  if (kind === "revision_conflict") return "组织架构已被其他操作更新。草稿已保留，请加载最新状态后重试。";
  if (kind === "collision") return "模板标签或角色与非模板管理的记录冲突；已发布状态未改变。";
  if (kind === "invalid") return "模板无效，请检查 TOML 结构、层级、标签和角色。";
  if (kind === "not_found") return "所选内置模板不存在，请刷新目录。";
  return "组织治理服务暂时不可用，浏览器草稿未受影响。";
}

export function useConsoleOrganizationGovernanceController(options: OrganizationGovernanceControllerOptions = {}) {
  const client: any = options.client || defaultClient;
  const storage: any = options.storage === undefined ? browserWindow()?.localStorage || null : options.storage;
  const confirmAction: any = options.confirmAction || confirmConsoleAction;
  const restored: any = readEnvelope(storage);
  const snapshot = ref<OrganizationGovernanceSnapshot | null>(null);
  const templates = ref<OrganizationTemplateSummary[]>([]);
  const draft = ref<OrganizationGovernanceTemplateDraft | null>(restored?.draft || null);
  const preview = ref<OrganizationGovernancePreview | null>(null);
  const expectedRevision = ref(restored?.expectedRevision || 0);
  const loading = ref(false);
  const importing = ref(false);
  const validating = ref(false);
  const publishing = ref(false);
  const revisionConflict = ref(false);
  const error = ref("");
  const status = ref(restored ? "已恢复当前浏览器保存的草稿。" : "");
  const configured = computed(() => Boolean(snapshot.value?.configured));
  const hasDraft = computed(() => Boolean(draft.value));

  function persistDraft(message = "草稿已保存到当前浏览器。"): boolean {
    if (!draft.value || !storage) return false;
    try {
      storage.setItem(ORGANIZATION_GOVERNANCE_DRAFT_STORAGE_KEY, JSON.stringify({
        schemaVersion: ORGANIZATION_TEMPLATE_SCHEMA_VERSION,
        expectedRevision: expectedRevision.value,
        draft: draft.value,
      } satisfies DraftEnvelope));
      status.value = message;
      return true;
    } catch { error.value = "当前浏览器无法保存本地草稿。"; return false; }
  }

  async function refresh(): Promise<boolean> {
    loading.value = true;
    error.value = "";
    try {
      const result: any = await client.get();
      snapshot.value = result.snapshot;
      templates.value = result.templates;
      if (draft.value) revisionConflict.value = expectedRevision.value !== result.snapshot.revision;
      else expectedRevision.value = result.snapshot.revision;
      return true;
    } catch (caught) { error.value = boundedError(caught); return false; }
    finally { loading.value = false; }
  }

  async function acceptImportedDraft(request: any, message: string): Promise<void> {
    importing.value = true;
    error.value = "";
    try {
      const result: any = await client.import(request);
      draft.value = copyDraft(result.draft);
      preview.value = null;
      expectedRevision.value = snapshot.value?.revision || 0;
      revisionConflict.value = false;
      persistDraft(message);
    } catch (caught) { error.value = boundedError(caught); }
    finally { importing.value = false; }
  }

  async function importBuiltIn(templateKey: string): Promise<void> {
    await acceptImportedDraft({ templateKey }, "已导入内置 TOML 模板；尚未发布。" );
  }

  async function importLocalFiles(files: File[]): Promise<void> {
    const file: any = files.length === 1 ? files[0] : null;
    if (!file || !file.name.toLowerCase().endsWith(".toml") || file.size > 256 * 1024) {
      error.value = "请选择一个不超过 256 KiB 的 .toml 文件。";
      return;
    }
    await acceptImportedDraft({ source: await file.text(), fileName: file.name }, "已导入并规范化本地 TOML 草稿；尚未发布。" );
  }

  function editPublishedSnapshot(): void {
    if (!snapshot.value?.configured) return;
    const { protocolVersion: _protocol, configured: _configured, revision: _revision, publishedAt: _published, ...value } = snapshot.value;
    draft.value = copyDraft(value);
    expectedRevision.value = snapshot.value.revision;
    preview.value = null;
    revisionConflict.value = false;
    persistDraft("已从当前已发布版本创建浏览器草稿。");
  }

  async function adoptLatestRevision(): Promise<void> {
    const refreshed: any = await refresh();
    if (!refreshed || !snapshot.value) return;
    expectedRevision.value = snapshot.value.revision;
    revisionConflict.value = false;
    persistDraft("已加载最新状态；草稿内容保持不变。" );
  }

  async function runPreview(): Promise<boolean> {
    if (!draft.value) return false;
    validating.value = true;
    error.value = "";
    try {
      preview.value = (await client.preview(copyDraft(draft.value))).preview;
      return true;
    } catch (caught) {
      preview.value = null;
      error.value = boundedError(caught);
      return false;
    } finally {
      validating.value = false;
    }
  }

  async function validateDraft(): Promise<void> {
    if (!await runPreview()) return;
    persistDraft("服务端验证通过；尚未发布任何变更。");
  }

  async function publishDraft(): Promise<void> {
    if (!draft.value || revisionConflict.value) return;
    publishing.value = true;
    try {
      const templateName: any = organizationGovernanceTemplateName(
        draft.value.templateKey,
        draft.value.templateName,
      );
      const confirmed: any = await confirmAction(organizationGovernanceText(
        `是否发布${templateName}模板？`,
        `Publish the ${templateName} template?`,
      ), {
        title: organizationGovernanceText(`发布${templateName}模板`, `Publish ${templateName} Template`),
        confirmLabel: organizationGovernanceText("发布", "Publish"),
        tone: "danger",
      });
      if (!confirmed) return;
      if (!await runPreview()) return;
      const result: any = await client.publish({ expectedRevision: expectedRevision.value, ...copyDraft(draft.value) });
      snapshot.value = result.snapshot;
      expectedRevision.value = result.snapshot.revision;
      draft.value = null;
      preview.value = null;
      revisionConflict.value = false;
      storage?.removeItem(ORGANIZATION_GOVERNANCE_DRAFT_STORAGE_KEY);
      const publishedTemplateName: any = organizationGovernanceTemplateName(
        result.snapshot.templateKey,
        result.snapshot.templateName,
      );
      status.value = organizationGovernanceText(
        `${publishedTemplateName}模板已发布。`,
        `${publishedTemplateName} template published.`,
      );
    } catch (caught) {
      error.value = boundedError(caught);
      revisionConflict.value = organizationGovernanceErrorKind(caught) === "revision_conflict";
      persistDraft("");
    } finally { publishing.value = false; }
  }

  async function cancelEditDraft(): Promise<void> {
    if (!draft.value || validating.value || publishing.value) return;
    const confirmed: any = await confirmAction(organizationGovernanceText(
      "是否取消编辑并丢弃当前浏览器草稿？已发布状态不会改变。",
      "Cancel editing and discard the current browser draft? Published state will not change.",
    ), {
      title: organizationGovernanceText("取消编辑", "Cancel Editing"),
      confirmLabel: organizationGovernanceText("取消编辑", "Cancel Editing"),
      tone: "danger",
    });
    if (!confirmed) return;
    draft.value = null;
    preview.value = null;
    revisionConflict.value = false;
    error.value = "";
    expectedRevision.value = snapshot.value?.revision || 0;
    storage?.removeItem(ORGANIZATION_GOVERNANCE_DRAFT_STORAGE_KEY);
    status.value = organizationGovernanceText(
      "已取消编辑并丢弃浏览器草稿。",
      "Editing cancelled and the browser draft was discarded.",
    );
  }

  return {
    adoptLatestRevision, cancelEditDraft, configured, draft, editPublishedSnapshot, error,
    hasDraft, importBuiltIn, importLocalFiles, importing, loading, persistDraft, preview,
    publishDraft, publishing, refresh, revisionConflict, snapshot, status, templates,
    validateDraft, validating,
  };
}
