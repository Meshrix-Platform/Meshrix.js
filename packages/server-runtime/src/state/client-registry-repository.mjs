import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "@lico/foundation/storage/sqlite-database";

export const MAX_LICO_CLIENT_REGISTRATIONS = 2000;
// Internal capacity safety policy; it does not populate user discovery configuration.
export const DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS = 15 * 60;

function asBoolInt(value) {
  return value ? 1 : 0;
}

export function getClientRegistryDatabasePath(userDataPath) {
  return path.join(userDataPath, "client-state", "client-registry.sqlite");
}

export function initializeClientRegistrySchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS client_registrations (
      client_id TEXT PRIMARY KEY,
      client_label TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      platform TEXT NOT NULL DEFAULT '',
      hostname TEXT NOT NULL DEFAULT '',
      bootstrap_url TEXT NOT NULL DEFAULT '',
      current_service_url TEXT NOT NULL DEFAULT '',
      desired_service_url TEXT NOT NULL DEFAULT '',
      current_job_service_url TEXT NOT NULL DEFAULT '',
      config_version TEXT NOT NULL DEFAULT '',
      alignment_state TEXT NOT NULL DEFAULT 'unknown',
      last_error TEXT NOT NULL DEFAULT '',
      busy INTEGER NOT NULL DEFAULT 0,
      last_job_id TEXT NOT NULL DEFAULT '',
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      last_seen_server_id TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_client_registrations_seen
      ON client_registrations(last_seen_at DESC);
    CREATE INDEX IF NOT EXISTS idx_client_registrations_state
      ON client_registrations(alignment_state, last_seen_at DESC);
  `);
}

function openClientRegistryDatabase(userDataPath) {
  const databasePath = getClientRegistryDatabasePath(userDataPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  let db = null;
  try {
    db = openSqliteDatabase(databasePath);
    initializeClientRegistrySchema(db);
    return db;
  } catch (error) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while still attempting local cleanup.
    }
    throw error;
  }
}

function normalizeClientAlignmentState(
  currentState,
  lastSeenAt,
  offlineAfterSeconds,
  observedAtMs = Date.now()
) {
  const currentServiceUrl = String(currentState?.currentServiceUrl || "").trim();
  const desiredServiceUrl = String(currentState?.desiredServiceUrl || "").trim();
  const currentJobServiceUrl = String(currentState?.currentJobServiceUrl || "").trim();
  const ageSeconds = Math.max(
    0,
    Math.floor((observedAtMs - new Date(lastSeenAt || 0).getTime()) / 1000)
  );

  if (!lastSeenAt || !Number.isFinite(ageSeconds)) {
    return "unknown";
  }

  const offlineThreshold = Number(offlineAfterSeconds || 0);
  if (offlineThreshold > 0 && ageSeconds > offlineThreshold) {
    return "offline";
  }

  if (currentJobServiceUrl && currentJobServiceUrl !== desiredServiceUrl) {
    return "draining";
  }

  if (currentServiceUrl && desiredServiceUrl && currentServiceUrl === desiredServiceUrl) {
    return "aligned";
  }

  if (currentServiceUrl && desiredServiceUrl && currentServiceUrl !== desiredServiceUrl) {
    return "outdated";
  }

  if (desiredServiceUrl) {
    return "bootstrap-only";
  }

  return "unknown";
}

function prepareClientRegistryStatements(database) {
  return {
    selectClientRegistrationStmt: database.prepare(`
      SELECT * FROM client_registrations WHERE client_id = ?
    `),
    countClientRegistrationsStmt: database.prepare(`
      SELECT COUNT(*) AS count FROM client_registrations
    `),
    pruneExpiredClientRegistrationsStmt: database.prepare(`
      DELETE FROM client_registrations
      WHERE last_seen_at < ?
    `),
    upsertClientRegistrationStmt: database.prepare(`
      INSERT INTO client_registrations (
        client_id, client_label, app_version, platform, hostname, bootstrap_url,
        current_service_url, desired_service_url, current_job_service_url, config_version,
        alignment_state, last_error, busy, last_job_id, first_seen_at, last_seen_at,
        last_seen_server_id, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        client_label = excluded.client_label,
        app_version = excluded.app_version,
        platform = excluded.platform,
        hostname = excluded.hostname,
        bootstrap_url = excluded.bootstrap_url,
        current_service_url = excluded.current_service_url,
        desired_service_url = excluded.desired_service_url,
        current_job_service_url = excluded.current_job_service_url,
        config_version = excluded.config_version,
        alignment_state = excluded.alignment_state,
        last_error = excluded.last_error,
        busy = excluded.busy,
        last_job_id = excluded.last_job_id,
        last_seen_at = excluded.last_seen_at,
        last_seen_server_id = excluded.last_seen_server_id,
        updated_at = excluded.updated_at
    `),
    listClientRegistrationsStmt: database.prepare(`
      SELECT * FROM client_registrations
      ORDER BY last_seen_at DESC, client_id ASC
    `)
  };
}

export function createClientRegistryService({
  userDataPath = "",
  db = null,
  maxClientRegistrations = MAX_LICO_CLIENT_REGISTRATIONS,
  registrationRetentionSeconds = DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS,
  now = Date.now
} = {}) {
  const database = db || openClientRegistryDatabase(userDataPath);
  const ownsDatabase = !db;
  const maxRegistrations = Math.max(
    1,
    Math.floor(Number(maxClientRegistrations || MAX_LICO_CLIENT_REGISTRATIONS) || MAX_LICO_CLIENT_REGISTRATIONS)
  );
  const defaultRetentionSeconds = Math.max(
    1,
    Math.floor(
      Number(
        registrationRetentionSeconds || DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS
      ) || DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS
    )
  );
  const currentTimeMs = () => {
    const value = Number(typeof now === "function" ? now() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  };
  let statements;
  try {
    statements = prepareClientRegistryStatements(database);
  } catch (error) {
    if (ownsDatabase) {
      try {
        database.close();
      } catch {
        // Preserve the statement initialization failure.
      }
    }
    throw error;
  }
  const {
    selectClientRegistrationStmt,
    countClientRegistrationsStmt,
    pruneExpiredClientRegistrationsStmt,
    upsertClientRegistrationStmt,
    listClientRegistrationsStmt
  } = statements;

  return {
    recordClientCheckIn({
      clientId,
      clientLabel = "",
      appVersion = "",
      platform = "",
      hostname = "",
      bootstrapUrl = "",
      currentServiceUrl = "",
      desiredServiceUrl = "",
      currentJobServiceUrl = "",
      configVersion = "",
      busy = false,
      lastJobId = "",
      lastError = "",
      serverId = "",
      offlineAfterSeconds = 0
    }) {
      const existing = selectClientRegistrationStmt.get(clientId);
      const checkedInAtMs = currentTimeMs();
      const checkedInAt = new Date(checkedInAtMs).toISOString();
      const firstSeenAt = existing?.first_seen_at || checkedInAt;
      if (!existing) {
        const offlineThreshold = Number(offlineAfterSeconds || 0);
        let count = Number(countClientRegistrationsStmt.get()?.count || 0);
        if (count >= maxRegistrations) {
          const expirationSeconds = Number.isFinite(offlineThreshold) && offlineThreshold > 0
            ? offlineThreshold
            : defaultRetentionSeconds;
          const expiredCutoff = new Date(
            checkedInAtMs - expirationSeconds * 1000
          ).toISOString();
          pruneExpiredClientRegistrationsStmt.run(expiredCutoff);
          count = Number(countClientRegistrationsStmt.get()?.count || 0);
        }
        if (count >= maxRegistrations) {
          return {
            ok: false,
            statusCode: 429,
            code: "client_registration_capacity_exceeded",
            error: "客户端登记容量已满，请等待离线记录过期后重试。"
          };
        }
      }
      const alignmentState = normalizeClientAlignmentState(
        {
          currentServiceUrl,
          desiredServiceUrl,
          currentJobServiceUrl
        },
        checkedInAt,
        offlineAfterSeconds,
        checkedInAtMs
      );

      upsertClientRegistrationStmt.run(
        clientId,
        String(clientLabel || hostname || clientId),
        String(appVersion || ""),
        String(platform || ""),
        String(hostname || ""),
        String(bootstrapUrl || ""),
        String(currentServiceUrl || ""),
        String(desiredServiceUrl || ""),
        String(currentJobServiceUrl || ""),
        String(configVersion || ""),
        alignmentState,
        String(lastError || ""),
        asBoolInt(busy),
        String(lastJobId || ""),
        firstSeenAt,
        checkedInAt,
        String(serverId || ""),
        checkedInAt
      );

      return {
        ok: true,
        clientId,
        alignmentState,
        connectionKind: "lico-client",
        connectionMethod: "lico-client 封装",
        connectionState: alignmentState === "offline"
          ? "offline"
          : alignmentState === "unknown"
            ? "unknown"
            : "active",
        connectionStatusLabel: "",
        supportsAlignment: true,
        firstSeenAt,
        lastSeenAt: checkedInAt
      };
    },
    listClientRegistrations({ offlineAfterSeconds = 0 } = {}) {
      const observedAtMs = currentTimeMs();
      const items = listClientRegistrationsStmt.all().map((row) => {
        const alignmentState = normalizeClientAlignmentState(
          {
            currentServiceUrl: row.current_service_url,
            desiredServiceUrl: row.desired_service_url,
            currentJobServiceUrl: row.current_job_service_url
          },
          row.last_seen_at,
          offlineAfterSeconds,
          observedAtMs
        );

        return {
          clientId: row.client_id,
          clientLabel: row.client_label || row.hostname || row.client_id,
          appVersion: row.app_version || "",
          platform: row.platform || "",
          hostname: row.hostname || "",
          bootstrapUrl: row.bootstrap_url || "",
          currentServiceUrl: row.current_service_url || "",
          desiredServiceUrl: row.desired_service_url || "",
          currentJobServiceUrl: row.current_job_service_url || "",
          configVersion: row.config_version || "",
          alignmentState,
          connectionKind: "lico-client",
          connectionMethod: "lico-client 封装",
          connectionState: alignmentState === "offline"
            ? "offline"
            : alignmentState === "unknown"
              ? "unknown"
              : "active",
          connectionStatusLabel: "",
          supportsAlignment: true,
          busy: Boolean(row.busy),
          lastJobId: row.last_job_id || "",
          lastError: row.last_error || "",
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          lastSeenServerId: row.last_seen_server_id || ""
        };
      });

      const summary = {
        totalCount: items.length,
        alignedCount: items.filter((item) => item.alignmentState === "aligned").length,
        outdatedCount: items.filter((item) => item.alignmentState === "outdated").length,
        drainingCount: items.filter((item) => item.alignmentState === "draining").length,
        bootstrapOnlyCount: items.filter((item) => item.alignmentState === "bootstrap-only")
          .length,
        offlineCount: items.filter((item) => item.alignmentState === "offline").length,
        unknownCount: items.filter((item) => item.alignmentState === "unknown").length,
        licoClientCount: items.length,
        mcpPluginCount: 0,
        alignableCount: items.length
      };

      return {
        summary,
        items
      };
    },
    findClientRegistration({ clientId = "", offlineAfterSeconds = 0 } = {}) {
      const selectedClientId = String(clientId || "").trim();
      if (!selectedClientId) {
        return null;
      }
      return this.listClientRegistrations({ offlineAfterSeconds })
        .items.find((item) => item.clientId === selectedClientId) || null;
    },
    close() {
      if (ownsDatabase) {
        database.close();
      }
    }
  };
}
