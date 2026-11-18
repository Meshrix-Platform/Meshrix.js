import { expect, it, vi } from "vitest";

const bootstrap = vi.hoisted(() => ({ events: [] as string[] }));

vi.mock("node:worker_threads", () => ({
  parentPort: {
    on: vi.fn(),
    postMessage(message: { readonly type: string }) {
      bootstrap.events.push(message.type);
    }
  }
}));

vi.mock("ajv/dist/2020.js", () => ({
  Ajv2020: class {
    getSchema(uri: string) {
      bootstrap.events.push(`metaschema:${uri}`);
      return () => true;
    }
    compile() {
      bootstrap.events.push("untrusted-compile");
      return () => true;
    }
  }
}));

it("compiles the trusted default metaschema before declaring the worker ready", async () => {
  await import("../../../../packages/kernel/src/schema/isolated-worker.ts");
  expect(bootstrap.events).toEqual([
    "metaschema:https://json-schema.org/draft/2020-12/schema",
    "ready"
  ]);
});
