const REGISTRY_DATABASE_VERSION = 1;
const IMPORT_COMPLETE_KEY = "json_import_complete";

export function registryDatabaseResource(registryRelativePath) {
  if (!String(registryRelativePath || "").endsWith(".json")) {
    throw new TypeError("Skill Hub registry persistence requires a JSON registry source path.");
  }
  return `${registryRelativePath.slice(0, -5)}.sqlite`;
}

export function legacyRegistryArchiveResource(registryRelativePath) {
  if (!String(registryRelativePath || "").endsWith(".json")) {
    throw new TypeError("Skill Hub legacy registry archive requires a JSON registry source path.");
  }
  return `${registryRelativePath.slice(0, -5)}.legacy.json`;
}

function registryDatabaseMissingError() {
  return Object.assign(new Error("The imported Skill Hub registry database is missing; restore it from backup."), {
    code: "skill_hub_registry_database_missing"
  });
}

function registryImportRecoveryError() {
  return Object.assign(new Error("The Skill Hub registry import is incomplete and its active JSON source is missing."), {
    code: "skill_hub_registry_import_incomplete"
  });
}

async function resourceExists(serviceData, resource) {
  try {
    await serviceData.stat(resource);
    return true;
  } catch (error) {
    if (error?.code === "SERVICE_DATA_NOT_FOUND") return false;
    throw error;
  }
}

