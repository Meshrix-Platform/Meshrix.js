// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const bridge = vi.hoisted(() => ({
  deleteJson: vi.fn(),
  getJson: vi.fn(),
  postJson: vi.fn(),
}));

vi.mock("@meshrix/ui-console/bridge-http", () => bridge);

import {
  previewWorkspaceCheckpointRestoreRequest,
  restoreWorkspaceCheckpointRequest,
} from "../../../apps/console/lib/workspaces-client";

beforeEach(() => {
  vi.clearAllMocks();
  bridge.postJson.mockResolvedValue({ ok: true });
});

describe("workspace checkpoint restore client", () => {
  it("sends the safety confirmation required by both preview and apply operations", async () => {
    const payload = {
      treeId: "tree-fixture",
      nodeId: "node-fixture",
      workspaceId: "workspace-fixture",
      reason: "console fixture",
    };

    await previewWorkspaceCheckpointRestoreRequest(payload);
    await restoreWorkspaceCheckpointRequest(payload);

    expect(bridge.postJson).toHaveBeenNthCalledWith(
      1,
      "/api/workspace/checkpoints/restore/preview",
      payload,
      { safetyConfirm: true },
    );
    expect(bridge.postJson).toHaveBeenNthCalledWith(
      2,
      "/api/workspace/checkpoints/restore",
      payload,
      { safetyConfirm: true },
    );
  });
});
