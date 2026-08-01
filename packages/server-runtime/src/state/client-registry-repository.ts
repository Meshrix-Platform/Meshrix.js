import fs from "node:fs";
import path from "node:path";
import { openSqliteDatabase } from "@meshrix/foundation/storage/sqlite-database";

export const MAX_MESHRIX_CLIENT_REGISTRATIONS: any = 2000;
// Internal capacity safety policy; it does not populate user discovery configuration.
export const DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS: any = 15 * 60;

function asBoolInt(value?: any) : any {
  return value ? 1 : 0;
}

export function getClientRegistryDatabasePath(userDataPath?: any) : any {
  return path.join(userDataPath, "client-state", "client-registry.sqlite");
}

export function initializeClientRegistrySchema(db?: any) : any {
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

function openClientRegistryDatabase(userDataPath?: any) : any {
  const databasePath: any = getClientRegistryDatabasePath(userDataPath);
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  let db: any = null;
  try {
    db = openSqliteDatabase(databasePath);
    initializeClientRegistrySchema(db);
    return db;
  } catch (error: any) {
    try {
      db?.close?.();
    } catch {
      // Preserve the initialization failure while still attempting local cleanup.
    }
    throw error;
  }
}

function normalizeClientAlignmentState(
  currentState?: any,
  lastSeenAt?: any,
  offlineAfterSeconds?: any,
  observedAtMs: any = Date.now()
) : any {
  const currentServiceUrl: any = String(currentState?.currentServiceUrl || "").trim();
  const desiredServiceUrl: any = String(currentState?.desiredServiceUrl || "").trim();
  const currentJobServiceUrl: any = String(currentState?.currentJobServiceUrl || "").trim();
  const ageSeconds: any = Math.max(
    0,
    Math.floor((observedAtMs - new Date(lastSeenAt || 0).getTime()) / 1000)
  );

  if (!lastSeenAt || !Number.isFinite(ageSeconds)) {
    return "unknown";
  }

  const offlineThreshold: any = Number(offlineAfterSeconds || 0);
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

function prepareClientRegistryStatements(database?: any) : any {
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
  maxClientRegistrations = MAX_MESHRIX_CLIENT_REGISTRATIONS,
  registrationRetentionSeconds = DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS,
  now = Date.now
}: Record<string, any> = {}) : any {
  const database: any = db || openClientRegistryDatabase(userDataPath);
  const ownsDatabase: any = !db;
  const maxRegistrations: any = Math.max(
    1,
    Math.floor(Number(maxClientRegistrations || MAX_MESHRIX_CLIENT_REGISTRATIONS) || MAX_MESHRIX_CLIENT_REGISTRATIONS)
  );
  const defaultRetentionSeconds: any = Math.max(
    1,
    Math.floor(
      Number(
        registrationRetentionSeconds || DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS
      ) || DEFAULT_CLIENT_REGISTRATION_RETENTION_SECONDS
    )
  );
  const currentTimeMs: any = () : any => {
    const value: any = Number(typeof now === "function" ? now() : Date.now());
    return Number.isFinite(value) ? value : Date.now();
  };
  let statements: any;
  try {
    statements = prepareClientRegistryStatements(database);
  } catch (error: any) {
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
    }: Record<string, any>) : any {
      const existing: any = selectClientRegistrationStmt.get(clientId);
      const checkedInAtMs: any = currentTimeMs();
      const checkedInAt: any = new Date(checkedInAtMs).toISOString();
      const firstSeenAt: any = existing?.first_seen_at || checkedInAt;
      if (!existing) {
        const offlineThreshold: any = Number(offlineAfterSeconds || 0);
        let count: any = Number(countClientRegistrationsStmt.get()?.count || 0);
        if (count >= maxRegistrations) {
          const expirationSeconds: any = Number.isFinite(offlineThreshold) && offlineThreshold > 0
            ? offlineThreshold
            : defaultRetentionSeconds;
          const expiredCutoff: any = new Date(
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
      const alignmentState: any = normalizeClientAlignmentState(
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
        connectionKind: "meshrix-client",
        connectionMethod: "meshrix-client 封装",
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
    listClientRegistrations({ offlineAfterSeconds = 0 }: Record<string, any> = {}) : any {
      const observedAtMs: any = currentTimeMs();
      const items: any = listClientRegistrationsStmt.all().map((row?: any) : any => {
        const alignmentState: any = normalizeClientAlignmentState(
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
          connectionKind: "meshrix-client",
          connectionMethod: "meshrix-client 封装",
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

      const summary: Record<string, any> = {
        totalCount: items.length,
        alignedCount: items.filter((item?: any) : any => item.alignmentState === "aligned").length,
        outdatedCount: items.filter((item?: any) : any => item.alignmentState === "outdated").length,
        drainingCount: items.filter((item?: any) : any => item.alignmentState === "draining").length,
        bootstrapOnlyCount: items.filter((item?: any) : any => item.alignmentState === "bootstrap-only")
          .length,
        offlineCount: items.filter((item?: any) : any => item.alignmentState === "offline").length,
        unknownCount: items.filter((item?: any) : any => item.alignmentState === "unknown").length,
        meshrixClientCount: items.length,
        mcpPluginCount: 0,
        alignableCount: items.length
      };

      return {
        summary,
        items
      };
    },
    findClientRegistration({ clientId = "", offlineAfterSeconds = 0 }: Record<string, any> = {}) : any {
      const selectedClientId: any = String(clientId || "").trim();
      if (!selectedClientId) {
        return null;
      }
      return this.listClientRegistrations({ offlineAfterSeconds })
        .items.find((item?: any) : any => item.clientId === selectedClientId) || null;
    },
    close() : any {
      if (ownsDatabase) {
        database.close();
      }
    }
  };
}
