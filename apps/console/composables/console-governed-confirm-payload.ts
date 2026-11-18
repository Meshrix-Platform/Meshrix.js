// Standard governed-confirm payload (REQ-011, node P2-2).
//
// One fact structure — what effect, on what resource, with what authority, for
// how long, at what risk — shared by the approval flow and the REQ-010
// destructive-operation registry, so a governed decision reads in one glance.
//
// The module is PURE (no Vue imports). Fact values may be literal copy or
// dotted dictionary keys (governedConfirm.* and destructive.consequence.*),
// resolved inside the builder for both locales, so the module stays testable
// without a mounted app; N3's reuse gate and Node tooling may import it too.
// Resolved effect copy may carry a {resource} placeholder, substituted with
// the resolved resource fact (the registry's consequence entries use it).
//
// Consumption contract:
// - Approval flow: build once from operation-derived facts with
//   { resolution, hasApprovalLayers }; the single returned payload feeds BOTH
//   the confirm dialog and the success toast (same copy object).
// - Destructive registry: effect = the entry's consequence key, resource =
//   call-site context, authority/duration = governedConfirm dictionary copy,
//   risk = "destructive"; the registry keeps its audit-level tone mapping
//   (warning -> neutral dialog tone) at its call site.
//
// Later governed confirm surfaces SHOULD build their payloads through this
// module instead of assembling inline copy.
import { consoleMessages } from "../i18n/console-messages";
import type { ConsoleLocale } from "../i18n/console-locale-state";

export type GovernedConfirmResolution = "approved" | "rejected";

export type GovernedConfirmFacts = {
  /** What happens. Localized copy, or a dotted governedConfirm.* / destructive.consequence.* dictionary key resolved by the builder. */
  effect: string;
  /** What the effect targets. Call-site literal or dictionary key. */
  resource: string;
  /** Who authorizes it. e.g. requester copy or a governedConfirm.authority.* key ("this console session"). */
  authority: string;
  /** How long the effect holds. Deadline copy, a governedConfirm.duration.* key, or "" to omit the fact line. */
  duration: string;
  /** Risk enum (read_only | safe_write | repair_write | destructive | ...). "destructive" escalates the tone to danger. */
  risk: string;
};

export type GovernedConfirmPayloadOptions = {
  /** Approval-flow resolution. "rejected" forces danger tone and reject copy; "approved" keeps the rule-based tone and approve copy. */
  resolution?: GovernedConfirmResolution;
  /** Layer-aware approve variants ("Approve Current Layer" copy) — approval flow only. */
  hasApprovalLayers?: boolean;
  /** Optional confirm-button label override; defaults to the dictionary variant for the resolution. */
  confirmLabel?: string;
};

export type GovernedConfirmPayload = {
  title: string;
  body: string;
  tone: "neutral" | "danger";
  confirmLabel: string;
  toastMessage: string;
  toastTitle: string;
};

function governedDictionary(locale: ConsoleLocale): any {
  return (
    consoleMessages[locale]?.governedConfirm ||
    consoleMessages.en.governedConfirm
  );
}

function isDevelopmentBuild(): boolean {
  return Boolean((import.meta as any).env?.DEV);
}

/**
 * Resolves a fact value that may be a dotted dictionary key (owned namespaces:
 * governedConfirm.* and destructive.consequence.*) into localized copy; any
 * other value is used verbatim.
 */
function resolveFactCopy(value: string, locale: ConsoleLocale): string {
  if (!value || !value.includes(".")) {
    return value;
  }
  const root: string = value.split(".")[0];
  if (root !== "governedConfirm" && root !== "destructive") {
    return value;
  }
  let node: any = consoleMessages[locale];
  for (const segment of value.split(".")) {
    node = node?.[segment];
  }
  return typeof node === "string" && node.trim() ? node : value;
}

function resolveRiskLabel(risk: string, locale: ConsoleLocale): string {
  const group: any = governedDictionary(locale);
  return group.risk[risk] || group.risk.notDeclared;
}

function factLine(label: string, value: string, locale: ConsoleLocale): string {
  return `${label}${locale === "en" ? ": " : "："}${value}`;
}

export function buildGovernedConfirmPayload(
  facts: GovernedConfirmFacts,
  locale: ConsoleLocale,
  options: GovernedConfirmPayloadOptions = {},
): GovernedConfirmPayload {
  // Never render a half-fact confirm: the guard surfaces in development and
  // in the test suite (both consumers always pass complete facts).
  if (isDevelopmentBuild()) {
    if (!String(facts.effect || "").trim()) {
      throw new Error("governed confirm requires an effect fact");
    }
    if (!String(facts.resource || "").trim()) {
      throw new Error("governed confirm requires a resource fact");
    }
  }
  const group: any = governedDictionary(locale);
  const labels: any = group.factLabel;
  // Effect copy may reference the resource via a {resource} placeholder
  // (the destructive registry's consequence entries do); substitute the
  // resolved resource fact before rendering the line.
  const effectCopy: string = resolveFactCopy(facts.effect, locale).replaceAll(
    "{resource}",
    resolveFactCopy(facts.resource, locale),
  );
  const lines: string[] = [
    factLine(labels.effect, effectCopy, locale),
    factLine(labels.resource, resolveFactCopy(facts.resource, locale), locale),
    factLine(labels.authority, resolveFactCopy(facts.authority, locale), locale),
  ];
  if (String(facts.duration || "").trim()) {
    lines.push(
      factLine(labels.duration, resolveFactCopy(facts.duration, locale), locale),
    );
  }
  lines.push(factLine(labels.risk, resolveRiskLabel(facts.risk, locale), locale));

  const resolution: GovernedConfirmResolution | undefined = options.resolution;
  const layered: boolean = Boolean(options.hasApprovalLayers);
  const variant: string =
    resolution === "rejected"
      ? "reject"
      : resolution === "approved"
        ? layered
          ? "approveLayers"
          : "approve"
        : "confirm";

  let body: string = lines.join("\n");
  let tone: "neutral" | "danger" = "neutral";
  if (resolution === "rejected") {
    tone = "danger";
    body = `${body}\n\n${group.prompt.reject}`;
  } else if (resolution === "approved") {
    tone = facts.risk === "destructive" ? "danger" : "neutral";
    body = `${body}\n\n${layered ? group.prompt.approveLayers : group.prompt.approve}`;
  } else {
    tone = facts.risk === "destructive" ? "danger" : "neutral";
  }

  return {
    title: group.title[variant],
    body,
    tone,
    confirmLabel: options.confirmLabel || group.confirmLabel[variant],
    toastMessage: group.toastMessage[variant],
    toastTitle: resolution
      ? group.toastTitle.approval
      : group.toastTitle.confirm,
  };
}
