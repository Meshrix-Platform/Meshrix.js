import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND,
  createUbuntuContainerRequest,
  validateEnterpriseSingleNodeWorkerSummary,
} from "../../../tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts";

describe("enterprise single-node Ubuntu container", () : any => {
  it("executes the read-only source candidate through source import conditions", () : any => {
    const request: any = createUbuntuContainerRequest({
      image: `sha256:${"a".repeat(64)}`,
      candidateRoot: "/candidate",
      evidenceRoot: "/evidence",
    });

    expect(request.args.slice(0, 7)).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--env",
      "NODE_OPTIONS=--conditions=source",
      "--tmpfs",
    ]);
  });

  it("keeps source delivery independent from released-image rollback evidence", () : any => {
    expect(ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND)
      .toBe("node tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts");
    expect(ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND)
      .not.toContain("enterprise-operations-closure");
  });

  it("records only the Ubuntu operation proof without embedding repository audits", () : any => {
    const command: any = ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND;
    const implementationNodes: any = [{
      id: "core-operations",
      acceptance_criteria: [{ statement: "Core operations pass." }],
      regression: { commands: [command], criteria: [0] },
    }];
    const observation: any = {
      command_sha256: crypto.createHash("sha256").update(command).digest("hex"),
      exit_code: 0,
      stdout_sha256: "a".repeat(64),
      stderr_sha256: "b".repeat(64),
      stdout_bytes: 1,
      stderr_bytes: 0,
    };
    const summary: any = {
      schema_version: "v0.0.1:meshrix:enterprise-single-node-ubuntu-evidence-1",
      status: "passed",
      candidate: { candidate_digest: "c".repeat(64) },
      implementation_nodes: [{ node_id: "core-operations", commands: [observation] }],
      recorded_at: "2026-09-02T00:00:00.000Z",
      privacy_safe: true,
    };

    expect(validateEnterpriseSingleNodeWorkerSummary({ summary, implementationNodes }))
      .toMatchObject({ recordedAt: summary.recorded_at });
    expect(() => validateEnterpriseSingleNodeWorkerSummary({
      summary: { ...summary, full_regression: [] },
      implementationNodes,
    })).toThrow("ubuntu_delivery_summary_invalid");
  });
});
