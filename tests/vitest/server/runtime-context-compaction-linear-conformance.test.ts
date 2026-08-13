import { describe, expect, it } from "vitest";

import {
  createApiRoundSelectionIndex,
  messagesByApiRound,
  modelInputForAttempt,
  selectImportantLines,
  workbenchInputForAttempt
} from "../../../packages/server-runtime/src/state/context-compact/projection.ts";
import {
  CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES,
  conversationPayloadBytes,
  createContextCompactionExecutionLane
} from "../../../packages/server-runtime/src/state/context-compact/execution-lane.ts";

describe("context compaction linear selection", () : any => {
  it("builds indexed API rounds once and selects the earliest bounded suffix", () : any => {
    const messages: any[] = Array.from({ length: 2_000 }, (_, index) => ({
      id: `message-${index}`,
      apiRoundId: `round-${Math.floor(index / 2)}`,
      text: `message ${index}`,
      tokenEstimate: 2
    }));
    const groups: any[] = messagesByApiRound(messages);
    expect(groups).toHaveLength(1_000);
    expect(groups[499]).toMatchObject({ start: 998, end: 1_000, totalTokens: 4 });

    const selected: any[] = modelInputForAttempt(messages, 0, 200);
    expect(selected).toHaveLength(100);
    expect(selected[0].apiRoundId).toBe("round-950");
    expect(selected.at(-1).apiRoundId).toBe("round-999");

    const workbench: any = workbenchInputForAttempt(messages, 0, 200, 0.2);
    expect(workbench.metadata).toMatchObject({ droppedGroupCount: 950, inputTokens: 200 });
    expect(workbench.messages).toEqual(selected);

    const selectionIndex: any = createApiRoundSelectionIndex(messages);
    expect(selectionIndex.groups).toHaveLength(1_000);
    expect(selectionIndex.suffixTokens).toHaveLength(1_001);
    expect(modelInputForAttempt(messages, 1, 200, selectionIndex)[0].apiRoundId).toBe("round-950");
    expect(workbenchInputForAttempt(messages, 1, 200, 0.1, selectionIndex).metadata)
      .toMatchObject({ droppedGroupCount: 950, inputTokens: 200 });
  });

  it("keeps fixed top-k line ranking stable without sorting the entire input", () : any => {
    const lines: string[] = Array.from({ length: 1_000 }, (_, index) =>
      index % 100 === 0 ? `must preserve decision ${index}` : `ordinary line ${index}`
    );
    expect(selectImportantLines(lines.join("\n"), 4)).toEqual([
      "must preserve decision 0",
      "must preserve decision 100",
      "must preserve decision 200",
      "must preserve decision 300"
    ]);
  });

  it("moves admitted large normalization work through a bounded worker lane", async () : Promise<any> => {
    const payload: any = {
      messages: Array.from({ length: 320 }, (_, index) => ({
        id: `large-${index}`,
        role: index % 2 ? "assistant" : "user",
        apiRoundId: `large-round-${Math.floor(index / 2)}`,
        content: "x".repeat(2_048)
      }))
    };
    const bytes: number = conversationPayloadBytes(payload);
    expect(bytes).toBeGreaterThan(CONTEXT_COMPACTION_WORKER_THRESHOLD_BYTES);
    const lane: any = createContextCompactionExecutionLane({ maxPending: 1, maxPendingBytes: bytes + 1_024 });
    try {
      const normalized: any[] = await lane.normalize(payload, { bytes, deadlineMs: 10_000 });
      expect(normalized).toHaveLength(320);
      expect(normalized[0]).toMatchObject({ id: "large-0", tokenEstimate: expect.any(Number) });
      expect(lane.getStats()).toMatchObject({ pending: 0, pendingBytes: 0, maxPending: 1 });
    } finally {
      await lane.close();
    }
  });
});
