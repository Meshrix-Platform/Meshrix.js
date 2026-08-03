import { currentConsoleLocale, resolveEffectiveConsoleLocale } from "./console-locale-state";
import type { ApiKeyStatus } from "../lib/api-key-distribution-client";

export function apiKeyDistributionText(zh: string, en: string): string {
  return resolveEffectiveConsoleLocale(currentConsoleLocale.value) === "en" ? en : zh;
}

export function apiKeyStatusText(status: ApiKeyStatus): string {
  return ({
    active: apiKeyDistributionText("可用", "Active"),
    revoked: apiKeyDistributionText("已撤销", "Revoked"),
    expired: apiKeyDistributionText("已到期", "Expired"),
    exhausted: apiKeyDistributionText("次数已用完", "Use limit reached"),
  } as Record<ApiKeyStatus, string>)[status];
}

export function apiKeyErrorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  if (message.includes("api_key_revision_stale")) {
    return apiKeyDistributionText("该密钥已被其他操作更新，请同步最新状态后重试。", "This key changed elsewhere. Sync the latest state and try again.");
  }
  if (message.includes("api_key_scope_denied")) {
    return apiKeyDistributionText("当前账号不能管理所选组织范围。", "Your account cannot manage the selected organization scope.");
  }
  if (message.includes("api_key_inactive")) {
    return apiKeyDistributionText("该密钥已经结束使用，不能再变更。", "This key is no longer active and cannot be changed.");
  }
  if (message.includes("api_key_authority_unavailable") || message.includes("api_key_authority_stale")) {
    return apiKeyDistributionText("组织权限刚刚发生变化，请同步后再继续。", "Organization authority changed. Sync before continuing.");
  }
  return apiKeyDistributionText("密钥分发服务暂时不可用，请稍后同步重试。", "Key distribution is temporarily unavailable. Sync and try again later.");
}
