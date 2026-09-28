import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "undici";

import { MCP_INTERFACE_VERSION, MCP_STABLE_TOOL_NAME } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/constants.ts";
import { loadMcpConnectorPreferences, saveMcpApiKeyCredential } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/credential-store.ts";
import { fetchCommand, MCP_FETCH_MAX_ARTIFACT_BYTES } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/fetch-command.ts";
import { proxyCommand, resolveProxyCredentials } from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/cli/proxy-command.ts";
import { signMcpHandshake } from "../../../packages/protocols/mcp/adapter/gateway-installer/mcp-identity.ts";
import { runWithOwnedProcessSignals } from "../../../packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts";

const API_KEY: any = `mxak1.${"A".repeat(22)}.${"b".repeat(43)}`;
const TOKEN_ENV: any = "MESHRIX_MCP_CONNECTOR_LIFETIME_TEST_TOKEN";
const CLI_ENTRY: any = fileURLToPath(new URL("../../../packages/protocols/mcp/adapter/gateway-installer/bin/meshrix-mcp.ts", import.meta.url));
let rootDir: any = "";
let server: any = null;
let baseUrl: any = "";
let onMcpSubscription: any = null;

function deferred() : any {
  let resolve: any;
  let reject: any;
  const promise: any = new Promise((accept?: any, fail?: any) : any => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate?: any) : Promise<any> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return;
    await new Promise((resolve?: any) : any => setImmediate(resolve));
  }
  throw new Error("The controlled connector fixture did not reach its expected state.");
}

function runNode(args?: any[]) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(process.execPath, args || [], {
      cwd: rootDir,
      env: {
        HOME: rootDir,
        USERPROFILE: rootDir,
        PATH: process.env.PATH || ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout: any = "";
    let stderr: any = "";
    child.stdout.setEncoding("utf8").on("data", (chunk?: any) : any => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk?: any) : any => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code?: any, signal?: any) : any => resolve({ code, signal, stdout, stderr }));
  });
}

async function startSignedHub() : Promise<any> {
  const pair: any = generateKeyPairSync("ed25519");
  const identity: any = {
    keyId: "connector-lifetime-fixture",
    publicKeyJwk: pair.publicKey.export({ format: "jwk" }),
    privateKeyJwk: pair.privateKey.export({ format: "jwk" })
  };
  const respond: any = (response?: any, payload?: any, status: any = 200) : any => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  };
  server = createServer(async (request?: any, response?: any) : Promise<any> => {
    if (request.url === "/api/gateway/v1/artifacts/artifact-fixture" && request.method === "GET") {
      const bytes: any = Buffer.from("artifact from the packaged Undici request owner");
      response.writeHead(200, {
        "content-type": "application/octet-stream",
        digest: `sha-256=${createHash("sha256").update(bytes).digest("base64")}`
      });
      response.end(bytes);
      return;
    }
    if (request.url === "/mcp" && request.method === "POST" && onMcpSubscription) {
      for await (const _chunk of request) {}
      onMcpSubscription(response, request);
      return;
    }
    if (request.url === "/api/mcp/discovery") {
      respond(response, {
        name: "Meshrix.js",
        interfaceVersion: MCP_INTERFACE_VERSION,
        stableToolName: MCP_STABLE_TOOL_NAME,
        identity: {
          algorithm: "Ed25519",
          keyId: identity.keyId,
          publicKeyJwk: identity.publicKeyJwk
        },
        handshake: { url: `${baseUrl}/api/mcp/handshake` }
      });
      return;
    }
    if (request.url === "/api/mcp/handshake" && request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk.toString("utf8");
      const input: any = JSON.parse(body);
      const payload: any = {
        schemaVersion: "v0.0.1:mcp:handshake-1",
        nonce: input.nonce,
        identity: {
          keyId: identity.keyId,
          publicKeyJwk: identity.publicKeyJwk
        },
        server: {
          name: "Meshrix.js",
          interfaceVersion: MCP_INTERFACE_VERSION,
          stableToolName: MCP_STABLE_TOOL_NAME
        }
      };
      respond(response, {
        ok: true,
        payload,
        signature: signMcpHandshake({ identity, payload })
      });
      return;
    }
    respond(response, { error: "not found" }, 404);
  });
  await new Promise((resolve?: any, reject?: any) : any => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address: any = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
  return { server, baseUrl };
}

