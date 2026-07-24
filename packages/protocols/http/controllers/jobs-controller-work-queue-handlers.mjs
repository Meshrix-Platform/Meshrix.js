import { sendJson } from "#meshrix/http-utils";
import { authSubjectFromSession } from "./jobs-controller-access.mjs";

function parseJsonRequestBody(requestBody) {
  return requestBody.length > 0 ? JSON.parse(requestBody.toString("utf8")) : {};
}

function sendWorkQueueUnavailable(response) {
  sendJson(response, 409, { ok: false, error: "work queue provider is not available." });
}

function requireWorkQueueAdmin(authSession, response) {
  const subject = authSubjectFromSession(authSession);
  const scopes = new Set(subject.scopes || []);
  if (
    subject.roleId === "owner" ||
    scopes.has("runtime:admin") ||
    scopes.has("maintenance:admin") ||
    scopes.has("auth:admin")
  ) {
    return true;
  }
  sendJson(response, 403, {
    ok: false,
    error: {
      code: "work_queue_admin_required",
      message: "Global work queue control requires maintenance:admin."
    }
  });
  return false;
}

export function createWorkQueueHandlers({ jobWorkflow }) {
  return {
    async handleInspectWorkQueue({ limit, response }) {
      if (typeof jobWorkflow.inspectWorkQueue !== "function") {
        sendJson(response, 200, {
          ok: true,
          enabled: false,
          reason: "work_queue_provider_unavailable"
        });
        return;
      }
      const inspected = await jobWorkflow.inspectWorkQueue({ limit: Number(limit || 100) });
      const description = typeof jobWorkflow.describe === "function" ? jobWorkflow.describe() : {};
      sendJson(response, 200, {
        ok: true,
        enabled: true,
        description,
        ...inspected
      });
    },

    async handlePauseWorkQueue({ requestBody, response, authSession }) {
      if (!requireWorkQueueAdmin(authSession, response)) return;
      const payload = parseJsonRequestBody(requestBody);
      if (typeof jobWorkflow.pauseWorkQueue !== "function") {
        sendWorkQueueUnavailable(response);
        return;
      }
      sendJson(response, 200, await jobWorkflow.pauseWorkQueue({
        reason: payload.reason || "operator_pause",
        actor: payload.actor || { source: "jobs-controller" }
      }));
    },

    async handleResumeWorkQueue({ requestBody, response, authSession }) {
      if (!requireWorkQueueAdmin(authSession, response)) return;
      const payload = parseJsonRequestBody(requestBody);
      if (typeof jobWorkflow.resumeWorkQueue !== "function") {
        sendWorkQueueUnavailable(response);
        return;
      }
      sendJson(response, 200, await jobWorkflow.resumeWorkQueue({
        reason: payload.reason || "operator_resume",
        actor: payload.actor || { source: "jobs-controller" }
      }));
    },

    async handleDrainWorkQueue({ requestBody, response, authSession }) {
      if (!requireWorkQueueAdmin(authSession, response)) return;
      const payload = parseJsonRequestBody(requestBody);
      if (typeof jobWorkflow.drainWorkQueue !== "function") {
        sendWorkQueueUnavailable(response);
        return;
      }
      sendJson(response, 200, await jobWorkflow.drainWorkQueue({
        reason: payload.reason || "operator_drain",
        actor: payload.actor || { source: "jobs-controller" }
      }));
    },

    async handleRecoverFailedWorkQueue({ requestBody, response, authSession }) {
      if (!requireWorkQueueAdmin(authSession, response)) return;
      const payload = parseJsonRequestBody(requestBody);
      if (typeof jobWorkflow.recoverFailedWorkQueue !== "function") {
        sendWorkQueueUnavailable(response);
        return;
      }
      sendJson(response, 200, await jobWorkflow.recoverFailedWorkQueue({
        limit: payload.limit || 100,
        workItemId: payload.workItemId || payload.itemId || "",
        reason: payload.reason || "operator_recover_failed",
        actor: payload.actor || { source: "jobs-controller" }
      }));
    },

    async handleRebuildWorkQueue({ requestBody, response, authSession }) {
      if (!requireWorkQueueAdmin(authSession, response)) return;
      const payload = parseJsonRequestBody(requestBody);
      if (typeof jobWorkflow.rebuildWorkQueueProof !== "function") {
        sendWorkQueueUnavailable(response);
        return;
      }
      sendJson(response, 200, await jobWorkflow.rebuildWorkQueueProof({
        reason: payload.reason || "operator_rebuild_projection",
        actor: payload.actor || { source: "jobs-controller" }
      }));
    }
  };
}
