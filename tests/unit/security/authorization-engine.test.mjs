import { describe, expect, it } from "vitest";

import { evaluateAuthorizationPolicy } from "../../../packages/foundation/src/security/authorization/authorization-engine.mjs";

const writeOperation = Object.freeze({
  id: "workspace.create",
  risk: "safe_write",
  requiredScopes: ["workspace:write"],
  requiredCapabilities: ["cap:api:workspace.create"]
});

describe("Authorization engine", () => {
  it("allows a subject with the exact capability and required scope", () => {
    const decision = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "user-1",
        capabilities: ["cap:api:workspace.create"],
        scopes: ["workspace:write"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("allowed");
  });

  it("does not let non-admin wildcard capabilities bypass missing exact grants", () => {
    const decision = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "user-2",
        roleId: "member",
        capabilities: ["cap:api:*"],
        scopes: ["workspace:write"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("missing_capabilities");
  });

  it("allows admin wildcard capabilities when scopes are present", () => {
    const decision = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "admin-1",
        roleId: "admin",
        capabilities: ["cap:api:*"],
        scopes: ["auth:admin", "workspace:write"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(true);
  });

  it("requires approval receipts for destructive operations instead of confirm flags", () => {
    const operation = {
      id: "workspace.checkpoint.restore",
      risk: "destructive",
      requiredScopes: ["workspace:write", "checkpoint:restore"],
      requiredCapabilities: ["cap:api:workspace.checkpoint.restore"]
    };

    const decision = evaluateAuthorizationPolicy({
      operation,
      input: { confirm: true },
      subject: {
        type: "user",
        subjectId: "admin-2",
        roleId: "admin",
        capabilities: ["cap:api:workspace.checkpoint.restore"],
        scopes: ["auth:admin", "workspace:write", "checkpoint:restore"],
        maxRisk: "destructive"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe("require_approval");
    expect(decision.reasonCode).toBe("approval_receipt_required");
  });
});
