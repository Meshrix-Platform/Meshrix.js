import { describe, expect, it } from "vitest";
import { createStoragePort } from "pactium";
import {
  checkpointTreeId,
  queryCheckpointScope,
  startCheckpointTree,
  upsertCheckpointNode
} from "../../../packages/foundation/src/checkpoint/tree/checkpoint-tree-projection.ts";
import { createMeshrixPactiumRuntime } from "../../../packages/foundation/src/checkpoint/tree/pactium-runtime.ts";

describe("normalized checkpoint projection", () : any => {
  it("stores no aggregate tree and reads only reached subtree vertices", async () : Promise<any> => {
    const base: any = createStoragePort({ inMemory: true });
    const reads: any[] = [];
    const writes: any[] = [];
    const storage: any = {
      ...base,
      async getProtocolObject(scope?: any, key?: any, fallback?: any) : Promise<any> {
        reads.push([scope, key]);
        return base.getProtocolObject(scope, key, fallback);
      },
      async putProtocolObject(scope?: any, key?: any, value?: any) : Promise<any> {
        writes.push([scope, key]);
        return base.putProtocolObject(scope, key, value);
      }
    };
    const runtime: any = createMeshrixPactiumRuntime({ inMemory: true, storage });
    const treeId: any = checkpointTreeId("normalized", "one");
    try {
      await startCheckpointTree({ pactiumRuntime: runtime, treeId, kind: "normalized", ownerId: "owner" });
      await upsertCheckpointNode({ pactiumRuntime: runtime, treeId, nodeId: "a", parentId: "root", status: "running" });
      await upsertCheckpointNode({ pactiumRuntime: runtime, treeId, nodeId: "a1", parentId: "a", status: "completed" });
      await upsertCheckpointNode({ pactiumRuntime: runtime, treeId, nodeId: "b", parentId: "root", status: "completed" });
      expect(writes.some(([scope]: any[]) : any => scope === "meshrix-checkpoint-tree")).toBe(false);
      expect(writes.some(([scope]: any[]) : any => scope === "meshrix-checkpoint-tree-meta")).toBe(true);

      reads.length = 0;
      const scoped: any = await queryCheckpointScope({ pactiumRuntime: runtime, treeId, nodeId: "a" });
      expect(scoped.nodes.map((node?: any) : any => node.nodeId)).toEqual(["a", "a1"]);
      expect(reads.some(([, key]: any[]) : any => key === `${treeId}:b`)).toBe(false);
      expect(reads.some(([scope]: any[]) : any => scope === "meshrix-checkpoint-tree-meta")).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
