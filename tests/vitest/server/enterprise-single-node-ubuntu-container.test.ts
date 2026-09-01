import { describe, expect, it } from "vitest";

import {
  ENTERPRISE_SINGLE_NODE_OPERATION_COMMAND,
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
});
