import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  resolveWindowsDpapiCommand,
  supportedProcessIdentitySystemBackendsForPlatform
} from "../../../packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.mjs";

const temporaryRoots = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true
  })));
});

describe("MCP process identity Windows DPAPI backend", () => {
  it("selects one current-user DPAPI backend for Windows", () => {
    expect(supportedProcessIdentitySystemBackendsForPlatform("win32")).toEqual(["windows-dpapi"]);
    expect(supportedProcessIdentitySystemBackendsForPlatform("darwin")).toEqual(["macos-keychain"]);
    expect(supportedProcessIdentitySystemBackendsForPlatform("linux")).toEqual([
      "linux-secret-service",
      "linux-kernel-keyring"
    ]);
    expect(resolveWindowsDpapiCommand({
      platform: "win32",
      configuredCommand: "untrusted-dpapi-command"
    })).toBe("powershell.exe");
    expect(resolveWindowsDpapiCommand({
      platform: "linux",
      configuredCommand: "/controlled/fake-powershell"
    })).toBe("/controlled/fake-powershell");
  });

  it.skipIf(process.platform === "win32")("round-trips through the DPAPI command boundary without plaintext persistence", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-mcp-dpapi-test-"));
    temporaryRoots.push(root);
    const command = path.join(root, "fake-powershell.mjs");
    await fs.writeFile(command, `#!/usr/bin/env node
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");
if (process.env.MESHRIX_MCP_TOKEN || process.env.CUSTOM_GRANT_SECRET) process.exit(3);
const args = process.argv.slice(2).join(" ");
if (args.includes("ProtectedData]::Protect")) {
  process.stdout.write(Buffer.from("dpapi:" + input, "utf8").toString("base64"));
} else {
  const plain = Buffer.from(input.trim(), "base64").toString("utf8");
  if (!plain.startsWith("dpapi:")) process.exit(2);
  process.stdout.write(plain.slice(6));
}
`, { mode: 0o700 });
    await fs.chmod(command, 0o700);

    const script = `
      import fs from "node:fs/promises";
      import path from "node:path";
      import {
        deleteProcessIdentity,
        loadProcessIdentity,
        saveProcessIdentity
      } from "./packages/protocols/mcp/adapter/gateway-installer/lib/process-identity-store.mjs";
      const target = "verify-windows-dpapi";
      const marker = "synthetic-private-key-marker";
      const saved = await saveProcessIdentity(target, {
        privateKeyPem: marker,
        grantToken: "synthetic-grant-token",
        clientIdentityPackage: {
          clientId: target,
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
      });
      const encryptedPath = path.join(process.env.HOME, ".meshrix", "mcp", "process-identity", target + ".dpapi");
      const encrypted = await fs.readFile(encryptedPath, "utf8");
      const loaded = await loadProcessIdentity(target);
      await deleteProcessIdentity(target);
      const removed = await fs.lstat(encryptedPath).then(() => false).catch((error) => error?.code === "ENOENT");
      console.log(JSON.stringify({
        backend: saved.storageBackend,
        abstractReference: String(saved.reference || "").startsWith("windows-dpapi:"),
        plaintextAbsent: !encrypted.includes(marker) && !encrypted.includes("synthetic-grant-token"),
        roundTrip: loaded?.privateKeyPem === marker && loaded?.grantToken === "synthetic-grant-token",
        removed
      }));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: root,
        MESHRIX_MCP_PROCESS_IDENTITY_STORE: "windows-dpapi",
        MESHRIX_WINDOWS_DPAPI_COMMAND: command,
        MESHRIX_MCP_TOKEN: "synthetic-grant-token",
        CUSTOM_GRANT_SECRET: "synthetic-grant-token"
      },
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual({
      backend: "windows-dpapi",
      abstractReference: true,
      plaintextAbsent: true,
      roundTrip: true,
      removed: true
    });
  });
});
