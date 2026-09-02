import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS,
  loadNativeOrbDeploymentStageScript,
  parseNativeOrbDeploymentArgs,
  resolveServiceNodeExecutable,
  runNativeOrbDeploymentStageScripts,
} from "../../../tools/server-scripts/native-orb-deploy.ts";
import {
  NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS,
  assertBootstrapCleanupState,
  BOOTSTRAP_SECRET_PROVISION_SCRIPT,
  bootstrapNativeOrb,
  buildBootstrapRuntimeConfig,
  buildBootstrapSystemdUnit,
  BOOTSTRAP_REQUIRED_PACKAGES,
  deriveBootstrapLayout,
  assertRuntimeEngineCompatible,
  assertBootstrapUnitResumeState,
  loadPrivateBootstrapCredentialBytes,
  parseNativeOrbBootstrapArgs,
  parseBootstrapTargetFacts,
  runNativeOrbBootstrapStageScripts,
  validateCandidateRuntimeLock,
} from "../../../tools/server-scripts/native-orb-bootstrap.ts";
import { assertExistingServiceActive } from "../../../tools/server-scripts/lib/native-orb-deployment/stages/runtime.ts";
import {
  probeBootstrapOrigin,
  writeNativeOrbBootstrapReceipt,
} from "../../../tools/server-scripts/lib/native-orb-bootstrap/support.ts";
import {
  assertInactiveReleaseMutation,
  assertRollbackServiceRestored,
  candidateArchive,
  probeNativeOrbOrigin,
  writeNativeOrbProductionUseReceipt,
} from "../../../tools/server-scripts/lib/native-orb-deployment/support.ts";
import { assertNoSensitiveReportLeak } from "../../../tools/server-scripts/lib/sensitive-report-scan.ts";

