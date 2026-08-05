// Machine-readable registry of every console destructive operation (REQ-010).
//
// This module is the single audit surface for the destructive-operation reuse
// gate (REQ-003) and for governed-confirm payload builders: entries below are
// plain frozen literals with no computed ids, so Node tooling can statically
// read them. Entries carry dictionary KEYS, never resolved strings — copy
// resolution happens at call time inside requestDestructiveConfirm(). The
// module itself uses no Vue APIs; it imports only the message dictionary, the
// readonly locale ref, and the confirm queue, all consumed at request time.
//
// Adoption contract for every destructive handler (including the publish lane
// wired by N13/N14 against publish.service.disable/.republish/.remove):
//
//   if (!(await requestDestructiveConfirm("<entry-id>", { resource }))) return;
//
// Place the call after pure validation pre-checks (binding guards, row-count
// guards) and before ANY mutation or persist of the operation. A confirm
// resolving false — including the no-dialog-host case — aborts the operation
// silently-clean: no error toast, no busy state.
import { consoleMessages } from "../i18n/console-messages";
import { currentConsoleLocale, type ConsoleLocale } from "../i18n/console-locale-state";
import { requestConsoleConfirm } from "./console-confirm-controller";
import { buildGovernedConfirmPayload } from "./console-governed-confirm-payload";

export type ConsoleDestructiveOperationTone = "neutral" | "warning" | "danger";

export type ConsoleDestructiveOperationId =
  | "auth.session.revoke"
  | "model-repository.provider.remove"
  | "maintenance-agent.schedule.remove"
  | "service-discovery.address.remove"
  | "publish.service.disable"
  | "publish.service.republish"
  | "publish.service.remove";

export type ConsoleDestructiveOperation = {
  /** Frozen registry id; call sites pass this literal and the reuse gate matches it. */
  id: ConsoleDestructiveOperationId;
  /**
   * Audit-level severity. The confirm dialog renders only neutral|danger, so
   * requestDestructiveConfirm maps warning to neutral when building the request.
   */
  tone: ConsoleDestructiveOperationTone;
  /** Dotted key into consoleMessages (destructive.consequence.*); supports a {resource} placeholder. */
  consequence: string;
  /**
   * Typed-confirmation text. Reserved for irreversible, wide-blast operations
   * (H12 budget): none of the registered operations carries one — typed input
   * would be incidental friction on single-resource, reversible-window paths.
   */
  requireText?: string;
};

export const CONSOLE_DESTRUCTIVE_OPERATIONS: readonly ConsoleDestructiveOperation[] = Object.freeze([
  Object.freeze<ConsoleDestructiveOperation>({
    id: "auth.session.revoke",
    tone: "danger",
    consequence: "destructive.consequence.authSessionRevoke",
  }),
  Object.freeze<ConsoleDestructiveOperation>({
    id: "model-repository.provider.remove",
    tone: "warning",
    consequence: "destructive.consequence.modelRepositoryProviderRemove",
  }),
  Object.freeze<ConsoleDestructiveOperation>({
    id: "maintenance-agent.schedule.remove",
    tone: "warning",
    consequence: "destructive.consequence.maintenanceAgentScheduleRemove",
  }),
  Object.freeze<ConsoleDestructiveOperation>({
    id: "service-discovery.address.remove",
    tone: "danger",
    consequence: "destructive.consequence.serviceDiscoveryAddressRemove",
  }),
  Object.freeze<ConsoleDestructiveOperation>({
    id: "publish.service.disable",
    tone: "danger",
    consequence: "destructive.consequence.publishServiceDisable",
  }),
  Object.freeze<ConsoleDestructiveOperation>({
    id: "publish.service.republish",
    tone: "warning",
    consequence: "destructive.consequence.publishServiceRepublish",
  }),
  Object.freeze<ConsoleDestructiveOperation>({
    id: "publish.service.remove",
    tone: "danger",
    consequence: "destructive.consequence.publishServiceRemove",
  }),
]);

export function getDestructiveOperation(id: string): ConsoleDestructiveOperation | undefined {
  return CONSOLE_DESTRUCTIVE_OPERATIONS.find((operation) => operation.id === id);
}

export function requestDestructiveConfirm(
  id: ConsoleDestructiveOperationId,
  context: { resource: string },
): Promise<boolean> {
  const operation = getDestructiveOperation(id);
  if (!operation) {
    // Unreachable for typed call sites; the reuse gate also rejects
    // unregistered ids statically. Fail loud here, never unguarded.
    throw new Error(`Unregistered destructive operation: ${id}`);
  }
  const locale: ConsoleLocale = currentConsoleLocale.value;
  // Standard governed-confirm fact structure (shared with the approval flow):
  // effect = the registry consequence key, resource = the call-site context,
  // authority/duration = governedConfirm dictionary copy. The session-scoped
  // revoke omits the duration fact (its effect is immediate).
  const payload = buildGovernedConfirmPayload(
    {
      effect: operation.consequence,
      resource: context.resource,
      authority: "governedConfirm.authority.consoleSession",
      duration:
        id === "auth.session.revoke" ? "" : "governedConfirm.duration.untilRevoked",
      risk: "destructive",
    },
    locale,
  );
  const group: any = consoleMessages[locale]?.destructive || consoleMessages.en.destructive;
  return requestConsoleConfirm({
    title: payload.title,
    message: payload.body,
    // The dialog renders only neutral|danger; warning is an audit-level tone,
    // so the registry keeps its own mapping (the payload builder escalates on
    // the destructive risk fact; danger entries stay danger here).
    tone: operation.tone === "danger" ? "danger" : "neutral",
    confirmLabel: payload.confirmLabel,
    cancelLabel: group.cancelLabel,
    requireText: operation.requireText,
  });
}