function dispatcherFixture() : any {
  const dispatchers: any[] = [];
  return {
    dispatchers,
    factory: vi.fn((options?: any) : any => {
      expect(options).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
      const dispatcher: any = {
        close: vi.fn(async () : Promise<any> => {}),
        destroy: vi.fn(async () : Promise<any> => {})
      };
      dispatchers.push(dispatcher);
      return dispatcher;
    })
  };
}

async function fetchOptions(outputPath: any, additions: Record<string, any> = {}) : Promise<any> {
  return {
    target: "codex",
    "token-env": TOKEN_ENV,
    url: baseUrl,
    artifact: "artifact-fixture",
    out: outputPath,
    ...additions
  };
}

beforeEach(async () : Promise<any> => {
  rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-fetch-lifetime-"));
  onMcpSubscription = null;
  vi.stubEnv(TOKEN_ENV, API_KEY);
  vi.stubEnv("MESHRIX_MCP_CREDENTIAL_DIR", path.join(rootDir, "credentials"));
  await fs.mkdir(path.join(rootDir, "credentials"), { recursive: true, mode: 0o700 });
  await startSignedHub();
});

afterEach(async () : Promise<any> => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections?.();
    await new Promise((resolve?: any) : any => server.close(resolve));
  }
  server = null;
  baseUrl = "";
  onMcpSubscription = null;
  if (rootDir) await fs.rm(rootDir, { recursive: true, force: true });
});

