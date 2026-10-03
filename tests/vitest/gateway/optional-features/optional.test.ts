import { describe, expect, it } from "vitest";
import { createGateway } from "@meshrix/gateway";
import { createServiceEventAdapter, createServiceEventPort } from "@meshrix/agents/service-events";
import { SERVICE_COLLABORATION_PROTOCOL_VERSION, SERVICE_COLLABORATION_FALLBACK_PATH } from "@meshrix/contracts/service-collaboration-contract";

describe("optional service event boundary", () => {
  it("[CASE-A04] keeps the gateway dependent on generic events, not SkillHub or collaboration runtime", async () => {
    const gateway = createGateway();
    await gateway.start();
    const events: string[] = [];
    const source = createServiceEventPort();
    const unsubscribe = createServiceEventAdapter({ source, onEvent: (event) => { events.push(event.type); } });
    source.publish({ type: "service/list_changed", revision: "r1" });
    await Promise.resolve();
    expect(events).toEqual(["service/list_changed"]);
    expect(SERVICE_COLLABORATION_PROTOCOL_VERSION).not.toBe("2026-07-28-gateway-core");
    expect(SERVICE_COLLABORATION_FALLBACK_PATH).toBe("ordinary-mcp");
    unsubscribe();
    await gateway.close();
  });
});
