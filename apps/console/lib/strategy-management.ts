import { getJson } from "@meshrix/ui-console/bridge-http";
import { callRpc } from "@meshrix/ui-console/rpc-client";

const MAX_CAPABILITIES: any = 32;
const MAX_PUBLIC_LIST_ITEMS: any = 16;
const MAX_PUBLIC_TEXT_LENGTH: any = 256;

export type StrategyDescription = {
  protocolVersion: string;
  capabilities: string[];
};

export type StrategyPreviewState = "empty" | "loading" | "accepted" | "denied" | "error";

export type StrategyPolicyDecision = {
  protocolVersion?: string;
  strategyProtocolVersion?: string;
  policyType?: string;
  effect?: string;
  reasonCode?: string;
  requiresApproval?: boolean;
  allowed?: boolean;
  decisionId?: string;
  createdAt?: string;
  evaluatedLayers?: string[];
};

export type StrategyPreviewResult = {
  state: Exclude<StrategyPreviewState, "empty" | "loading">;
  decision: StrategyPolicyDecision | null;
  error: string;
};

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized: any = value.trim();
  return normalized ? normalized.slice(0, MAX_PUBLIC_TEXT_LENGTH) : undefined;
}

function boundedStrings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values: any[] = [...new Set<any>(value.map(boundedText).filter((item?: any): item is string => Boolean(item)))];
  return values.length ? values.slice(0, MAX_PUBLIC_LIST_ITEMS) : undefined;
}

function publicDecision(value: unknown): StrategyPolicyDecision {
  const source: any = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    ...(boundedText(source.protocolVersion) ? { protocolVersion: boundedText(source.protocolVersion) } : {}),
    ...(boundedText(source.strategyProtocolVersion)
      ? { strategyProtocolVersion: boundedText(source.strategyProtocolVersion) }
      : {}),
    ...(boundedText(source.policyType) ? { policyType: boundedText(source.policyType) } : {}),
    ...(boundedText(source.effect) ? { effect: boundedText(source.effect) } : {}),
    ...(boundedText(source.reasonCode) ? { reasonCode: boundedText(source.reasonCode) } : {}),
    ...(typeof source.requiresApproval === "boolean" ? { requiresApproval: source.requiresApproval } : {}),
    ...(typeof source.allowed === "boolean" ? { allowed: source.allowed } : {}),
    ...(boundedText(source.decisionId) ? { decisionId: boundedText(source.decisionId) } : {}),
    ...(boundedText(source.createdAt) ? { createdAt: boundedText(source.createdAt) } : {}),
    ...(boundedStrings(source.evaluatedLayers) ? { evaluatedLayers: boundedStrings(source.evaluatedLayers) } : {}),
  };
}

export function isStrategyPreviewCapability(capability: string): boolean {
  return /^strategy\.[a-z][a-z0-9_]*\.(?:evaluate|preview)$/.test(capability);
}

export async function loadStrategyDescription(): Promise<StrategyDescription> {
  const response: any = await getJson<Partial<StrategyDescription>>("/api/strategy");
  const protocolVersion: any = boundedText(response?.protocolVersion) || "";
  const capabilities: any = [...new Set<any>(
    (Array.isArray(response?.capabilities) ? response.capabilities : [])
      .map(boundedText)
      .filter((item?: any): item is string => Boolean(item)),
  )].slice(0, MAX_CAPABILITIES);
  return { protocolVersion, capabilities };
}

export function parseStrategyPreviewInput(input: string): Record<string, unknown> {
  const parsed: any = JSON.parse(input.trim() || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("预览输入必须是 JSON 对象。");
  }
  return parsed as Record<string, unknown>;
}

export async function previewStrategyCapability(
  capability: string,
  input: Record<string, unknown>,
): Promise<StrategyPreviewResult> {
  if (!isStrategyPreviewCapability(capability)) {
    return { state: "error", decision: null, error: "请选择服务端提供的策略预览能力。" };
  }
  try {
    const response: any = await callRpc<unknown>(capability, input);
    const responseObject: any = response && typeof response === "object" && !Array.isArray(response)
      ? response as Record<string, unknown>
      : null;
    const decision: any = publicDecision(responseObject?.decision ?? response);
    const denied: any = decision.effect === "deny" || decision.effect === "require_confirmation" || decision.allowed === false;
    const accepted: any = decision.effect === "allow" || decision.allowed === true;
    if (!denied && !accepted) {
      return { state: "error", decision: null, error: "服务端未返回可识别的策略结果。" };
    }
    return { state: denied ? "denied" : "accepted", decision, error: "" };
  } catch {
    return { state: "error", decision: null, error: "策略预览失败。" };
  }
}