describe("native OrbStack deployment", () : any => {
  it("owns a separate exact ten-stage clean-target bootstrap", async () : Promise<any> => {
    expect(NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS).toEqual([
      { id: "target", script: "./stages/target.ts", dependsOn: [] },
      { id: "candidate", script: "./stages/candidate.ts", dependsOn: ["target"] },
      { id: "runtime", script: "./stages/runtime.ts", dependsOn: ["candidate"] },
      { id: "install", script: "./stages/install.ts", dependsOn: ["runtime"] },
      { id: "dependencies", script: "./stages/dependencies.ts", dependsOn: ["install"] },
      { id: "build", script: "./stages/build.ts", dependsOn: ["dependencies"] },
      { id: "configure", script: "./stages/configure.ts", dependsOn: ["build"] },
      { id: "owner", script: "./stages/owner.ts", dependsOn: ["configure"] },
      { id: "activate", script: "./stages/activate.ts", dependsOn: ["owner"] },
      { id: "verify", script: "./stages/verify.ts", dependsOn: ["activate"] },
    ]);
    const calls: any[] = [];
    const results: any = await runNativeOrbBootstrapStageScripts({
      context: {},
      loadStage: async (stage?: any) : Promise<any> => ({
        runNativeOrbBootstrapStage: async () : Promise<any> => {
          calls.push(stage.id);
          return { id: stage.id, status: stage.id === "target" ? "resumed" : "completed" };
        }
      })
    });
    expect(calls).toEqual(NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS.map((stage?: any) : any => stage.id));
    expect(results).toHaveLength(10);
    expect(JSON.stringify(NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS)).not.toMatch(/plugin|optional|provider|gateway|agent/iu);
  });

  it("parses the closed bootstrap interface and derives the fixed Core layout", () : any => {
    expect(parseNativeOrbBootstrapArgs([
      "--machine", "meshrix-vm", "--origin", "https://meshrix.internal.example:7228",
      "--candidate", "b".repeat(40), "--login-input", "<input-file>"
    ])).toMatchObject({ machine: "meshrix-vm", sourceRevision: "b".repeat(40), loginInput: "<input-file>" });
    expect(() : any => parseNativeOrbBootstrapArgs([
      "--machine", "meshrix-vm", "--origin", "https://meshrix.internal.example:7228/path",
      "--candidate", "b".repeat(40), "--login-input", "<input-file>"
    ])).toThrow(/port 7228/u);
    const fixtureHome: any = "/<user-home>";
    const layout: any = deriveBootstrapLayout(fixtureHome, "b".repeat(40), "v24.16.0");
    expect(layout.currentDirectory).toBe("/<user-home>/.local/share/meshrix-js/current");
    expect(layout.releasesDirectory).toBe("/<user-home>/.local/share/meshrix-js/releases");
    expect(layout.dataDirectory).not.toContain(layout.currentDirectory);
    expect(layout.masterKeyPath).not.toBe(layout.proofSignerPath);
    const config: any = JSON.parse(buildBootstrapRuntimeConfig("https://meshrix.internal.example:7228"));
    expect(config.runtime.enabledPlugins).toEqual([]);
    expect(Object.values(config.discovery)).toEqual(Array(3).fill("https://meshrix.internal.example:7228"));
    expect(() : any => assertRuntimeEngineCompatible("v24.16.0", ">=22.18.0 <23 || >=24.3.0")).not.toThrow();
    const unit: any = buildBootstrapSystemdUnit(layout, "/<user-home>/.local/lib/meshrix-js/runtime/v24.16.0/bin/node");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("WorkingDirectory=/<user-home>/.local/share/meshrix-js/current");
    expect(unit).toContain("--with-ui --profile core --host 0.0.0.0 --allow-public-console --port 7228 --strict-port");
    expect(unit).toContain("MESHRIX_OPERATION_PROOF_EVIDENCE_POLICY=production");
  });

  it("rejects multiline target facts instead of truncating target identity", () : any => {
    expect(parseBootstrapTargetFacts("ubuntu\nx86_64\nno\n/user-home")).toEqual({
      distribution: "ubuntu",
      architecture: "x86_64",
      linger: "no",
      home: "/user-home",
    });
    expect(() : any => parseBootstrapTargetFacts("ubuntu\nx86_64\nno\n/user-home\n/injected"))
      .toThrowError(expect.objectContaining({ code: "native_orb_bootstrap_target_unsupported" }));
    expect(() : any => parseBootstrapTargetFacts("ubuntu\nx86_64\nno\n/user-home\r"))
      .toThrowError(expect.objectContaining({ code: "native_orb_bootstrap_target_unsupported" }));
  });

  it("admits an inactive bootstrap unit only with exact resumable fixed state", () : any => {
    expect(() : any => assertBootstrapUnitResumeState({
      existingBootstrapUnit: true,
      fixedState: "resumable",
    })).not.toThrow();
    expect(() : any => assertBootstrapUnitResumeState({
      existingBootstrapUnit: true,
      fixedState: "clean",
    })).toThrowError(expect.objectContaining({ code: "native_orb_bootstrap_service_exists" }));
  });

  it("fully validates the candidate runtime lock before any authenticated download", () : any => {
    const lock: any = JSON.parse(fs.readFileSync("tools/release/node-runtime.lock.json", "utf8"));
    expect(validateCandidateRuntimeLock(lock, "linux-x64")).toMatchObject({
      filename: expect.stringContaining("linux-x64"),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
      sizeBytes: expect.any(Number),
    });
    expect(() : any => validateCandidateRuntimeLock({
      ...lock,
      signer: { ...lock.signer, publicKeyUrl: "https://untrusted.example.invalid/key.asc" },
    }, "linux-x64")).toThrowError(expect.objectContaining({
      code: "native_orb_bootstrap_runtime_lock_invalid",
    }));
    expect(() : any => validateCandidateRuntimeLock({ ...lock, unknownField: true }, "linux-x64"))
      .toThrowError(expect.objectContaining({ code: "native_orb_bootstrap_runtime_lock_invalid" }));
    expect(() : any => validateCandidateRuntimeLock({
      ...lock,
      targets: {
        ...lock.targets,
        "linux-x64": {
          ...lock.targets["linux-x64"],
          filename: lock.targets["linux-arm64"].filename,
        },
      },
    }, "linux-x64")).toThrowError(expect.objectContaining({
      code: "native_orb_bootstrap_runtime_lock_invalid",
    }));
  });

  it("preflights one strict private owner serialization before any target stage", async () : Promise<any> => {
    const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-native-owner-preflight-"));
    const inputPath: any = path.join(root, "owner.json");
    const linkPath: any = path.join(root, "owner-link.json");
    const expected: any = { username: "owner", password: "private-owner-credential" };
    try {
      fs.writeFileSync(inputPath, JSON.stringify(expected), { mode: 0o600 });
      const bootstrapBytes: any = await loadPrivateBootstrapCredentialBytes(inputPath);
      try {
        expect(JSON.parse(bootstrapBytes.toString("utf8"))).toEqual(expected);
      } finally {
        bootstrapBytes.fill(0);
      }

      fs.symlinkSync(inputPath, linkPath);
      await expect(loadPrivateBootstrapCredentialBytes(linkPath)).rejects.toThrow(/file_unsafe/u);
      await expect(bootstrapNativeOrb({
        repoRoot: process.cwd(),
        machine: "meshrix-vm",
        publicOrigin: "https://meshrix.internal.example:7228",
        sourceRevision: "b".repeat(40),
        loginInput: path.join(root, "missing.json"),
      })).rejects.toMatchObject({ code: "native_orb_bootstrap_login_input_invalid" });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not reject a healthy deployment because response bodies exceed an arbitrary size", async () : Promise<any> => {
    const requests: any[] = [];
    const server: any = http.createServer((request?: any, response?: any) : any => {
      requests.push(request.url);
      if (request.url === "/api/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true, detail: "x".repeat(96 * 1024) }));
        return;
      }
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(`<!doctype html><html><body>${"console".repeat(16 * 1024)}</body></html>`);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve?: any) : any => server.listen(0, "127.0.0.1", resolve));
    const address: any = server.address();
    try {
      await expect(probeNativeOrbOrigin(`http://127.0.0.1:${address.port}`))
        .resolves.toMatchObject({
          healthOk: true,
          consoleOk: true,
        });
      expect(requests).toEqual(["/api/healthz", "/"]);
    } finally {
      await new Promise<void>((resolve?: any) : any => server.close(resolve));
    }
  });

  it("keeps owner admission and authenticated read inside clean bootstrap", async () : Promise<any> => {
    const server: any = http.createServer((request?: any, response?: any) : any => {
      if (request.url === "/api/healthz") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url === "/") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<!doctype html><html><body>console</body></html>");
        return;
      }
      if (request.url === "/api/auth/login") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "meshrix_session=private-session; HttpOnly; SameSite=Strict",
        });
        response.end(JSON.stringify({ csrfToken: "csrf-token" }));
        return;
      }
      if (request.url === "/api/console/state") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve?: any) : any => server.listen(0, "127.0.0.1", resolve));
    const address: any = server.address();
    const credentials: any = Buffer.from(JSON.stringify({
      username: "owner",
      password: "private-owner-credential",
    }), "utf8");
    try {
      await expect(probeBootstrapOrigin(`http://127.0.0.1:${address.port}`, credentials))
        .resolves.toEqual({
          health: "healthy",
          console: "available",
          authentication: "authenticated",
          governedRead: "authorized",
        });
    } finally {
      credentials.fill(0);
      await new Promise<void>((resolve?: any) : any => server.close(resolve));
    }
  });

  it("creates two exact distinct production secrets and rejects non-exact custody", () : any => {
    const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-native-secrets-"));
    const first: any = path.join(root, "master-key");
    const second: any = path.join(root, "proof-signer");
    try {
      const created: any = spawnSync(process.execPath, [
        "-e",
        BOOTSTRAP_SECRET_PROVISION_SCRIPT,
        first,
        second,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(created.status).toBe(0);
      const firstValue: any = fs.readFileSync(first, "utf8");
      const secondValue: any = fs.readFileSync(second, "utf8");
      expect(firstValue).toMatch(/^[a-f0-9]{64}$/u);
      expect(secondValue).toMatch(/^[a-f0-9]{64}$/u);
      expect(firstValue).not.toBe(secondValue);
      expect(fs.statSync(first).mode & 0o777).toBe(0o600);
      expect(fs.statSync(second).mode & 0o777).toBe(0o600);

      fs.writeFileSync(first, `${firstValue}\n`, { mode: 0o600 });
      const rejected: any = spawnSync(process.execPath, [
        "-e",
        BOOTSTRAP_SECRET_PROVISION_SCRIPT,
        first,
        second,
      ], { encoding: "utf8", timeout: 15_000 });
      expect(rejected.status).not.toBe(0);
      expect(fs.readFileSync(first, "utf8")).toBe(`${firstValue}\n`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reuses a candidate archive only after proving exact Git-object bytes", () : any => {
    const root: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-native-candidate-"));
    const cacheRoot: any = path.join(root, "cache");
    const gitEnvironment: any = {
      ...process.env,
      GIT_AUTHOR_NAME: "Meshrix Test",
      GIT_AUTHOR_EMAIL: "meshrix-test@example.invalid",
      GIT_COMMITTER_NAME: "Meshrix Test",
      GIT_COMMITTER_EMAIL: "meshrix-test@example.invalid",
    };
    const git = (args: string[]) : any => spawnSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: gitEnvironment,
      timeout: 15_000,
    });
    try {
      expect(git(["init", "-q"]).status).toBe(0);
      fs.writeFileSync(path.join(root, "package.json"), "{\"name\":\"meshrix.js\"}\n", "utf8");
      expect(git(["add", "package.json"]).status).toBe(0);
      expect(git(["commit", "-q", "-m", "fixture"]).status).toBe(0);
      const revision: any = String(git(["rev-parse", "HEAD"]).stdout || "").trim();

      const first: any = candidateArchive(root, revision, { cacheRoot });
      const expectedDigest: any = createHash("sha256").update(fs.readFileSync(first.archivePath)).digest("hex");
      expect(first.resumed).toBe(false);
      expect(candidateArchive(root, revision, { cacheRoot }).resumed).toBe(true);

      fs.appendFileSync(first.archivePath, "tampered-cache", "utf8");
      const repaired: any = candidateArchive(root, revision, { cacheRoot });
      expect(repaired.resumed).toBe(false);
      expect(createHash("sha256").update(fs.readFileSync(repaired.archivePath)).digest("hex"))
        .toBe(expectedDigest);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes a closed privacy-safe bootstrap receipt", async () : Promise<any> => {
    const repoRoot: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-native-bootstrap-receipt-"));
    try {
      const stages: any = NATIVE_ORB_BOOTSTRAP_STAGE_SCRIPTS.map((stage?: any) : any => ({ id: stage.id, status: "completed" }));
      const report: any = await writeNativeOrbBootstrapReceipt({
        repoRoot,
        sourceRevision: "c".repeat(40),
        candidateDigest: `sha256:${"d".repeat(64)}`,
        probe: {
          health: "healthy", console: "available", authentication: "authenticated", governedRead: "authorized",
          candidateActive: true, serviceActive: true, serviceEnabled: true
        }
      }, stages);
      expect(Object.keys(report).sort()).toEqual([
        "authentication", "candidate", "candidateActive", "candidateDigest", "console", "governedRead",
        "health", "schemaVersion", "serviceActive", "serviceEnabled", "stages", "url", "verifier"
      ].sort());
      expect(JSON.stringify(report)).not.toMatch(/machine|origin|password|secret|cookie|path|backend|log/iu);
      expect(report.url).toBe("<server-url>");
      expect(() : any => assertNoSensitiveReportLeak(report, "native bootstrap fixture")).not.toThrow();
      expect(() : any => assertNoSensitiveReportLeak({
        ...report,
        targetPath: "/private/operator/path",
      }, "unsafe native bootstrap fixture")).toThrow();
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("writes a credential-free production upgrade receipt", async () : Promise<any> => {
    const repoRoot: any = fs.mkdtempSync(path.join(os.tmpdir(), "meshrix-native-upgrade-receipt-"));
    try {
      await writeNativeOrbProductionUseReceipt({
        repoRoot,
        sourceRevision: "c".repeat(40),
        candidateDigest: "d".repeat(64),
        existingServiceActiveBeforeUpgrade: true,
        probe: {
          healthOk: true,
          consoleOk: true,
          candidateActive: true,
          serviceActive: true,
        },
      });
      const report: any = JSON.parse(fs.readFileSync(
        path.join(repoRoot, "build", "reports", "native-orb-production-use.json"),
        "utf8",
      ));
      expect(report).toMatchObject({
        schemaVersion: "v0.0.1:deployment:native-orb-production-use-report-2",
        healthOk: true,
        consoleOk: true,
        candidateActive: true,
        serviceActive: true,
        releaseReady: true,
      });
      expect(JSON.stringify(report)).not.toMatch(/authentication|credential|governedOperation|password/iu);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("provisions clean-target prerequisites and proves failed activation cleanup", () : any => {
    expect(BOOTSTRAP_REQUIRED_PACKAGES).toEqual([
      "ca-certificates", "xz-utils", "python3", "make", "g++"
    ]);
    expect(() : any => assertBootstrapCleanupState({
      activeState: "inactive",
      enabledState: "not-found",
    })).not.toThrow();
    expect(() : any => assertBootstrapCleanupState({
      activeState: "active",
      enabledState: "enabled",
    })).toThrowError(expect.objectContaining({ code: "native_orb_bootstrap_cleanup_in_doubt" }));
  });

  it("requires an explicit machine and one-origin address", () : any => {
    expect(parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7228",
      "--candidate",
      "a".repeat(40),
    ])).toEqual({
      machine: "meshrix-vm",
      publicOrigin: "http://meshrix-vm.internal.example:7228",
      sourceRevision: "a".repeat(40),
    });
    expect(() : any => parseNativeOrbDeploymentArgs([]))
      .toThrow(/OrbStack machine/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7229",
      "--candidate",
      "a".repeat(40),
    ])).toThrow(/port 7228/);
  });

  it("requires the pre-existing service to be active before upgrade work", () : any => {
    expect(() : any => assertExistingServiceActive("active")).not.toThrow();
    for (const state of ["", "inactive", "failed", "activating"]) {
      expect(() : any => assertExistingServiceActive(state)).toThrowError(expect.objectContaining({
        code: "native_orb_existing_service_inactive",
      }));
    }
  });

  it("does not mutate an active release and proves rollback restoration", () : any => {
    expect(() : any => assertInactiveReleaseMutation({
      activeWorkingDirectory: "release-current",
      releaseDirectory: "release-current",
      ready: true,
    })).not.toThrow();
    expect(() : any => assertInactiveReleaseMutation({
      activeWorkingDirectory: "release-previous",
      releaseDirectory: "release-current",
      ready: false,
    })).not.toThrow();
    expect(() : any => assertInactiveReleaseMutation({
      activeWorkingDirectory: "release-current",
      releaseDirectory: "release-current",
      ready: false,
    })).toThrowError(expect.objectContaining({ code: "native_orb_active_release_mutation_forbidden" }));

    expect(() : any => assertRollbackServiceRestored({
      activeWorkingDirectory: "release-previous",
      expectedWorkingDirectory: "release-previous",
      serviceState: "active",
    })).not.toThrow();
    for (const state of [
      { activeWorkingDirectory: "release-current", serviceState: "active" },
      { activeWorkingDirectory: "release-previous", serviceState: "failed" },
    ]) {
      expect(() : any => assertRollbackServiceRestored({
        ...state,
        expectedWorkingDirectory: "release-previous",
      })).toThrowError(expect.objectContaining({ code: "native_orb_rollback_failed" }));
    }
  });

  it("rejects origin credentials, paths, and unknown arguments", () : any => {
    const credentialOrigin: any = new URL("http://meshrix-vm.internal.example:7228");
    credentialOrigin.username = "owner";
    credentialOrigin.password = "secret";
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      credentialOrigin.toString(),
      "--candidate",
      "a".repeat(40),
    ])).toThrow(/without credentials/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7228/api",
      "--candidate",
      "a".repeat(40),
    ])).toThrow(/without credentials/);
    expect(() : any => parseNativeOrbDeploymentArgs([
      "--machine",
      "meshrix-vm",
      "--origin",
      "http://meshrix-vm.internal.example:7228",
      "--candidate",
      "a".repeat(40),
      "--fallback",
    ])).toThrow(/--candidate/);
  });

  it("binds deployment work to the Node executable owned by the service", () : any => {
    expect(resolveServiceNodeExecutable(
      "{ path=/opt/meshrix/node/bin/node ; argv[]=/opt/meshrix/node/bin/node --conditions=source tools/server-scripts/start-server.ts ; }",
    )).toBe("/opt/meshrix/node/bin/node");
    expect(() : any => resolveServiceNodeExecutable(
      "{ path=/usr/bin/npm ; argv[]=/usr/bin/npm run start:console ; }",
    )).toThrow(/absolute Node.js executable/);
    expect(() : any => resolveServiceNodeExecutable("node tools/server-scripts/start-server.ts"))
      .toThrow(/absolute Node.js executable/);
  });

  it("activates one explicit ordered list of independent stage scripts", async () : Promise<any> => {
    expect(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS).toEqual([
      { id: "runtime", script: "./stages/runtime.ts", dependsOn: [] },
      { id: "candidate", script: "./stages/candidate.ts", dependsOn: ["runtime"] },
      { id: "transfer", script: "./stages/transfer.ts", dependsOn: ["candidate"] },
      { id: "dependencies", script: "./stages/dependencies.ts", dependsOn: ["transfer"] },
      { id: "build", script: "./stages/build.ts", dependsOn: ["dependencies"] },
      { id: "native-runtime", script: "./stages/native-runtime.ts", dependsOn: ["build"] },
      { id: "configure", script: "./stages/configure.ts", dependsOn: ["native-runtime"] },
      { id: "activate", script: "./stages/activate.ts", dependsOn: ["configure"] },
      { id: "verify", script: "./stages/verify.ts", dependsOn: ["activate"] },
    ]);
    expect(new Set(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map((stage?: any) : any => stage.script)).size).toBe(9);
    expect(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.every((stage?: any) : any => (
      stage.script.startsWith("./stages/") && stage.script.endsWith(".ts")
    ))).toBe(true);
    expect(JSON.stringify(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS))
      .not.toMatch(/format-convert|skill-hub|model-gateway|plugin/u);
    const loadedStages: any[] = await Promise.all(
      NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map(loadNativeOrbDeploymentStageScript),
    );
    expect(loadedStages.every((loaded?: any) : any => (
      typeof loaded.runNativeOrbDeploymentStage === "function"
    ))).toBe(true);

    const activated: any[] = [];
    const results: any = await runNativeOrbDeploymentStageScripts({
      context: {},
      loadStage: async (stage?: any) : Promise<any> => ({
        runNativeOrbDeploymentStage: async () : Promise<any> => {
          activated.push(stage.id);
          return { id: stage.id, status: stage.id === "candidate" ? "resumed" : "completed" };
        },
      }),
    });
    expect(activated).toEqual(NATIVE_ORB_DEPLOYMENT_STAGE_SCRIPTS.map((stage?: any) : any => stage.id));
    expect(results).toHaveLength(9);
  });

  it("keeps the Core-only deployment decision linked from repository agent rules", () : any => {
    const repoRoot: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const design: any = fs.readFileSync(path.join(repoRoot, "tools/server-scripts/README.md"), "utf8");
    const agentRules: any = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    expect(design).toContain("Meshrix.js deployment scripts close only the capabilities owned by the");
    expect(design).toContain("Optional integration workflows");
    expect(agentRules).toContain("tools/server-scripts/README.md");
    expect(agentRules).toContain("Deployment scripts must close only Meshrix.js Core platform capabilities.");
  });
});
