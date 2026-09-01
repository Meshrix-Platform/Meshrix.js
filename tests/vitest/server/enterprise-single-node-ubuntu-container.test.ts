import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND,
  createUbuntuContainerRequest,
  reduceEnterpriseSingleNodeFailure,
  validateEnterpriseSingleNodeWorkerSummary,
} from "../../../tools/server-scripts/verify-enterprise-single-node-ubuntu-container.ts";

describe("enterprise single-node Ubuntu container", () : any => {
  it("executes the read-only source candidate through source import conditions", () : any => {
    const request: any = createUbuntuContainerRequest({
      image: `sha256:${"a".repeat(64)}`,
      candidateRoot: "/candidate",
      evidenceRoot: "/evidence",
      uid: 1001,
      gid: 1002,
    });

    expect(request.args.slice(0, 11)).toEqual([
      "run",
      "--rm",
      "--network",
      "none",
      "--user",
      "1001:1002",
      "--env",
      "NODE_OPTIONS=--conditions=source",
      "--env",
      "HOME=/worker",
      "--tmpfs",
    ]);
    expect(request.args).toContain("/worker:exec,mode=0700,uid=1001,gid=1002");
  });

  it("keeps source delivery independent from released-image rollback evidence", () : any => {
    expect(ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND)
      .toBe("node tools/server-scripts/verify-operation-permission-tag-governed-e2e.ts");
    expect(ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND)
      .not.toContain("enterprise-operations-closure");
  });

  it("reports only privacy-safe internal failure codes", () : any => {
    expect(reduceEnterpriseSingleNodeFailure({
      phase: "ubuntu-delivery",
      cause: "ubuntu_delivery_worker_execution_failed",
    })).toMatchObject({ cause: "ubuntu_delivery_worker_execution_failed" });
    expect(reduceEnterpriseSingleNodeFailure({
      phase: "ubuntu-delivery",
      cause: "failed at /private/path",
    })).toMatchObject({ cause: "enterprise_single_node_internal_failure" });
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
