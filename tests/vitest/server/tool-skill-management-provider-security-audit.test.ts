import { describe, expect, it, vi } from "vitest";
import { createToolSkillManagementProvider } from "../../../packages/capabilities/src/skills/tool-skill-management-provider.ts";
const canned1 = "synthetic-invalid-key";
const canned2 = "api-key-admission";




describe("MCP API-key denial audit", () => {
  it("records redacted denials once per audit window and aggregates suppressed attempts", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-13T00:00:00.000Z"));
    const appendDecision = vi.fn(async (_decision: Record<string, any>) => undefined);
    const provider = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest: vi.fn() },
        apiKeyDistributionProvider: {}
      },
      securityPermissions: { appendDecision }
    });
    provider.configurePublicOrigin("https://meshrix.example.test");
    const authorize = () => provider.authorizeRequest({
      request: {
        headers: { "x-meshrix.js-api-key": canned1 }
      },
      requestBody: Buffer.alloc(0),
      url: new URL("https://meshrix.example.test/mcp"),
      method: "POST"
    });

    try {
      await expect(authorize()).resolves.toMatchObject({
        handled: true,
        ok: false,
        status: 401
      });
      await authorize();

      expect(appendDecision).toHaveBeenCalledTimes(1);
      const firstDecision = appendDecision.mock.calls[0][0];
      expect(firstDecision).toMatchObject({
        operationId: "mcp.authenticate",
        action: "mcp.authenticate",
        effect: "deny",
        allowed: false,
        reasonCode: "api_key_authentication_denied",
        subject: { type: "anonymous", subjectId: "", scopes: [] },
        resource: { operationId: "mcp.authenticate", risk: "read_only" },
        redactedReason: "MCP API key authentication was denied (1 denied attempt in the audit window)."
      });
      expect(JSON.stringify(firstDecision)).not.toContain("synthetic-invalid-key");
      expect(JSON.stringify(firstDecision)).not.toContain("x-meshrix.js-api-key");

      vi.advanceTimersByTime(60_000);
      await authorize();
      expect(appendDecision).toHaveBeenCalledTimes(2);
      expect(appendDecision.mock.calls[1][0].redactedReason)
        .toBe("MCP API key authentication was denied (2 denied attempts in the audit window).");
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a failed pre-body API-key admission once even if runtime authorization follows", async () => {
    const appendDecision = vi.fn(async (_decision: Record<string, any>) => undefined);
    const provider = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        store: { authorizeRequest: vi.fn() },
        apiKeyDistributionProvider: {
          authenticateAdmission: vi.fn(async () => {
            throw new Error("synthetic authority outage");
          })
        }
      },
      securityPermissions: { appendDecision }
    });
    provider.configurePublicOrigin("https://meshrix.example.test");
    const request = {
      headers: { "x-meshrix.js-api-key": ("mxak1."+"A".repeat(22)+"."+"B".repeat(43)) }
    };

    await expect(provider.authenticateAdmission({ request })).resolves.toMatchObject({
      handled: true,
      ok: false,
      status: 503,
      reasonCode: "api_key_authority_unavailable"
    });
    await expect(provider.authorizeRequest({
      request,
      requestBody: Buffer.alloc(0),
      url: new URL("https://meshrix.example.test/mcp"),
      method: "POST"
    })).resolves.toMatchObject({ handled: true, ok: false, status: 503 });

    expect(appendDecision).toHaveBeenCalledTimes(1);
    expect(appendDecision.mock.calls[0][0]).toMatchObject({
      operationId: "mcp.authenticate",
      reasonCode: "api_key_authority_unavailable"
    });
    expect(JSON.stringify(appendDecision.mock.calls[0][0]))
      .not.toContain("synthetic authority outage");
  });

  it("derives API-key audience from the configured public origin, never request Host", async () => {
    const authenticateAdmission = vi.fn(async (_input: Record<string, any>) => ({
      credentialKind: canned2,
      subjectId: "synthetic-subject",
      tenantId: "synthetic-tenant"
    }));
    const provider = createToolSkillManagementProvider({
      operationPermissionPlatform: {
        apiKeyDistributionProvider: { authenticateAdmission }
      }
    });
    const publicOrigin = "https://meshrix.example.test";
    provider.configurePublicOrigin(publicOrigin);

    const result = await provider.authenticateAdmission({
      request: {
        headers: {
          host: "attacker.example.test",
          "x-meshrix.js-api-key": ("mxak1."+"A".repeat(22)+"."+"B".repeat(43))
        }
      }
    });

    expect(provider.getPublicOrigin()).toBe(publicOrigin);
    expect(result).toMatchObject({ ok: true, tenantId: "synthetic-tenant" });
    expect(authenticateAdmission).toHaveBeenCalledWith(expect.objectContaining({
      serverAudience: "meshrix.example.test"
    }));
    expect(authenticateAdmission.mock.calls[0][0].serverAudience).not.toBe("attacker.example.test");
  });
});
