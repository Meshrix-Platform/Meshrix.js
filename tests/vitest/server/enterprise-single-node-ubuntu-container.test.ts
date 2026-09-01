import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND,
  createEnterpriseSingleNodeRegressionCommands,
  createUbuntuContainerRequest,
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

  it("keeps the delivery audit split independent from the repository-wide regression", () : any => {
    const commands: any = createEnterpriseSingleNodeRegressionCommands({
      profile: "audit-public",
      hostSuiteIds: ["host-suite"],
      workerSuiteIds: ["worker-suite"],
    });

    expect(commands).toEqual([
      "node tests/run.ts --profile audit-public --suite host-suite",
      "node tests/run.ts --profile audit-public --suite worker-suite",
    ]);
    expect(commands).not.toContain("npm run verify");
  });
});