function stateObject(value = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function sourceAuditEvents(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null || value === "" ? [] : [value];
}

function sourceState(value = {}) {
  const state = stateObject(value);
  const rawContributions = stateObject(state.contributions);
  const contributions = new Map();
  for (const contribution of Object.values(rawContributions)) {
    if (contribution && typeof contribution === "object" && !Array.isArray(contribution) &&
        typeof contribution.contributionId === "string" && contribution.contributionId) {
      contributions.set(contribution.contributionId, contribution);
    }
  }
  return {
    updatedAt: typeof state.updatedAt === "string" ? state.updatedAt : "",
    contributions: [...contributions.values()],
    auditEvents: sourceAuditEvents(state.auditEvents)
  };
}

function databaseError(primary, rollback) {
  return new AggregateError([primary, rollback], "Skill Hub registry transaction failed and rollback did not complete.");
}

export async function createSkillHubRegistryPersistence({ serviceData, registryRelativePath } = {}) {
  if (!serviceData || typeof serviceData.openDatabase !== "function" ||
      typeof serviceData.readFile !== "function" || typeof serviceData.stat !== "function" ||
      typeof serviceData.relocateFile !== "function") {
    throw new TypeError("Skill Hub registry persistence requires service data capabilities.");
  }
  const databaseResource = registryDatabaseResource(registryRelativePath);
  const archiveResource = legacyRegistryArchiveResource(registryRelativePath);
  const databaseExists = await resourceExists(serviceData, databaseResource);
  if (!databaseExists) {
    const activeSourceExists = await resourceExists(serviceData, registryRelativePath);
    if (!activeSourceExists && await resourceExists(serviceData, archiveResource)) {
      throw registryDatabaseMissingError();
    }
  }

  const database = await serviceData.openDatabase(databaseResource);
  try {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS registry_metadata (
        key TEXT PRIMARY KEY NOT NULL,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contributions (
        contribution_id TEXT PRIMARY KEY NOT NULL,
        body TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        body TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS audit_events_by_type ON audit_events(event_type);
    `);
    const version = Number(database.prepare("PRAGMA user_version").get()?.user_version || 0);
    if (version > REGISTRY_DATABASE_VERSION) {
      throw Object.assign(new Error("Skill Hub registry database version is newer than this service."), {
        code: "skill_hub_registry_database_version_unsupported"
      });
    }
    if (version === 0) database.exec(`PRAGMA user_version = ${REGISTRY_DATABASE_VERSION};`);
    database.exec("COMMIT;");

    const importMarker = database.prepare("SELECT value FROM registry_metadata WHERE key = ?");
    if (importMarker.get(IMPORT_COMPLETE_KEY)?.value !== "1") {
      const activeSourceExists = await resourceExists(serviceData, registryRelativePath);
      if (!activeSourceExists && await resourceExists(serviceData, archiveResource)) {
        throw registryImportRecoveryError();
      }
      let legacyState;
      try {
        legacyState = JSON.parse(await serviceData.readFile(registryRelativePath, "utf8"));
      } catch (error) {
        if (error?.code !== "SERVICE_DATA_NOT_FOUND") throw error;
      }
      const imported = sourceState(legacyState || {});
      const insertContribution = database.prepare(
        "INSERT INTO contributions (contribution_id, body) VALUES (?, ?) ON CONFLICT(contribution_id) DO UPDATE SET body = excluded.body"
      );
      const insertAudit = database.prepare("INSERT INTO audit_events (event_type, body) VALUES (?, ?)");
      const setMetadata = database.prepare(
        "INSERT INTO registry_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      );
      database.exec("BEGIN IMMEDIATE;");
      try {
        if (importMarker.get(IMPORT_COMPLETE_KEY)?.value !== "1") {
          for (const contribution of imported.contributions) {
            insertContribution.run(contribution.contributionId, JSON.stringify(contribution));
          }
          for (const event of imported.auditEvents) {
            insertAudit.run(String(event?.eventType || "unknown"), JSON.stringify(event));
          }
          setMetadata.run(IMPORT_COMPLETE_KEY, "1");
          setMetadata.run("updated_at", imported.updatedAt || new Date().toISOString());
        }
        database.exec("COMMIT;");
      } catch (error) {
        if (!database.isTransaction) throw error;
        try {
          database.exec("ROLLBACK;");
        } catch (rollbackError) {
          throw databaseError(error, rollbackError);
        }
        throw error;
      }
    }

    // The commit marker is authoritative. If a process stopped after the
    // import transaction, finish the same-directory archive move without ever
    // consulting the JSON source again.
    await serviceData.relocateFile(registryRelativePath, archiveResource);

    const contributions = Object.create(null);
    for (const row of database.prepare("SELECT contribution_id, body FROM contributions ORDER BY contribution_id").iterate()) {
      contributions[row.contribution_id] = JSON.parse(row.body);
    }
    const updatedAt = importMarker.get("updated_at")?.value || new Date().toISOString();
    const insertContribution = database.prepare(
      "INSERT INTO contributions (contribution_id, body) VALUES (?, ?) ON CONFLICT(contribution_id) DO UPDATE SET body = excluded.body"
    );
    const insertAudit = database.prepare("INSERT INTO audit_events (event_type, body) VALUES (?, ?)");
    const setMetadata = database.prepare(
      "INSERT INTO registry_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );

    function commitMutation({ contribution, auditEvents = [] } = {}) {
      if (!contribution && !auditEvents.length) return;
      database.exec("BEGIN IMMEDIATE;");
      try {
        if (contribution) insertContribution.run(contribution.contributionId, JSON.stringify(contribution));
        for (const event of auditEvents) {
          insertAudit.run(String(event?.eventType || "unknown"), JSON.stringify(event));
        }
        setMetadata.run("updated_at", new Date().toISOString());
        database.exec("COMMIT;");
      } catch (error) {
        if (!database.isTransaction) throw error;
        try {
          database.exec("ROLLBACK;");
        } catch (rollbackError) {
          throw databaseError(error, rollbackError);
        }
        throw error;
      }
    }

    function listAuditEvents() {
      const events = [];
      for (const row of database.prepare("SELECT body FROM audit_events ORDER BY sequence").iterate()) {
        events.push(JSON.parse(row.body));
      }
      return events;
    }

    function getAuditSummary() {
      const byType = Object.create(null);
      let count = 0;
      for (const row of database.prepare(
        "SELECT event_type, COUNT(*) AS event_count FROM audit_events GROUP BY event_type"
      ).iterate()) {
        const eventType = String(row.event_type || "unknown");
        const eventCount = Number(row.event_count || 0);
        byType[eventType] = eventCount;
        count += eventCount;
      }
      return { count, byType };
    }

    return Object.freeze({
      initialPersistedState: Object.freeze({
        schemaVersion: "v0.0.1:schema:definition-1",
        updatedAt,
        contributions,
        auditEvents: []
      }),
      commitMutation,
      listAuditEvents,
      getAuditSummary,
      close() {
        database.close();
      }
    });
  } catch (error) {
    if (database.isOpen) database.close();
    throw error;
  }
}
