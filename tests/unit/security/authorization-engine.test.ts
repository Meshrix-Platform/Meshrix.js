import { describe, expect, it } from "vitest";

import { evaluateAuthorizationPolicy } from "../../../packages/foundation/src/security/authorization/authorization-engine.ts";

const writeOperation: Readonly<Record<string, any>> = Object.freeze({
  id: "workspace.create",
  risk: "safe_write",
  requiredScopes: ["workspace:write"],
  requiredCapabilities: ["cap:api:workspace.file.list"]
});

describe("Authorization engine", () : any => {
  it("allows a subject with the exact capability and required scope", () : any => {
    const decision: any = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "user-1",
        capabilities: ["cap:api:workspace.file.list"],
        scopes: ["workspace:write"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(true);
    expect(decision.reasonCode).toBe("allowed");
  });

  it("does not let non-admin wildcard capabilities bypass missing exact grants", () : any => {
    const decision: any = evaluateAuthorizationPolicy({
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

  it("allows wildcard capabilities when explicit administration scope is present", () : any => {
    const decision: any = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "admin-1",
        roleId: "maintainer",
        capabilities: ["cap:api:*"],
        scopes: ["auth:admin", "workspace:write"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(true);
  });

  it("requires approval receipts for destructive operations instead of confirm flags", () : any => {
    const operation: Record<string, any> = {
      id: "workspace.checkpoint.restore",
      risk: "destructive",
      requiredScopes: ["workspace:write", "checkpoint:restore"],
      requiredCapabilities: ["cap:api:workspace.checkpoint.restore"]
    };

    const decision: any = evaluateAuthorizationPolicy({
      operation,
      input: { confirm: true },
      subject: {
        type: "user",
        subjectId: "admin-2",
        roleId: "maintainer",
        capabilities: ["cap:api:workspace.checkpoint.restore"],
        scopes: ["auth:admin", "workspace:write", "checkpoint:restore"],
        maxRisk: "destructive"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.effect).toBe("require_approval");
    expect(decision.reasonCode).toBe("approval_receipt_required");
  });

  it("denies a subject with no capabilities when the operation requires them (default deny)", () : any => {
    const decision: any = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "user-3",
        scopes: ["workspace:write"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("missing_capabilities");
    expect(decision.missingCapabilities).toEqual(["cap:api:workspace.file.list"]);
  });

  it("denies a subject missing required scopes even when the capability is present", () : any => {
    const decision: any = evaluateAuthorizationPolicy({
      operation: writeOperation,
      subject: {
        type: "user",
        subjectId: "user-4",
        capabilities: ["cap:api:workspace.file.list"],
        scopes: ["workspace:read"],
        maxRisk: "safe_write"
      }
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reasonCode).toBe("missing_scopes");
    expect(decision.missingScopes).toEqual(["workspace:write"]);
  });

  it("honors context-carried requiredCapabilities from route guards", () : any => {
    const decision: any = evaluateAuthorizationPolicy({
      operation: {
        id: "console.route_guard",
        requiredScopes: [],
        readOnly: true
      },
      subject: {
        type: "user",
        subjectId: "user-5",
        capabilities: ["cap:api:workspace.file.list"],
        scopes: [],
        maxRisk: "safe_write"
      },
      context: { requiredCapabilities: ["cap:api:workspace.file.list"] }
    });

    expect(decision.allowed).toBe(true);

    const denied: any = evaluateAuthorizationPolicy({
      operation: {
        id: "console.route_guard",
        requiredScopes: [],
        readOnly: true
      },
      subject: {
        type: "user",
        subjectId: "user-6",
        capabilities: [],
        scopes: [],
        maxRisk: "safe_write"
      },
      context: { requiredCapabilities: ["cap:api:workspace.file.list"] }
    });

    expect(denied.allowed).toBe(false);
    expect(denied.reasonCode).toBe("missing_capabilities");
  });
});
