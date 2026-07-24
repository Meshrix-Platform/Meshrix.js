#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION,
  DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS,
  McpAgentFrameworkAdapterLayer,
  assembleDownstreamClientAspect,
  createDownstreamClientAspectService,
  defaultDownstreamClientFrameworks,
  resolveCommandCandidate
} from "../../packages/protocols/downstream-client-aspect/index.mjs";

const FIXTURE_FRAMEWORK = Object.freeze({
  frameworkId: "fixture-client",
  label: "Fixture Client",
  kind: "cli",
  commandNames: ["fixture-client"],
  mcp: {
    adapterId: "fixture-mcp-adapter",
    profileId: "meshrix.mcp.fixture-client",
    installMode: "external-client-adapter",
    locations: ["local"],
    configurationStrategy: "external-adapter-package",
    serverName: "meshrix",
    commandNames: ["fixture-client"]
  }
});

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-downstream-mcp-aspect-"));
try {
  const fixtureBin = path.join(tempRoot, "bin");
  await fs.mkdir(fixtureBin, { recursive: true });
  const executableName = (name) => path.join(fixtureBin, process.platform === "win32" ? `${name}.cmd` : name);
  for (const name of ["fixture-client"]) {
    const filePath = executableName(name);
    await fs.writeFile(filePath, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
    if (process.platform !== "win32") await fs.chmod(filePath, 0o755);
  }
  const envWithAgentBins = { ...process.env, PATH: fixtureBin };

  assert.deepEqual(defaultDownstreamClientFrameworks(), []);
  assert.equal(defaultDownstreamClientFrameworks([FIXTURE_FRAMEWORK]).at(0)?.frameworkId, "fixture-client");
  assert.equal(resolveCommandCandidate(["fixture-client"], { env: envWithAgentBins, includeDefaultLocalBin: false }).found, true);

  const { service, summary, capabilities } = assembleDownstreamClientAspect({
    frameworks: [FIXTURE_FRAMEWORK],
    env: envWithAgentBins,
    includeDefaultLocalBin: false,
    start: { now: new Date("2026-06-05T00:00:00.000Z") }
  });
  assert.equal(summary.ok, true);
  assert.equal(summary.protocolVersion, DOWNSTREAM_CLIENT_ASPECT_PROTOCOL_VERSION);
  assert.equal(summary.frameworkCount, 1);
  assert.equal(summary.layerCount, 1);
  assert.equal(summary.assemblyCount, 1);
  assert.deepEqual(summary.routeTargets, DOWNSTREAM_CLIENT_ASPECT_ROUTE_TARGETS);
  assert.equal(capabilities.every((record) => record.protocol === "mcp"), true);
  assert.equal(capabilities.every((record) => record.capabilities.toolBoundary === "v0.0.1:operation-permission:projection-1"), true);

  const route = service.translateInboundRequest({
    protocol: "mcp", frameworkId: "fixture-client", method: "tools/call", input: { name: "meshrix.discovery" }
  });
  assert.equal(route.ok, true);
  assert.equal(route.routeTarget, "mcp-server-side");
  assert.equal(service.translateInboundRequest({ protocol: "unsupported" }).reasonCode, "downstream_protocol_not_supported");

  const missingService = createDownstreamClientAspectService({
    frameworks: [FIXTURE_FRAMEWORK],
    env: { ...process.env, PATH: "" }, includeDefaultLocalBin: false
  });
  missingService.start({ now: new Date("2026-06-05T00:00:00.000Z") });
  const missingFixture = missingService.listCapabilities({ protocol: "mcp", frameworkId: "fixture-client" }).at(0);
  assert.equal(missingFixture.status, "assembled");
  assert.equal(missingFixture.commandProbe.found, false);
  assert.equal(JSON.stringify(missingFixture).includes(fixtureBin), false);

  const layer = new McpAgentFrameworkAdapterLayer();
  assert.equal(layer.supports(defaultDownstreamClientFrameworks([FIXTURE_FRAMEWORK]).at(0)), true);
  console.log("[downstream-client-aspect] ok");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
