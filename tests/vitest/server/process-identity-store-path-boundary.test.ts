import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryHomes: any[] = [];

afterEach(async () : Promise<any> => {
  await Promise.all(temporaryHomes.splice(0).map((root?: any) : any => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

async function createTemporaryHome(label?: any) : Promise<any> {
  const root: any = await fs.mkdtemp(path.join(os.tmpdir(), `meshrix-${label}-`));
  temporaryHomes.push(root);
  return root;
}

function redactChildOutput(value?: any, home?: any) : any {
  return String(value || "").split(home).join("<temporary-home>").slice(-4000);
}

function runIsolatedStoreScenario(home?: any, source?: any, extraEnvironment: Record<string, any> = {}) : any {
  const environment: Record<string, any> = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    MESHRIX_MCP_PROCESS_IDENTITY_STORE: "file",
    ...extraEnvironment
  };
  delete environment.MESHRIX_WINDOWS_DPAPI_COMMAND;
  const result: any = spawnSync(process.execPath, ["--input-type=module", "--eval", source], {
    cwd: process.cwd(),
    env: environment,
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 4 * 1024 * 1024
  });
  expect(
    result.status,
    redactChildOutput(`${result.stderr || ""}\n${result.stdout || ""}`, home)
  ).toBe(0);
  return JSON.parse(String(result.stdout || "").trim());
}

describe("MCP process identity store target and path boundary", () : any => {
  it("round-trips exactly the release target identities and one exact self-check identity", async () : Promise<any> => {
    const home: any = await createTemporaryHome("process-identity-valid");
    const result: any = runIsolatedStoreScenario(home, `
      import fs from "node:fs/promises";
      import path from "node:path";
      import { MCP_SUPPORTED_TARGETS } from "./packages/protocols/mcp/adapter/gateway-installer/mcp-release-targets.ts";
      import {
        deleteProcessIdentity,
        loadProcessIdentity,
        saveProcessIdentity
      } from "./packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.ts";
      import { identityStoreSelfTestCommand } from "./packages/protocols/mcp/adapter/gateway-installer/lib/cli/commands.ts";

      const storeRoot = path.resolve(process.env.HOME, ".meshrix", "mcp", "process-identity");
      const recordFor = (target) => ({
        schemaVersion: "v0.0.1:process-identity:mcp-credential-1",
        target,
        baseUrl: "http://127.0.0.1:0",
        savedAt: "2026-01-01T00:00:00.000Z",
        grantToken: "synthetic-grant-" + target,
        privateKeyPem: "synthetic-private-key-" + target,
        clientIdentityPackage: {
          clientId: target,
          packageId: "synthetic-package-" + target,
          processKey: { processKeyId: "synthetic-process-key-" + target },
          clientFingerprint: {
            fingerprintId: "synthetic-fingerprint-" + target,
            machineInstanceId: "synthetic-machine-" + target,
            appInstanceId: "synthetic-app-" + target,
            runtimeInstanceId: "synthetic-runtime-" + target,
            fingerprintHash: "sha256:synthetic-" + target
          }
        }
      });

      const productionResults = [];
      for (const target of MCP_SUPPORTED_TARGETS) {
        const record = recordFor(target);
        const saved = await saveProcessIdentity(target, record);
        const loaded = await loadProcessIdentity(target);
        const candidate = path.resolve(String(saved.filePath || ""));
        const relative = path.relative(storeRoot, candidate);
        await deleteProcessIdentity(target);
        const afterDelete = await loadProcessIdentity(target);
        productionResults.push({
          target,
          roundTrip:
            saved.storageBackend === "private-file-fallback" &&
            loaded?.target === target &&
            loaded?.privateKeyPem === record.privateKeyPem &&
            loaded?.grantToken === record.grantToken,
          contained:
            relative.length > 0 &&
            relative !== ".." &&
            !relative.startsWith(".." + path.sep) &&
            !path.isAbsolute(relative),
          deleted: afterDelete === null
        });
      }

      const verifyTarget = "verify-a1b2c3d4e5f6";
      const selfCheck = await identityStoreSelfTestCommand({ target: verifyTarget });
      const residue = await fs.readdir(storeRoot).catch((error) => {
        if (error?.code === "ENOENT") return [];
        throw error;
      });
      console.log(JSON.stringify({
        targets: [...MCP_SUPPORTED_TARGETS],
        productionResults,
        selfCheck: {
          ok: selfCheck.ok === true,
          exactTarget: selfCheck.target === verifyTarget,
          fileFallback: selfCheck.fileFallback === true,
          fileModeChecked: selfCheck.fileModeChecked === true
        },
        residueCount: residue.length
      }));
    `);

    expect(result.targets).toEqual([
      "openclaw",
      "codex",
      "claude-code",
      "antigravity",
      "opencode",
      "pi",
      "kimi"
    ]);
    expect(result.productionResults).toHaveLength(result.targets.length);
    expect(result.productionResults.every((entry?: any) : any => (
      entry.roundTrip === true &&
      entry.contained === true &&
      entry.deleted === true
    ))).toBe(true);
    expect(result.selfCheck).toEqual({
      ok: true,
      exactTarget: true,
      fileFallback: true,
      fileModeChecked: true
    });
    expect(result.residueCount).toBe(0);
  });

  it("rejects non-canonical, traversal, absolute, case, percent, and Unicode variants inside every store API before filesystem access", async () : Promise<any> => {
    const home: any = await createTemporaryHome("process-identity-invalid");
    const result: any = runIsolatedStoreScenario(home, `
      import fs from "node:fs/promises";
      import path from "node:path";

      const observedMethods = [
        "chmod",
        "lstat",
        "mkdir",
        "open",
        "readFile",
        "readdir",
        "realpath",
        "rename",
        "rm",
        "stat",
        "writeFile"
      ];
      const originals = Object.fromEntries(observedMethods.map((name) => [
        name,
        fs[name].bind(fs)
      ]));
      const effects = [];
      for (const name of observedMethods) {
        fs[name] = async (...args) => {
          effects.push(name);
          return originals[name](...args);
        };
      }

      const {
        deleteProcessIdentity,
        loadProcessIdentity,
        saveProcessIdentity
      } = await import("./packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.ts");

      const invalidTargets = [
        "",
        "unknown-client",
        "open-code",
        "CODEX",
        " codex ",
        ".",
        "..",
        "../outside",
        "..\\\\outside",
        path.join(process.env.HOME, "absolute-target"),
        "C:\\\\absolute-target",
        "\\\\\\\\server\\\\share",
        "codex.json",
        "codex/child",
        "codex\\\\child",
        "%2e%2e%2foutside",
        "codex%2ejson",
        "co\\u2215dex",
        "co\\u2044dex",
        "co\\uff0fdex",
        "co\\uff3cdex",
        "co\\u2028dex",
        "co\\u2029dex",
        "co\\u200bdex",
        "co\\u0085dex",
        "co\\u000adex",
        "co\\u0000dex",
        "claude\\u2010code",
        "verify-a1b2c3d4e5f6/../codex"
      ];
      const validRecord = {
        schemaVersion: "v0.0.1:process-identity:mcp-credential-1",
        target: "codex",
        baseUrl: "http://127.0.0.1:0",
        savedAt: "2026-01-01T00:00:00.000Z",
        grantToken: "synthetic-grant-marker",
        privateKeyPem: "synthetic-private-key-marker",
        clientIdentityPackage: {
          clientId: "codex",
          packageId: "synthetic-package",
          processKey: { processKeyId: "synthetic-process-key" },
          clientFingerprint: {
            fingerprintId: "synthetic-fingerprint",
            machineInstanceId: "synthetic-machine",
            appInstanceId: "synthetic-app",
            runtimeInstanceId: "synthetic-runtime",
            fingerprintHash: "sha256:synthetic"
          }
        }
      };
      const actions = [
        ["save", (target) => saveProcessIdentity(target, validRecord)],
        ["load", (target) => loadProcessIdentity(target)],
        ["delete", (target) => deleteProcessIdentity(target)]
      ];
      const observations = [];
      for (const target of invalidTargets) {
        for (const [operation, action] of actions) {
          const effectStart = effects.length;
          let denial = null;
          try {
            await action(target);
          } catch (error) {
            denial = {
              code: String(error?.code || ""),
              message: String(error?.message || "")
            };
          }
          observations.push({
            operation,
            denied:
              denial?.code === "MCP_PROCESS_IDENTITY_TARGET_INVALID" &&
              denial?.message === "MCP process identity target is invalid.",
            zeroFilesystemEffects: effects.length === effectStart,
            privacySafe:
              !JSON.stringify(denial || {}).includes(process.env.HOME) &&
              !JSON.stringify(denial || {}).includes("synthetic-private-key-marker") &&
              !JSON.stringify(denial || {}).includes("synthetic-grant-marker")
          });
        }
      }

      const homeEntries = await originals.readdir?.(process.env.HOME).catch(() => []);
      console.log(JSON.stringify({
        observationCount: observations.length,
        allDenied: observations.every((item) => item.denied),
        allZeroFilesystemEffects: observations.every((item) => item.zeroFilesystemEffects),
        allPrivacySafe: observations.every((item) => item.privacySafe),
        homeEntryCount: Array.isArray(homeEntries) ? homeEntries.length : 0
      }));
    `);

    expect(result.observationCount).toBe(87);
    expect(result.allDenied).toBe(true);
    expect(result.allZeroFilesystemEffects).toBe(true);
    expect(result.allPrivacySafe).toBe(true);
    expect(result.homeEntryCount).toBe(0);
  });

  it("accepts no self-check spelling except verify followed by twelve lowercase hexadecimal characters", async () : Promise<any> => {
    const home: any = await createTemporaryHome("process-identity-self-check-invalid");
    const result: any = runIsolatedStoreScenario(home, `
      import fs from "node:fs/promises";
      const observedMethods = [
        "chmod",
        "lstat",
        "mkdir",
        "open",
        "readFile",
        "realpath",
        "rename",
        "rm",
        "stat",
        "writeFile"
      ];
      const originals = Object.fromEntries(observedMethods.map((name) => [
        name,
        fs[name].bind(fs)
      ]));
      const effects = [];
      for (const name of observedMethods) {
        fs[name] = async (...args) => {
          effects.push(name);
          return originals[name](...args);
        };
      }
      const { identityStoreSelfTestCommand } = await import(
        "./packages/protocols/mcp/adapter/gateway-installer/lib/cli/commands.ts"
      );
      const invalidTargets = [
        "verify-",
        "verify-a1b2c3d4e5f",
        "verify-a1b2c3d4e5f67",
        "verify-A1B2C3D4E5F6",
        "VERIFY-a1b2c3d4e5f6",
        " verify-a1b2c3d4e5f6 ",
        "verify-a1b2c3d4e5fg",
        "verify-a1b2c3d4e5f6.",
        "verify-a1b2c3d4e5f6-extra",
        "verify-a1b2c3d4e5f6/../codex",
        "verify-a1b2c3d4e5f6\\\\..\\\\codex",
        "verify-%611b2c3d4e5f6",
        "verify-a1b2c3d4e5f\\u2028",
        "verify-a1b2c3d4e5f\\u200b"
      ];
      const observations = [];
      for (const target of invalidTargets) {
        const effectStart = effects.length;
        let denial = null;
        try {
          await identityStoreSelfTestCommand({ target });
        } catch (error) {
          denial = {
            code: String(error?.code || ""),
            message: String(error?.message || "")
          };
        }
        observations.push({
          denied:
            denial?.code === "MCP_PROCESS_IDENTITY_TARGET_INVALID" &&
            denial?.message === "MCP process identity target is invalid.",
          zeroFilesystemEffects: effects.length === effectStart,
          privacySafe:
            !JSON.stringify(denial || {}).includes(process.env.HOME) &&
            !JSON.stringify(denial || {}).includes(target)
        });
      }
      console.log(JSON.stringify({
        observationCount: observations.length,
        allDenied: observations.every((item) => item.denied),
        allZeroFilesystemEffects: observations.every((item) => item.zeroFilesystemEffects),
        allPrivacySafe: observations.every((item) => item.privacySafe)
      }));
    `);

    expect(result).toEqual({
      observationCount: 14,
      allDenied: true,
      allZeroFilesystemEffects: true,
      allPrivacySafe: true
    });
  });

  it.skipIf(process.platform === "win32")("rejects leaf and store-root symbolic-link escapes without reading, creating, or deleting the sibling sentinel", async () : Promise<any> => {
    const home: any = await createTemporaryHome("process-identity-symlink");
    const result: any = runIsolatedStoreScenario(home, `
      import fs from "node:fs/promises";
      import path from "node:path";

      const storeRoot = path.resolve(process.env.HOME, ".meshrix", "mcp", "process-identity");
      const siblingRoot = path.resolve(process.env.HOME, ".meshrix", "mcp", "sibling-sentinel");
      const leafSentinel = path.join(siblingRoot, "leaf-sentinel.json");
      const rootSentinel = path.join(siblingRoot, "codex.json");
      const record = {
        schemaVersion: "v0.0.1:process-identity:mcp-file-1",
        target: "codex",
        baseUrl: "http://127.0.0.1:0",
        savedAt: "2026-01-01T00:00:00.000Z",
        grantToken: "sibling-grant-marker",
        privateKeyPem: "sibling-private-key-marker",
        storageBackend: "private-file-fallback",
        clientIdentityPackage: {
          clientId: "codex",
          packageId: "sibling-package",
          processKey: { processKeyId: "sibling-process-key" },
          clientFingerprint: {
            fingerprintId: "sibling-fingerprint",
            machineInstanceId: "sibling-machine",
            appInstanceId: "sibling-app",
            runtimeInstanceId: "sibling-runtime",
            fingerprintHash: "sha256:sibling"
          }
        }
      };
      await fs.mkdir(storeRoot, { recursive: true, mode: 0o700 });
      await fs.mkdir(siblingRoot, { recursive: true, mode: 0o700 });
      const sentinelText = JSON.stringify(record);
      await fs.writeFile(leafSentinel, sentinelText, { mode: 0o600 });
      await fs.writeFile(rootSentinel, sentinelText, { mode: 0o600 });

      const observedMethods = [
        "mkdir",
        "open",
        "readFile",
        "rename",
        "rm",
        "writeFile"
      ];
      const originals = Object.fromEntries(observedMethods.map((name) => [
        name,
        fs[name].bind(fs)
      ]));
      const effects = [];
      for (const name of observedMethods) {
        fs[name] = async (...args) => {
          effects.push({ name, target: String(args[0] || "") });
          return originals[name](...args);
        };
      }
      const {
        deleteProcessIdentity,
        loadProcessIdentity,
        saveProcessIdentity
      } = await import("./packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.ts");
      const saveRecord = { ...record, storageBackend: undefined };
      const actions = [
        ["save", () => saveProcessIdentity("codex", saveRecord)],
        ["load", () => loadProcessIdentity("codex")],
        ["delete", () => deleteProcessIdentity("codex")]
      ];
      const boundaryDenial = (error) => (
        error?.code === "MCP_PROCESS_IDENTITY_STORE_BOUNDARY_INVALID" &&
        error?.message === "MCP process identity storage boundary is invalid."
      );
      const effectFree = (entries) => entries.every((entry) => (
        !["mkdir", "open", "readFile", "rename", "rm", "writeFile"].includes(entry.name)
      ));

      const leafLink = path.join(storeRoot, "codex.json");
      const leafResults = [];
      for (const [operation, action] of actions) {
        await originals.rm(leafLink, { force: true });
        await fs.symlink(leafSentinel, leafLink);
        const effectStart = effects.length;
        let denial = null;
        try {
          await action();
        } catch (error) {
          denial = error;
        }
        const relevantEffects = effects.slice(effectStart);
        const linkState = await fs.lstat(leafLink).catch(() => null);
        leafResults.push({
          operation,
          denied: boundaryDenial(denial),
          effectFree: effectFree(relevantEffects),
          linkPreserved: linkState?.isSymbolicLink() === true,
          sentinelPreserved: await originals.readFile(leafSentinel, "utf8") === sentinelText,
          privacySafe:
            !String(denial?.message || "").includes(process.env.HOME) &&
            !String(denial?.message || "").includes("sibling-private-key-marker")
        });
      }

      await originals.rm(storeRoot, { recursive: true, force: true });
      await fs.symlink(siblingRoot, storeRoot);
      const rootResults = [];
      for (const [operation, action] of actions) {
        const effectStart = effects.length;
        let denial = null;
        try {
          await action();
        } catch (error) {
          denial = error;
        }
        const relevantEffects = effects.slice(effectStart);
        const linkState = await fs.lstat(storeRoot).catch(() => null);
        rootResults.push({
          operation,
          denied: boundaryDenial(denial),
          effectFree: effectFree(relevantEffects),
          linkPreserved: linkState?.isSymbolicLink() === true,
          sentinelPreserved: await originals.readFile(rootSentinel, "utf8") === sentinelText,
          privacySafe:
            !String(denial?.message || "").includes(process.env.HOME) &&
            !String(denial?.message || "").includes("sibling-private-key-marker")
        });
      }

      console.log(JSON.stringify({
        leafResults,
        rootResults
      }));
    `);

    for (const group of [result.leafResults, result.rootResults]) {
      expect(group.map((item?: any) : any => item.operation)).toEqual(["save", "load", "delete"]);
      expect(group.every((item?: any) : any => (
        item.denied === true &&
        item.effectFree === true &&
        item.linkPreserved === true &&
        item.sentinelPreserved === true &&
        item.privacySafe === true
      ))).toBe(true);
    }
  });
});
