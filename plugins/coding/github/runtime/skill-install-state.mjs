import crypto from "node:crypto";

import { codingGithubError, plainObject } from "./contracts.mjs";
import { stableExternalRequestDigest } from "./external-service-client.mjs";

const STATE_PATH = "coding-github/skill-installs.json";
const STATE_SCHEMA = "v0.0.1:coding-github:skill-install-state-1";
const MAX_INSTALL_RECORDS = 128;

function digestRef(value) {
  return `sha256:${crypto.createHash("sha256").update(String(value)).digest("hex")}`;
}

function emptyState() {
  return { schemaVersion: STATE_SCHEMA, revision: 0, installs: {} };
}

function normalizePersistedState(value) {
  if (!plainObject(value) || value.schemaVersion !== STATE_SCHEMA || !Number.isSafeInteger(value.revision) || value.revision < 0 || !plainObject(value.installs)) {
    throw codingGithubError("coding_github_plugin_data_invalid", 503);
  }
  const installs = {};
  const entries = Object.entries(value.installs);
  if (entries.length > MAX_INSTALL_RECORDS) throw codingGithubError("coding_github_plugin_data_invalid", 503);
  for (const [installRef, record] of entries) {
    if (!/^sha256:[a-f0-9]{64}$/u.test(installRef) || !plainObject(record) ||
        !/^sha256:[a-f0-9]{64}$/u.test(String(record.planRef || "")) ||
        !["installed", "rolled_back"].includes(record.status) ||
        !Number.isSafeInteger(record.revision) || record.revision < 1) {
      throw codingGithubError("coding_github_plugin_data_invalid", 503);
    }
    installs[installRef] = Object.freeze({
      planRef: record.planRef,
      status: record.status,
      revision: record.revision,
      receiptDigest: /^sha256:[a-f0-9]{64}$/u.test(String(record.receiptDigest || ""))
        ? record.receiptDigest
        : digestRef("receipt-absent")
    });
  }
  return { schemaVersion: STATE_SCHEMA, revision: value.revision, installs };
}

function sourceFields(input = {}) {
  return Object.freeze({
    owner: String(input.owner || ""),
    repo: String(input.repo || ""),
    ref: String(input.ref || ""),
    path: String(input.path || "")
  });
}

export function skillInstallPlanRef(input = {}) {
  return digestRef(`skill-install-plan\0${stableExternalRequestDigest(sourceFields(input))}`);
}

export function createSkillInstallState({ pluginData }) {
  if (!pluginData || typeof pluginData.readFile !== "function" || typeof pluginData.writeFile !== "function") {
    throw new TypeError("Coding GitHub requires an opaque plugin data capability.");
  }
  let loaded = null;
  let tail = Promise.resolve();
  let accepting = true;

  async function load() {
    if (loaded) return loaded;
    try {
      loaded = normalizePersistedState(JSON.parse(await pluginData.readFile(STATE_PATH, "utf8")));
    } catch (error) {
      if (error?.code !== "PLUGIN_DATA_NOT_FOUND") throw error;
      loaded = emptyState();
    }
    return loaded;
  }

  function schedule(mutation) {
    if (!accepting) return Promise.reject(codingGithubError("coding_github_runtime_closed", 503));
    const task = tail.then(async () => {
      const current = await load();
      const next = mutation(current);
      await pluginData.writeFile(STATE_PATH, `${JSON.stringify(next)}\n`, "utf8");
      loaded = next;
      return next;
    });
    tail = task.catch(() => {});
    return task;
  }

  function recordInstall({ input, response }) {
    const planRef = skillInstallPlanRef(input);
    if (input.planRef !== planRef) throw codingGithubError("coding_github_skill_install_plan_stale", 409);
    const installRef = digestRef(`skill-install\0${planRef}\0${stableExternalRequestDigest(input.idempotencyKey)}`);
    const receiptDigest = digestRef(response.receiptRef || stableExternalRequestDigest(response.data));
    return schedule((current) => {
      const existing = current.installs[installRef];
      if (existing) {
        if (existing.planRef !== planRef || existing.status !== "installed") {
          throw codingGithubError("coding_github_skill_install_conflict", 409);
        }
        return current;
      }
      const revision = current.revision + 1;
      const installs = { ...current.installs };
      installs[installRef] = Object.freeze({ planRef, status: "installed", revision, receiptDigest });
      const ordered = Object.entries(installs).sort((left, right) => left[1].revision - right[1].revision);
      while (ordered.length > MAX_INSTALL_RECORDS) {
        const [removedRef] = ordered.shift();
        delete installs[removedRef];
      }
      return { schemaVersion: STATE_SCHEMA, revision, installs };
    }).then(() => Object.freeze({ planRef, installRef, status: "installed" }));
  }

  function recordRollback({ input, response }) {
    const installRef = String(input.installRef || "");
    const receiptDigest = digestRef(response.receiptRef || stableExternalRequestDigest(response.data));
    return schedule((current) => {
      const existing = current.installs[installRef];
      if (!existing) throw codingGithubError("coding_github_skill_install_not_found", 404);
      if (existing.status === "rolled_back") return current;
      const revision = current.revision + 1;
      return {
        schemaVersion: STATE_SCHEMA,
        revision,
        installs: {
          ...current.installs,
          [installRef]: Object.freeze({
            planRef: existing.planRef,
            status: "rolled_back",
            revision,
            receiptDigest
          })
        }
      };
    }).then((state) => Object.freeze({
      planRef: state.installs[installRef].planRef,
      installRef,
      status: state.installs[installRef].status
    }));
  }

  return Object.freeze({
    plan(input) {
      return Object.freeze({ planRef: skillInstallPlanRef(input), status: "planned" });
    },
    assertPlan(input) {
      if (String(input.planRef || "") !== skillInstallPlanRef(input)) {
        throw codingGithubError("coding_github_skill_install_plan_stale", 409);
      }
    },
    async assertRollbackable(input) {
      const installRef = String(input.installRef || "");
      const current = await load();
      const record = current.installs[installRef];
      if (!record) throw codingGithubError("coding_github_skill_install_not_found", 404);
      if (record.planRef !== skillInstallPlanRef(input)) {
        throw codingGithubError("coding_github_skill_install_plan_stale", 409);
      }
    },
    recordInstall,
    recordRollback,
    async close() {
      const alreadyClosed = !accepting;
      accepting = false;
      await tail;
      return Object.freeze({ ok: true, alreadyClosed });
    }
  });
}
