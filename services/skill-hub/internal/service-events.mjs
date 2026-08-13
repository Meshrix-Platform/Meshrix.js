const EVENT_RESOURCE = "SkillHub/events.json";
const EVENT_SCHEMA = "v0.0.1:skill-hub:event-1";
const JOURNAL_SCHEMA = "v0.0.1:skill-hub:event-journal-1";
const MAX_EVENTS = 256;
const MAX_SUBSCRIBERS = 32;

const MUTATING_OPERATIONS = new Set([
  "skill_hub.submit",
  "skill_hub.scan",
  "skill_hub.build",
  "skill_hub.execute",
  "skill_hub.execution.cancel",
  "skill_hub.review",
  "skill_hub.publish",
  "skill_hub.install",
  "skill_hub.adopt",
  "skill_hub.usage.record",
  "skill_hub.revoke",
  "skill_hub.rollback.record",
  "skill_hub.permission.request",
  "skill_hub.permission.grant"
]);

export function isSkillHubMutation(operationId, input = {}) {
  const normalized = String(operationId || "");
  const phase = String(input?.__meshrix?.phase || "execute");
  if (["skill_hub.scan", "skill_hub.build", "skill_hub.execute"].includes(normalized)) return phase === "commit";
  if (normalized === "skill_hub.permission.grant" && phase === "prepare") return false;
  return MUTATING_OPERATIONS.has(normalized);
}

export async function createSkillHubEventJournal({ serviceData }) {
  let revision = 0;
  let events = [];
  let closed = false;
  let writeTail = Promise.resolve();
  const subscribers = new Set();
  try {
    const stored = JSON.parse(await serviceData.readFile(EVENT_RESOURCE));
    if (stored?.schemaVersion === JOURNAL_SCHEMA && Number.isSafeInteger(stored.revision) && Array.isArray(stored.events)) {
      revision = stored.revision;
      events = stored.events.slice(-MAX_EVENTS);
    }
  } catch (error) {
    if (error?.code !== "SERVICE_DATA_NOT_FOUND") throw error;
  }

  function frame(event) {
    return `id: ${event.eventId}\nevent: skill-hub.catalog.changed\ndata: ${JSON.stringify(event)}\n\n`;
  }

  function remove(subscriber, end = false) {
    subscribers.delete(subscriber);
    if (end) {
      try { subscriber.response.end(); } catch {}
    }
  }

  function deliver(subscriber, event) {
    try {
      if (subscriber.response.destroyed || subscriber.response.writableEnded ||
          subscriber.response.write(frame(event)) === false ||
          Number(subscriber.response.writableLength || 0) > 64 * 1024) {
        remove(subscriber, true);
        return false;
      }
      return true;
    } catch {
      remove(subscriber, true);
      return false;
    }
  }

  return Object.freeze({
    async publish(operationId) {
      if (closed || !MUTATING_OPERATIONS.has(String(operationId || ""))) return null;
      let published;
      writeTail = writeTail.then(async () => {
        revision += 1;
        published = Object.freeze({
          schemaVersion: EVENT_SCHEMA,
          eventId: revision,
          serviceRevision: revision,
          eventType: "skill-hub.catalog.changed",
          operationId: String(operationId),
          occurredAt: new Date().toISOString()
        });
        events = [...events, published].slice(-MAX_EVENTS);
        await serviceData.writeFile(EVENT_RESOURCE, JSON.stringify({
          schemaVersion: JOURNAL_SCHEMA,
          revision,
          events
        }));
        for (const subscriber of [...subscribers]) deliver(subscriber, published);
      });
      await writeTail;
      return published;
    },
    subscribe({ request, response, cursor = 0 }) {
      if (closed || subscribers.size >= MAX_SUBSCRIBERS) return { ok: false, status: closed ? 503 : 429 };
      const normalizedCursor = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
      const subscriber = { response };
      subscribers.add(subscriber);
      request.once?.("close", () => remove(subscriber));
      for (const event of events) {
        if (event.eventId > normalizedCursor && !deliver(subscriber, event)) break;
      }
      return { ok: subscribers.has(subscriber), close: () => remove(subscriber, true) };
    },
    async close() {
      closed = true;
      await writeTail;
      for (const subscriber of [...subscribers]) remove(subscriber, true);
    }
  });
}
