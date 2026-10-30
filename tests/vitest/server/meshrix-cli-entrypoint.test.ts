import path from "node:path";
import { createServer } from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeBaseUrl, readHeaders, requestJson, requestRaw } from "../../../apps/server/bin/lib/meshrix-cli-common.ts";
import { listInterfaceCatalog } from "../../../packages/contracts/src/operations/operation-registry.ts";

const repoRoot: any = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const cliEntrypoint: any = path.join(repoRoot, "apps", "server", "bin", "meshrix.ts");

describe("meshrix public CLI entrypoint", () : any => {
  it("delegates to the canonical command dispatcher", () : any => {
    const result: any = spawnSync(process.execPath, [cliEntrypoint, "--help"], {
      cwd: repoRoot,
      encoding: "utf8"
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("meshrix rpc-call jobs.list");
    expect(result.stdout).toContain("meshrix tools catalog");
    expect(result.stdout).toContain("meshrix secret init --target-file TARGET.json --json-stdin");
    expect(result.stdout).toContain("--expected-revision N");
    expect(result.stdout).not.toContain("[--api-key KEY]");
  });

  it("renders the packaged interface catalog without a running server", () : any => {
    const result: any = spawnSync(
      process.execPath,
      [cliEntrypoint, "interfaces", "--format", "markdown", "--server-url", "http://127.0.0.1:1"],
      {
        cwd: repoRoot,
        encoding: "utf8"
      }
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("jobs.list");
  });

  it.each(["Authorization", "Cookie", "Proxy-Authorization", "X-Api-Key", "X-Auth-Token"])(
    "rejects secret-bearing %s headers from argv without echoing their values",
    (headerName?: any) : any => {
      const marker: any = "do-not-echo-this-value";

      expect(() : any => readHeaders({ header: [`${headerName}: ${marker}`] })).toThrowError(
        new RegExp(`敏感请求头 ${headerName}`, "i")
      );

      try {
        readHeaders({ header: [`${headerName}: ${marker}`] });
      } catch (error: any) {
        expect(String(error)).not.toContain(marker);
      }
    }
  );

  it.each([
    "X-Meshrix.js-Api-Key",
    "X-Meshrix-Api-Key",
    "X-Meshrix-Tool-Token",
    "X-Meshrix-Capability-Key",
    "X-Meshrix-Claim-Token",
    "X-Meshrix-CSRF",
    "X-Meshrix-Signature"
  ])("rejects Meshrix credential header %s from argv", (headerName?: any) : any => {
    expect(() => readHeaders({ header: [`${headerName}: synthetic-value`] })).toThrowError(/敏感请求头/);
  });

  it("requires HTTPS for remote server URLs and permits literal loopback HTTP", () : any => {
    const embeddedCredentialUrl = new URL("http://127.0.0.1");
    const cannedUser = ["synthetic", "user"].join("-");
    const canned3 = ["synthetic", "password"].join("-");
    embeddedCredentialUrl.username = cannedUser;
    embeddedCredentialUrl.password = canned3;
    expect(() => normalizeBaseUrl("http://meshrix.example"))
      .toThrowError("server_url_remote_requires_https");
    expect(() => normalizeBaseUrl(embeddedCredentialUrl.toString()))
      .toThrowError("server_url_credentials_or_query_forbidden");
    expect(normalizeBaseUrl("http://127.0.0.2:8080")).toBe("http://127.0.0.2:8080");
    expect(normalizeBaseUrl("http://[::1]:8080")).toBe("http://[::1]:8080");
  });

  it("does not follow an authenticated redirect to another local origin", async () : Promise<void> => {
    let redirectRequests = 0;
    let forwardedCsrfHeaders = 0;
    const target = createServer((_request, response) => {
      redirectRequests += 1;
      if (_request.headers["x-meshrix-csrf"]) forwardedCsrfHeaders += 1;
      response.end("unexpected");
    });
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("test_target_address_unavailable");

    const source = createServer((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${targetAddress.port}/collect` });
      response.end();
    });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    const sourceAddress = source.address();
    if (!sourceAddress || typeof sourceAddress === "string") throw new Error("test_source_address_unavailable");

    const previousCsrf = process.env.MESHRIX_CONSOLE_CSRF;
    process.env.MESHRIX_CONSOLE_CSRF = "synthetic-session-csrf";
    try {
      await expect(requestRaw({
        serverUrl: `http://127.0.0.1:${sourceAddress.port}`,
        method: "GET",
        apiPath: "/redirect"
      })).rejects.toThrow("GET request failed: 302");
      expect(redirectRequests).toBe(0);
      expect(forwardedCsrfHeaders).toBe(0);
    } finally {
      if (previousCsrf === undefined) delete process.env.MESHRIX_CONSOLE_CSRF;
      else process.env.MESHRIX_CONSOLE_CSRF = previousCsrf;
      await Promise.all([
        new Promise<void>((resolve, reject) => source.close((error) => error ? reject(error) : resolve())),
        new Promise<void>((resolve, reject) => target.close((error) => error ? reject(error) : resolve()))
      ]);
    }
  });

  it("does not include server error bodies or request URLs in CLI failures", async () : Promise<void> => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("synthetic-private-server-error");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_listener_address_missing");
    try {
      let failure: unknown;
      try {
        await requestRaw({
          serverUrl: `http://127.0.0.1:${address.port}`,
          method: "GET",
          apiPath: "/error?request=synthetic"
        });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toContain("GET request failed: 500");
      expect(String(failure)).not.toContain("synthetic-private-server-error");
      expect(String(failure)).not.toContain("/error?request=synthetic");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("does not include malformed successful response content or request URLs in CLI failures", async () : Promise<void> => {
    const responseMarker = "synthetic-private-response-fragment";
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(`{"detail":"${responseMarker}"`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_listener_address_missing");
    try {
      let failure: unknown;
      try {
        await requestJson({
          serverUrl: `http://127.0.0.1:${address.port}`,
          method: "GET",
          apiPath: "/malformed?request=synthetic"
        });
      } catch (error) {
        failure = error;
      }
      expect(String(failure)).toBe("Error: server_response_invalid_json");
      expect(String(failure)).not.toContain(responseMarker);
      expect(String(failure)).not.toContain("/malformed?request=synthetic");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("routes named gateway commands to the registry-selected operation, not the embedded profile", async () : Promise<void> => {
    const observed: Array<{ method?: string; url?: string }> = [];
    const server = createServer((request, response) => {
      observed.push({ method: request.method, url: request.url });
      if (request.url === "/api/interfaces") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ interfaces: listInterfaceCatalog() }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ result: "ok" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture_listener_address_missing");
    try {
      const child: any = spawn(
        process.execPath,
        [cliEntrypoint, "gateway", "forward", "--body", "{}", "--server-url", `http://127.0.0.1:${address.port}`],
        { cwd: repoRoot }
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: any) => { stdout += chunk; });
      child.stderr?.on("data", (chunk: any) => { stderr += chunk; });
      const exitCode: any = await new Promise((resolve, reject) => {
        const timer: any = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error("cli_spawn_timeout"));
        }, 55000);
        child.on("error", (error: any) => { clearTimeout(timer); reject(error); });
        child.on("close", (code: any) => { clearTimeout(timer); resolve(code); });
      });
      expect(exitCode).toBe(0);
      expect(stdout).not.toContain('"profile":"gateway-only"');
      expect(stderr).toBe("");
      expect(observed).toContainEqual({ method: "POST", url: "/api/gateway/v1/forward" });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("keeps the bare embedded gateway profile invocation on the embedded path", () : any => {
    const result: any = spawnSync(
      process.execPath,
      [cliEntrypoint, "gateway", "--dry-run"],
      { cwd: repoRoot, encoding: "utf8", timeout: 60000 }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"profile":"gateway-only"');
  });
});
