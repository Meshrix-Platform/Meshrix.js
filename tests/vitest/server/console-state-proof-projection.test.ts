import { describe, expect, it } from "vitest";

import {
  consoleStateProofChangeProjection
} from "../../../packages/protocols/http/controllers/system-controller.ts";

describe("console state proof projection", () : any => {
  it("hashes only stable status, revision and count fields", () : any => {
    const state: Record<string, any> = {
      server: { url: "http://private-host.invalid" },
      auth: { userId: "private-user", expiresAt: "volatile" },
      settings: { path: "/private/path", value: { secret: "private-secret" } },
      runtime: { status: "ready", version: "1", volatileMessage: "first" },
      discovery: { value: { mode: "local", configVersion: 3, activeServiceUrl: "private" } },
      readinessBaseline: { ok: true, status: "ready", checkedAt: "volatile" },
      storage: { objectCount: 4, objectBytes: 128, path: "/private/storage" },
      jobs: { summary: { total: 3, byStatus: { running: 1, completed: 2 }, updatedAt: "volatile" } },
      clients: { summary: { onlineCount: 2, sessionIds: ["private"] } },
      features: [{ id: "feature-b", enabled: false }, { id: "feature-a", enabled: true }]
    };
    const first: any = consoleStateProofChangeProjection(state);
    const privateOnlyChange: any = consoleStateProofChangeProjection({
      ...state,
      server: { url: "http://another-private-host.invalid" },
      auth: { userId: "another-user" },
      settings: { path: "/another/private/path", value: { secret: "another-secret" } },
      runtime: { ...state.runtime, volatileMessage: "second" }
    });
    const countChange: any = consoleStateProofChangeProjection({
      ...state,
      jobs: { summary: { ...state.jobs.summary, total: 4 } }
    });

    expect(first).toMatchObject({
      changeProjection: "console-state-v1"
    });
    expect(first.changeDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(privateOnlyChange.changeDigest).toBe(first.changeDigest);
    expect(countChange.changeDigest).not.toBe(first.changeDigest);
  });
});
