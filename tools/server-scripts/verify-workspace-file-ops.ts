import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startHttpServer } from "../../apps/server/runtime/http-server.ts";
import { installAuthenticatedFetch, authHeaders } from "./test-auth-helper.ts";

const b64: any = (s?: any) : any => Buffer.from(s).toString("base64");

let server: any;
const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-ws-ops-"));
try { server = await startHttpServer({ userDataPath, distPath: "", port: 0, runtimeOptions: { profile: "minimal" } }); }
catch (e: any) { console.error("FAIL: start:", e.message); process.exit(1); }

const auth: any = await installAuthenticatedFetch(server);

let passed: any = 0, failed: any = 0;
async function test(name?: any, fn?: any) : Promise<any> {
  process.stdout.write(`  ${name} ... `);
  try { await fn(); passed++; console.log("ok"); }
  catch (e: any) { failed++; console.log(`FAIL\n      ${e.message}`); }
}

async function call(method?: any, urlPath?: any, body?: any) : Promise<any> {
  const opts: Record<string, any> = { method, headers: authHeaders(auth) };
  if (body) { opts.body = JSON.stringify(body); opts.headers["Content-Type"] = "application/json"; }
  const r: any = await fetch(`${server.url}${urlPath}`, opts);
  return r.json();
}

console.log("\n=== Workspace File Ops: write / delete / move ===\n");

const wsResp: any = await call("POST", "/api/agent-workspaces", { title: "file-ops-test" });
const wsId: any = wsResp.workspace.workspaceId;
console.log("  isolated workspace created");

await call("POST", `/api/agent-workspaces/${wsId}/folders`, { path: "test" });
for (const [p, c] of [["test/hello.txt","hello world"],["test/temp.txt","delete me"],["a.txt","file a"],["x.txt","x"],["y.txt","y"]]) {
  await call("POST", `/api/agent-workspaces/${wsId}/files`, { path: p, contentBase64: b64(c) });
}

// ── write ──
await test("write overwrites content", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/write`, { path: "test/hello.txt", contentBase64: b64("updated v2!") });
  assert.equal(r.ok, true);
  assert.equal(r.overwritten, true);
  assert.ok(r.stateCommit?.commitId, "write should return state commit");
  assert.ok(r.stateCommit?.eventHash, "write should return event hash");
  assert.equal(r.file.sizeBytes, 11);
});

await test("write non-existent returns 404", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/write`, { path: "no/such.txt", contentBase64: b64("x") });
  assert.equal(r.status, 404);
});

await test("write rejects dotfile", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/write`, { path: ".hidden", contentBase64: b64("x") });
  assert.equal(r.status, 400);
});

// ── move ──
await test("move renames file", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/move`, { sourcePath: "test/hello.txt", targetPath: "test/goodbye.txt" });
  assert.equal(r.ok, true);
  assert.ok(r.stateCommit?.commitId, "move should return state commit");
  assert.equal(r.file.relativePath, "test/goodbye.txt");
  const stat: any = await call("GET", `/api/agent-workspaces/${wsId}/files/stat?path=test/hello.txt`);
  assert.equal(stat.exists, false);
});

await test("move to different folder", async () : Promise<any> => {
  await call("POST", `/api/agent-workspaces/${wsId}/folders`, { path: "archive" });
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/move`, { sourcePath: "test/goodbye.txt", targetPath: "archive/goodbye.txt" });
  assert.equal(r.file.relativePath, "archive/goodbye.txt");
});

await test("move with overwrite", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/move`, { sourcePath: "a.txt", targetPath: "archive/goodbye.txt", overwrite: true });
  assert.equal(r.ok, true);
});

await test("move no overwrite returns 409", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/move`, { sourcePath: "x.txt", targetPath: "y.txt" });
  assert.equal(r.status, 409);
});

await test("move source not found 404", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/move`, { sourcePath: "no/such.txt", targetPath: "dest.txt" });
  assert.equal(r.status, 404);
});

await test("move rejects dotfile target", async () : Promise<any> => {
  const r: any = await call("POST", `/api/agent-workspaces/${wsId}/files/move`, { sourcePath: "y.txt", targetPath: ".hidden" });
  assert.equal(r.status, 400);
});

// ── delete ──
await test("delete file", async () : Promise<any> => {
  const r: any = await call("DELETE", `/api/agent-workspaces/${wsId}/files?path=test/temp.txt`);
  assert.equal(r.ok, true);
  assert.equal(r.deleted, true);
  assert.ok(r.stateCommit?.commitId, "delete should return state commit");
  const stat: any = await call("GET", `/api/agent-workspaces/${wsId}/files/stat?path=test/temp.txt`);
  assert.equal(stat.exists, false);
});

await test("delete non-existent 404", async () : Promise<any> => {
  const r: any = await call("DELETE", `/api/agent-workspaces/${wsId}/files?path=no/such.txt`);
  assert.equal(r.status, 404);
});

await test("delete rejects dotfile", async () : Promise<any> => {
  const r: any = await call("DELETE", `/api/agent-workspaces/${wsId}/files?path=.hidden`);
  assert.equal(r.status, 400);
});

// ── list consistency ──
await test("list reflects all changes", async () : Promise<any> => {
  const r: any = await call("GET", `/api/agent-workspaces/${wsId}/files`);
  const paths: any = r.files.map((f?: any) : any => f.relativePath);
  assert.ok(!paths.includes("test/hello.txt"));
  assert.ok(!paths.includes("test/temp.txt"));
  assert.ok(paths.includes("archive/goodbye.txt"));
  assert.ok(paths.includes("y.txt"));
  const dirs: any = r.files.filter((f?: any) : any => f.type === "directory");
  dirs.forEach((d?: any) : any => assert.equal(d.sizeBytes, 0, `${d.relativePath} should be 0B`));
});

if (server?.close) await server.close();
await fs.rm(userDataPath, { recursive: true, force: true }).catch(() : any => {});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed ? 1 : 0);