describe("Meshrix connector caller-owned request lifetime", () : any => {
  it("executes version and help through the package-manager symlink and keeps imports inert", async () : Promise<any> => {
    const commandLink: any = path.join(rootDir, "meshrix-mcp");
    await fs.symlink(CLI_ENTRY, commandLink);

    const version: any = await runNode([commandLink, "version", "--json"]);
    expect(version.code).toBe(0);
    expect(version.stderr).toBe("");
    expect(JSON.parse(version.stdout)).toMatchObject({
      packageName: "meshrix-mcp-connector",
      packageVersion: "0.0.1"
    });

    const help: any = await runNode([commandLink, "help"]);
    expect(help.code).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.stdout).toContain("Usage:");

    const imported: any = await runNode([
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(CLI_ENTRY).href)});`
    ]);
    expect(imported.code).toBe(0);
    expect(imported.stdout).toBe("");
    expect(imported.stderr).toBe("");
  });

  it("uses the packaged Undici fetch and owned Agent for an actual artifact request", async () : Promise<any> => {
    const outputPath: any = path.join(rootDir, "actual-undici-artifact.bin");
    const bytes: any = Buffer.from("artifact from the packaged Undici request owner");
    const dispatcherFactory: any = vi.fn((options?: any) : any => {
      expect(options).toEqual({ headersTimeout: 0, bodyTimeout: 0 });
      return new Agent(options);
    });

    await expect(fetchCommand(await fetchOptions(outputPath, { dispatcherFactory }))).resolves.toMatchObject({
      ok: true,
      byteLength: bytes.length,
      digestVerified: true
    });
    expect(await fs.readFile(outputPath)).toEqual(bytes);
    expect(dispatcherFactory).toHaveBeenCalledOnce();
  });

  it("keeps artifact response-header waits alive beyond the former business cutoff", async () : Promise<any> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered: any = deferred();
    const dispatcherState: any = dispatcherFixture();
    const outputPath: any = path.join(rootDir, "held-headers.bin");
    const bytes: any = Buffer.from("artifact after delayed headers");
    let completeHeaders: any;
    const fetchImpl: any = vi.fn((_url?: any, init?: any) : any => {
      entered.resolve(init);
      return new Promise((resolve?: any, reject?: any) : any => {
        completeHeaders = resolve;
        init.signal.addEventListener("abort", () : any => reject(init.signal.reason), { once: true });
      });
    });

    const resultPromise: any = fetchCommand(await fetchOptions(outputPath, {
      fetchImpl,
      dispatcherFactory: dispatcherState.factory
    }));
    const requestOptions: any = await entered.promise;
    await vi.advanceTimersByTimeAsync(300_001);
    expect(requestOptions.signal.aborted).toBe(false);
    completeHeaders(new Response(bytes, {
      status: 200,
      headers: { digest: `sha-256=${createHash("sha256").update(bytes).digest("base64")}` }
    }));

    await expect(resultPromise).resolves.toMatchObject({
      ok: true,
      artifactId: "artifact-fixture",
      byteLength: bytes.length,
      digestVerified: true
    });
    expect(await fs.readFile(outputPath)).toEqual(bytes);
    expect(dispatcherState.factory).toHaveBeenCalledOnce();
    expect(requestOptions.dispatcher).toBe(dispatcherState.dispatchers[0]);
    expect(dispatcherState.dispatchers[0].close).toHaveBeenCalledOnce();
    expect(dispatcherState.dispatchers[0].destroy).not.toHaveBeenCalled();
    expect((await fs.readdir(rootDir)).some((entry?: any) : any => entry.includes(".part-"))).toBe(false);
  });

  it("keeps a streamed artifact body alive beyond the former business cutoff", async () : Promise<any> => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered: any = deferred();
    const dispatcherState: any = dispatcherFixture();
    const outputPath: any = path.join(rootDir, "held-body.bin");
    const bytes: any = Buffer.from("artifact body after delayed stream");
    let bodyController: any;
    const body = new ReadableStream({
      start(controller?: any) : any {
        bodyController = controller;
      }
    });
    const fetchImpl: any = vi.fn((_url?: any, init?: any) : any => {
      entered.resolve(init);
      return Promise.resolve(new Response(body, {
        status: 200,
        headers: { digest: `sha-256=${createHash("sha256").update(bytes).digest("base64")}` }
      }));
    });

    const resultPromise: any = fetchCommand(await fetchOptions(outputPath, {
      fetchImpl,
      dispatcherFactory: dispatcherState.factory
    }));
    const requestOptions: any = await entered.promise;
    await waitFor(async () : Promise<any> => (await fs.readdir(rootDir)).some((entry?: any) : any => entry.includes(".part-")));
    await vi.advanceTimersByTimeAsync(300_001);
    expect(requestOptions.signal.aborted).toBe(false);
    bodyController.enqueue(bytes);
    bodyController.close();

    await expect(resultPromise).resolves.toMatchObject({ ok: true, byteLength: bytes.length });
    expect(await fs.readFile(outputPath)).toEqual(bytes);
    expect(dispatcherState.dispatchers[0].close).toHaveBeenCalledOnce();
    expect(dispatcherState.dispatchers[0].destroy).not.toHaveBeenCalled();
  });

  it("aborts a held header wait and does not create a partial file", async () : Promise<any> => {
    const entered: any = deferred();
    const controller: any = new AbortController();
    const dispatcherState: any = dispatcherFixture();
    const outputPath: any = path.join(rootDir, "cancel-headers.bin");
    const fetchImpl: any = vi.fn((_url?: any, init?: any) : any => {
      entered.resolve(init);
      return new Promise((_resolve?: any, reject?: any) : any => {
        init.signal.addEventListener("abort", () : any => reject(init.signal.reason), { once: true });
      });
    });
    const resultPromise: any = fetchCommand(await fetchOptions(outputPath, {
      signal: controller.signal,
      fetchImpl,
      dispatcherFactory: dispatcherState.factory
    }));
    const requestOptions: any = await entered.promise;
    controller.abort(new Error("fixture cancellation"));

    await expect(resultPromise).rejects.toThrow("fixture cancellation");
    expect(requestOptions.signal.aborted).toBe(true);
    expect(dispatcherState.dispatchers[0].destroy).toHaveBeenCalledOnce();
    expect(await fs.readdir(rootDir)).not.toContain("cancel-headers.bin");
    expect((await fs.readdir(rootDir)).some((entry?: any) : any => entry.includes(".part-"))).toBe(false);
  });

  it("cancels a held body stream and removes only its private partial file", async () : Promise<any> => {
    const entered: any = deferred();
    const controller: any = new AbortController();
    const dispatcherState: any = dispatcherFixture();
    const outputPath: any = path.join(rootDir, "cancel-body.bin");
    let bodyCancelled: any = false;
    const body = new ReadableStream({
      cancel() : any {
        bodyCancelled = true;
      }
    });
    const fetchImpl: any = vi.fn((_url?: any, init?: any) : any => {
      entered.resolve(init);
      return Promise.resolve(new Response(body, { status: 200 }));
    });
    const resultPromise: any = fetchCommand(await fetchOptions(outputPath, {
      signal: controller.signal,
      fetchImpl,
      dispatcherFactory: dispatcherState.factory
    }));
    const requestOptions: any = await entered.promise;
    await waitFor(async () : Promise<any> => (await fs.readdir(rootDir)).some((entry?: any) : any => entry.includes(".part-")));
    controller.abort(new Error("fixture body cancellation"));

    await expect(resultPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(requestOptions.signal.aborted).toBe(true);
    expect(bodyCancelled).toBe(true);
    expect(dispatcherState.dispatchers[0].destroy).toHaveBeenCalledOnce();
    expect(await fs.readdir(rootDir)).not.toContain("cancel-body.bin");
    expect((await fs.readdir(rootDir)).some((entry?: any) : any => entry.includes(".part-"))).toBe(false);
  });

  it("retains digest, size, and exclusive existing-output safeguards", async () : Promise<any> => {
    const dispatcherState: any = dispatcherFixture();
    const failedPath: any = path.join(rootDir, "http-failure.bin");
    await expect(fetchCommand(await fetchOptions(failedPath, {
      dispatcherFactory: dispatcherState.factory,
      fetchImpl: async () : Promise<any> => new Response(JSON.stringify({ error: { message: "synthetic upstream failure" } }), { status: 502 })
    }))).rejects.toThrow(/synthetic upstream failure/iu);
    expect(await fs.readdir(rootDir)).not.toContain("http-failure.bin");

    const mismatchPath: any = path.join(rootDir, "digest-mismatch.bin");
    process.env[TOKEN_ENV] = API_KEY;
    await expect(fetchCommand(await fetchOptions(mismatchPath, {
      dispatcherFactory: dispatcherState.factory,
      fetchImpl: async () : Promise<any> => new Response("wrong bytes", {
        status: 200,
        headers: { digest: "sha-256=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" }
      })
    }))).rejects.toThrow(/Digest header did not match/iu);
    expect(await fs.readdir(rootDir)).not.toContain("digest-mismatch.bin");

    const oversizedPath: any = path.join(rootDir, "oversized.bin");
    process.env[TOKEN_ENV] = API_KEY;
    await expect(fetchCommand(await fetchOptions(oversizedPath, {
      dispatcherFactory: dispatcherState.factory,
      fetchImpl: async () : Promise<any> => new Response(null, {
        status: 200,
        headers: { "content-length": String(MCP_FETCH_MAX_ARTIFACT_BYTES + 1) }
      })
    }))).rejects.toThrow(/2 GiB/iu);
    expect(await fs.readdir(rootDir)).not.toContain("oversized.bin");

    const existingPath: any = path.join(rootDir, "existing.bin");
    await fs.writeFile(existingPath, "existing user data");
    process.env[TOKEN_ENV] = API_KEY;
    await expect(fetchCommand(await fetchOptions(existingPath, {
      dispatcherFactory: dispatcherState.factory,
      fetchImpl: async () : Promise<any> => new Response("replacement", { status: 200 })
    }))).rejects.toThrow(/already exists/iu);
    expect(await fs.readFile(existingPath, "utf8")).toBe("existing user data");
    expect((await fs.readdir(rootDir)).some((entry?: any) : any => entry.includes(".part-"))).toBe(false);
  });

  it("maps SIGINT into owned cancellation and removes the temporary signal listeners", async () : Promise<any> => {
    const signalSource: any = new EventEmitter();
    const running: any = runWithOwnedProcessSignals(({ signal }: Record<string, any>) : any => new Promise((resolve?: any) : any => {
      signal.addEventListener("abort", () : any => resolve(signal.reason), { once: true });
    }), {}, signalSource);
    signalSource.emit("SIGINT");
    await expect(running).resolves.toMatchObject({ name: "AbortError", code: "SIGINT" });
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });

  it("cancels proxy work on stdin EOF and owned process termination", async () : Promise<any> => {
    const stdin: any = new PassThrough();
    const writes: any[] = [];
    const started: any = deferred();
    let forwardedSignal: any;
    const forwarding: any = ({ signal }: Record<string, any>) : any => {
      forwardedSignal = signal;
      started.resolve(null);
      return new Promise((_resolve?: any, reject?: any) : any => {
        signal.addEventListener("abort", () : any => reject(signal.reason), { once: true });
      });
    };
    const commandPromise: any = proxyCommand({
      target: "codex",
      "token-env": TOKEN_ENV,
      url: baseUrl,
      stdin,
      writeMessage(payload?: any) : any {
        writes.push(payload);
      },
      forwardMessage: forwarding
    });
    await waitFor(() : any => stdin.listenerCount("data") > 0);
    stdin.write('{"jsonrpc":"2.0","id":"eof-request","method":"tools/list"}\n');
    await started.promise;
    stdin.end();
    await expect(commandPromise).resolves.toMatchObject({ ok: true, proxy: "closed" });
    expect(forwardedSignal.aborted).toBe(true);
    expect(writes).toEqual([]);

    const secondStdin: any = new PassThrough();
    const stdinReady: any = deferred();
    const commandFinished: any = deferred();
    const noteDataListener: any = (eventName?: any) : any => {
      if (eventName === "data") stdinReady.resolve(null);
    };
    secondStdin.on("newListener", noteDataListener);
    process.env[TOKEN_ENV] = API_KEY;
    await saveMcpApiKeyCredential({ target: "codex", baseUrl, token: API_KEY, autoUpdate: true });
    await expect(loadMcpConnectorPreferences({ target: "codex", baseUrl })).resolves.toEqual({ autoUpdate: true });
    await expect(resolveProxyCredentials({ target: "codex", "token-env": TOKEN_ENV, url: baseUrl })).resolves.toMatchObject({ autoUpdate: true });
    process.env[TOKEN_ENV] = API_KEY;
    const signalSource: any = new EventEmitter();
    const subscriptionStarted: any = deferred();
    const signalStarted: any = deferred();
    const subscriptionClosed: any = deferred();
    onMcpSubscription = (response?: any) : any => {
      subscriptionStarted.resolve({ type: "subscription-started" });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(": connected\n\n");
      response.once("close", () : any => subscriptionClosed.resolve(null));
    };
    let processSignal: any;
    const processCommand: any = runWithOwnedProcessSignals((ownedOptions?: any) : any => proxyCommand({
      target: "codex",
      "token-env": TOKEN_ENV,
      url: baseUrl,
      stdin: secondStdin,
      writeMessage() : any {},
      forwardMessage({ signal }: Record<string, any>) : any {
        processSignal = signal;
        signalStarted.resolve(null);
        return new Promise((_resolve?: any, reject?: any) : any => {
          signal.addEventListener("abort", () : any => reject(signal.reason), { once: true });
        });
      },
      signal: ownedOptions.signal
    }), {}, signalSource);
    void processCommand.then(
      (value?: any) : any => commandFinished.resolve({ type: "completed", value }),
      (error?: any) : any => commandFinished.resolve({ type: "failed", error })
    );
    const stdinSetup: any = await Promise.race([
      stdinReady.promise.then(() : any => ({ type: "stdin-ready" })),
      commandFinished.promise
    ]);
    secondStdin.removeListener("newListener", noteDataListener);
    if (stdinSetup.type === "failed") throw stdinSetup.error;
    if (stdinSetup.type === "completed") throw new Error("The proxy command ended before it began reading stdin.");
    const subscriptionSetup: any = await Promise.race([subscriptionStarted.promise, commandFinished.promise]);
    if (subscriptionSetup.type === "failed") throw subscriptionSetup.error;
    if (subscriptionSetup.type === "completed") throw new Error("The proxy command ended before the update subscription connected.");
    secondStdin.write('{"jsonrpc":"2.0","id":"signal-request","method":"tools/list"}\n');
    await signalStarted.promise;
    signalSource.emit("SIGTERM");
    await expect(processCommand).resolves.toMatchObject({ ok: true, proxy: "closed" });
    await subscriptionClosed.promise;
    expect(processSignal.aborted).toBe(true);
    expect(signalSource.listenerCount("SIGINT")).toBe(0);
    expect(signalSource.listenerCount("SIGTERM")).toBe(0);
  });
});
