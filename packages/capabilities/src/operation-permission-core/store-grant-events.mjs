import {
  nowIso,
  parseJson,
  randomId,
  sanitizeGrantMetadata,
  stringifyJson
} from "./store-utils.mjs";

function rowToGrantEvent(row = {}) {
  return {
    eventId: String(row.event_id || ""),
    grantId: String(row.grant_id || ""),
    eventType: String(row.event_type || ""),
    details: sanitizeGrantMetadata(parseJson(row.details_json, {})),
    createdAt: String(row.created_at || "")
  };
}

export function createGrantEventStore({ db }) {
  const appendGrantEventStmt = db.prepare(`
    INSERT INTO tool_grant_events (event_id, grant_id, event_type, details_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  function appendGrantEvent(grantId, eventType, details = {}) {
    appendGrantEventStmt.run(
      randomId("grant_event"),
      String(grantId || ""),
      String(eventType || ""),
      stringifyJson(details),
      nowIso()
    );
  }

  function listGrantEvents({ limit = 100, grantId = "", eventType = "" } = {}) {
    const clauses = [];
    const params = [];
    const normalizedGrantId = String(grantId || "").trim();
    const normalizedEventType = String(eventType || "").trim();
    if (normalizedGrantId) {
      clauses.push("grant_id = ?");
      params.push(normalizedGrantId);
    }
    if (normalizedEventType) {
      clauses.push("event_type = ?");
      params.push(normalizedEventType);
    }
    const clampedLimit = Math.max(1, Math.min(Number(limit || 100), 500));
    params.push(clampedLimit);
    const rows = db.prepare(`
      SELECT event_id, grant_id, event_type, details_json, created_at
      FROM tool_grant_events
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY created_at DESC, event_id DESC
      LIMIT ?
    `).all(...params);
    return rows.map(rowToGrantEvent);
  }

  return {
    appendGrantEvent,
    listGrantEvents
  };
}
