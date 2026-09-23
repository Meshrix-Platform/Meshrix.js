import { describe, expect, it } from "vitest";
import { createIsolatedSchemaValidator } from "@meshrix/gateway/schema";
import { spawnSync } from "node:child_process";
import { context, createTestGateway, descriptor, route } from "../support";

describe("external schema execution isolation", () => {
  it("does not inherit an embedded client's --input-type/eval flags into a file-based Worker", () => {
    const code = `import { createIsolatedSchemaValidator } from '@meshrix/gateway/schema'; const validator=createIsolatedSchemaValidator(); await validator.compile({type:'object',required:['ok']}).assertValid({ok:true}); await validator.close(); process.stdout.write('validated');`;
    const result = spawnSync(process.execPath, ["--conditions=source", "--input-type=module", "-e", code], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("validated");
  }, 12_000);

  it("cancels a hostile regex inside a Worker without blocking the ingress event loop", async () => {
    const isolated = createIsolatedSchemaValidator();
    const schema = { type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } }, required: ["value"] };
    let heartbeats = 0;
    const ticker = setInterval(() => { heartbeats += 1; }, 10);
    try {
      await isolated.preflight(schema);
      await expect(isolated.compile(schema).assertValid({ value: `${"a".repeat(22_000)}!` })).rejects.toMatchObject({ code: "schema_execution_timeout" });
      expect(heartbeats).toBeGreaterThan(10);
      await expect(isolated.compile({ type: "object", required: ["ok"] }).assertValid({ ok: true })).resolves.toBeUndefined();
    } finally { clearInterval(ticker); await isolated.close(); }
  }, 15_000);

  it("rejects hostile input before any protected upstream write", async () => {
    let dispatched = 0;
    const gateway = createTestGateway({
      descriptors: [descriptor({ route: route({ effectClass: "safe_write" }), inputSchema: { type: "object", properties: { value: { type: "string", pattern: "^(a+)+$" } } } })],
      upstream: { async invoke() { dispatched += 1; return { status: 200, body: { resultType: "complete", content: [] } }; } }
    });
    await gateway.start();
    try {
      expect(await gateway.invoke(context, { routeRef: "route.demo", method: "tools/call", params: { value: `${"a".repeat(22_000)}!` } })).toMatchObject({ kind: "failure", effectOutcome: "not_started" });
      expect(dispatched).toBe(0);
    } finally { await gateway.close(); }
  }, 15_000);
});
