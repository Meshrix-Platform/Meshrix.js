import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";

import {
  FileCustodyAdapter,
  MacosKeychainCustody,
  WindowsDpapiCustody,
  createFileCustodyAdapter,
  deviceIdentityFromCustody,
  enrollDeviceIdentity,
  isEntryError,
  loadDevicePrivateKey,
  selectCustodyAdapter,
  signWithDeviceKey,
  verifyEd25519,
  type ShellRunner,
  type ShellRunnerResult
} from "@meshrix/entry";

/** Recorded-argv shell double; no real Keychain/DPAPI is ever touched. */
class FakeRunner implements ShellRunner {
  calls: { command: string; args: string[]; stdin?: string }[] = [];
  handler: (command: string, args: string[], stdin?: string) => ShellRunnerResult = () => ({
    code: 0, stdout: "", stderr: ""
  });
  async run(command: string, args: readonly string[], options?: { stdin?: string }): Promise<ShellRunnerResult> {
    this.calls.push({ command, args: [...args], stdin: options?.stdin });
    return this.handler(command, [...args], options?.stdin);
  }
}

const WRAP = () => randomBytes(32);
const SECRET = () => randomBytes(48);

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function tempDir(): Promise<string> {
  dir = await mkdtemp(path.join(tmpdir(), "entry-custody-"));
  return dir;
}

describe("file custody fallback", () => {
  it("stores and loads secret bytes end-to-end", async () => {
    const adapter = createFileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    expect(await adapter.available()).toBe(true);
    const secret = SECRET();
    await adapter.storeSecret({ ref: "dev.device.1", secret });
    const loaded = await adapter.loadSecret({ ref: "dev.device.1" });
    expect(loaded && Buffer.from(loaded).equals(Buffer.from(secret))).toBe(true);
  });

  it("returns null for an absent ref", async () => {
    const adapter = createFileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    expect(await adapter.loadSecret({ ref: "dev.missing" })).toBeNull();
  });

  it("rejects malformed refs on every operation", async () => {
    const adapter = createFileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    await expect(adapter.storeSecret({ ref: "../escape", secret: SECRET() }))
      .rejects.toMatchObject({ code: "custody_invalid_ref" });
    await expect(adapter.loadSecret({ ref: "BAD REF" }))
      .rejects.toMatchObject({ code: "custody_invalid_ref" });
  });

  it("fails authentication under a wrong wrap secret", async () => {
    const dataDir = await tempDir();
    const a = createFileCustodyAdapter({ dataDir, wrapSecret: WRAP() });
    await a.storeSecret({ ref: "dev.device.1", secret: SECRET() });
    const b = createFileCustodyAdapter({ dataDir, wrapSecret: WRAP() });
    await expect(b.loadSecret({ ref: "dev.device.1" }))
      .rejects.toMatchObject({ code: "custody_decrypt_failed" });
  });

  it("fails authentication on a tampered ciphertext", async () => {
    const dataDir = await tempDir();
    const adapter = createFileCustodyAdapter({ dataDir, wrapSecret: WRAP() });
    await adapter.storeSecret({ ref: "dev.device.1", secret: SECRET() });
    const file = path.join(dataDir, "dev.device.1.custody.json");
    const body = JSON.parse(await readFile(file, "utf8"));
    const raw = Buffer.from(body.ciphertext, "base64url");
    raw[0] ^= 0xff;
    body.ciphertext = raw.toString("base64url");
    await writeFile(file, JSON.stringify(body));
    await expect(adapter.loadSecret({ ref: "dev.device.1" }))
      .rejects.toMatchObject({ code: "custody_decrypt_failed" });
  });

  it("rejects a malformed custody file payload", async () => {
    const dataDir = await tempDir();
    const adapter = createFileCustodyAdapter({ dataDir, wrapSecret: WRAP() });
    await adapter.available();
    await writeFile(path.join(dataDir, "dev.device.1.custody.json"), JSON.stringify({ not: "custody" }));
    await expect(adapter.loadSecret({ ref: "dev.device.1" }))
      .rejects.toMatchObject({ code: "custody_payload_invalid" });
  });

  it("deletes entries and treats absent deletes as a no-op", async () => {
    const adapter = createFileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    await adapter.storeSecret({ ref: "dev.device.1", secret: SECRET() });
    await adapter.deleteSecret({ ref: "dev.device.1" });
    expect(await adapter.loadSecret({ ref: "dev.device.1" })).toBeNull();
    await adapter.deleteSecret({ ref: "dev.device.1" });
  });

  it("refuses to run without a 32-byte wrap secret", async () => {
    expect(() => createFileCustodyAdapter({ dataDir: "/tmp/x", wrapSecret: new Uint8Array(8) }))
      .toThrowError(expect.objectContaining({ code: "custody_payload_invalid" }));
  });
});

describe("macOS Keychain custody (mocked security CLI)", () => {
  function serviceCalls(runner: FakeRunner, verb: string) {
    return runner.calls.filter((call) => call.command === "security" && call.args[0] === verb);
  }

  it("stores via add-generic-password with service/account/-w -U", async () => {
    const runner = new FakeRunner();
    const adapter = new MacosKeychainCustody({ runner });
    const secret = SECRET();
    await adapter.storeSecret({ ref: "dev.device.1", secret });
    const [call] = serviceCalls(runner, "add-generic-password");
    expect(call.args).toContain("-s");
    expect(call.args).toContain("-a");
    const wIndex = call.args.indexOf("-w");
    expect(Buffer.from(call.args[wIndex + 1], "base64").equals(Buffer.from(secret))).toBe(true);
    expect(call.args).toContain("-U");
  });

  it("loads via find-generic-password -w and decodes base64", async () => {
    const runner = new FakeRunner();
    const secret = SECRET();
    runner.handler = (command, args) => args[0] === "find-generic-password"
      ? { code: 0, stdout: `${Buffer.from(secret).toString("base64")}\n`, stderr: "" }
      : { code: 0, stdout: "", stderr: "" };
    const adapter = new MacosKeychainCustody({ runner });
    const loaded = await adapter.loadSecret({ ref: "dev.device.1" });
    expect(loaded && Buffer.from(loaded).equals(Buffer.from(secret))).toBe(true);
    const [call] = serviceCalls(runner, "find-generic-password");
    expect(call.args).toContain("-w");
  });

  it("maps missing items (exit 44 / not-found text) to null", async () => {
    const runner = new FakeRunner();
    runner.handler = () => ({ code: 44, stdout: "", stderr: "The specified item could not be found in the keychain." });
    const adapter = new MacosKeychainCustody({ runner });
    expect(await adapter.loadSecret({ ref: "dev.missing" })).toBeNull();
  });

  it("surfaces backend errors distinctly", async () => {
    const runner = new FakeRunner();
    runner.handler = () => ({ code: 36, stdout: "", stderr: "errSecIO" });
    const adapter = new MacosKeychainCustody({ runner });
    await expect(adapter.storeSecret({ ref: "dev.device.1", secret: SECRET() }))
      .rejects.toMatchObject({ code: "custody_backend_error" });
    await expect(adapter.loadSecret({ ref: "dev.device.1" }))
      .rejects.toMatchObject({ code: "custody_backend_error" });
  });

  it("reports availability from the list-keychains probe", async () => {
    const runner = new FakeRunner();
    runner.handler = (_c, args) => args[0] === "list-keychains"
      ? { code: 0, stdout: "login.keychain-db", stderr: "" }
      : { code: 1, stdout: "", stderr: "nope" };
    expect(await new MacosKeychainCustody({ runner }).available()).toBe(true);
    runner.handler = () => ({ code: 1, stdout: "", stderr: "spawn security ENOENT" });
    expect(await new MacosKeychainCustody({ runner }).available()).toBe(false);
  });
});

describe("Windows DPAPI custody (mocked powershell helper)", () => {
  /** In-memory DPAPI substitute: proves the plumbing without DPAPI itself. */
  function dpapiRunner(runner: FakeRunner): FakeRunner {
    runner.handler = (_command, args, stdin) => {
      const script = args[args.indexOf("-Command") + 1] ?? "";
      if (script.includes("ReadToEnd") === false) {
        return { code: 0, stdout: "ok", stderr: "" };
      }
      if (script.includes("Protect($b") && !script.includes("Unprotect")) {
        // Wrap the base64 plaintext itself; unprotect hands the same base64 back.
        return { code: 0, stdout: Buffer.from(`dpapi.${stdin ?? ""}`).toString("base64"), stderr: "" };
      }
      if (script.includes("Unprotect")) {
        const wrapped = Buffer.from(stdin ?? "", "base64").toString();
        if (!wrapped.startsWith("dpapi.")) return { code: 1, stdout: "", stderr: "CryptographicException" };
        return { code: 0, stdout: wrapped.slice(6), stderr: "" };
      }
      return { code: 0, stdout: "ok", stderr: "" };
    };
    return runner;
  }

  it("protects via stdin/stdout base64 — secrets never touch argv", async () => {
    const runner = dpapiRunner(new FakeRunner());
    const dataDir = await tempDir();
    const adapter = new WindowsDpapiCustody({ runner, dataDir });
    const secret = SECRET();
    await adapter.storeSecret({ ref: "dev.device.1", secret });
    const protectCall = runner.calls.find((call) => (call.args[call.args.indexOf("-Command") + 1] ?? "").includes("Protect"));
    expect(protectCall?.stdin).toBe(Buffer.from(secret).toString("base64"));
    expect(protectCall?.args.join(" ")).not.toContain(Buffer.from(secret).toString("base64"));
    const loaded = await adapter.loadSecret({ ref: "dev.device.1" });
    expect(loaded && Buffer.from(loaded).equals(Buffer.from(secret))).toBe(true);
  });

  it("returns null for an absent blob and survives delete of absent refs", async () => {
    const runner = dpapiRunner(new FakeRunner());
    const adapter = new WindowsDpapiCustody({ runner, dataDir: await tempDir() });
    expect(await adapter.loadSecret({ ref: "dev.missing" })).toBeNull();
    await adapter.deleteSecret({ ref: "dev.missing" });
  });

  it("reports unprotect failures as backend errors", async () => {
    const runner = new FakeRunner();
    const dataDir = await tempDir();
    const adapter = new WindowsDpapiCustody({ runner, dataDir });
    await writeFile(path.join(dataDir, "dev.device.1.dpapi.b64"), "dm9pZA==\n");
    runner.handler = () => ({ code: 1, stdout: "", stderr: "CryptographicException: bad data" });
    await expect(adapter.loadSecret({ ref: "dev.device.1" }))
      .rejects.toMatchObject({ code: "custody_backend_error" });
  });

  it("falls through powershell→pwsh and reports unavailable when neither exists", async () => {
    const runner = new FakeRunner();
    runner.handler = (command) => ({ code: 1, stdout: "", stderr: `spawn ${command} ENOENT` });
    const adapter = new WindowsDpapiCustody({ runner, dataDir: await tempDir() });
    expect(await adapter.available()).toBe(false);
    const probed = runner.calls.map((call) => call.command);
    expect(probed).toContain("powershell");
    expect(probed).toContain("pwsh");
  });
});

describe("deterministic custody selection", () => {
  it("selects macOS Keychain on darwin", async () => {
    const selection = selectCustodyAdapter({ platform: "darwin", runner: new FakeRunner() });
    expect(selection.tier).toBe("os");
    expect(selection.adapter.kind).toBe("macos-keychain");
  });

  it("selects Windows DPAPI on win32 and requires a dataDir", async () => {
    const selection = selectCustodyAdapter({ platform: "win32", runner: new FakeRunner(), windows: { dataDir: await tempDir() } });
    expect(selection.tier).toBe("os");
    expect(selection.adapter.kind).toBe("windows-dpapi");
    expect(() => selectCustodyAdapter({ platform: "win32", runner: new FakeRunner() }))
      .toThrowError(expect.objectContaining({ code: "custody_unavailable" }));
  });

  it("falls back to encrypted file custody on unsupported platforms", async () => {
    const selection = selectCustodyAdapter({
      platform: "linux",
      file: { dataDir: await tempDir(), wrapSecret: WRAP() }
    });
    expect(selection.tier).toBe("file");
    expect(selection.adapter.kind).toBe("file");
  });

  it("honors an explicit file preference on any platform", async () => {
    const selection = selectCustodyAdapter({
      platform: "darwin",
      prefer: "file",
      file: { dataDir: await tempDir(), wrapSecret: WRAP() }
    });
    expect(selection.adapter.kind).toBe("file");
  });

  it("refuses to claim OS custody on an unsupported platform", () => {
    expect(() => selectCustodyAdapter({ platform: "linux", prefer: "os" }))
      .toThrowError(expect.objectContaining({ code: "unsupported_platform" }));
  });

  it("never substitutes file custody silently when the OS adapter is unavailable", async () => {
    const runner = new FakeRunner();
    runner.handler = () => ({ code: 1, stdout: "", stderr: "spawn security ENOENT" });
    const selection = selectCustodyAdapter({ platform: "darwin", runner });
    expect(selection.tier).toBe("os");
    expect(await selection.adapter.available()).toBe(false);
  });
});

describe("device identity inside custody", () => {
  it("enrolls a device and exposes only public identity material", async () => {
    const custody = new FileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    const device = await enrollDeviceIdentity({ custody });
    expect(device.deviceId.startsWith("dev.entry.")).toBe(true);
    expect(device.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(device.fingerprint.startsWith("fp.")).toBe(true);
    expect("privateKey" in device).toBe(false);
  });

  it("signs with the custodied key and verifies against the public key", async () => {
    const custody = new FileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    const device = await enrollDeviceIdentity({ custody });
    const signature = await signWithDeviceKey({ custody, deviceId: device.deviceId }, "transcript");
    expect(verifyEd25519({ publicKey: device.publicKey, signature, transcript: "transcript" })).toBe(true);
    const roundTrip = await deviceIdentityFromCustody({ custody, deviceId: device.deviceId });
    expect(roundTrip?.publicKey).toBe(device.publicKey);
  });

  it("fails closed when the device key is absent", async () => {
    const custody = new FileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    expect(await loadDevicePrivateKey({ custody, deviceId: "dev.absent" })).toBeNull();
    await expect(signWithDeviceKey({ custody, deviceId: "dev.absent" }, "t"))
      .rejects.toMatchObject({ code: "custody_unavailable" });
  });

  it("rejects a corrupted custodied blob honestly", async () => {
    const custody = new FileCustodyAdapter({ dataDir: await tempDir(), wrapSecret: WRAP() });
    const device = await enrollDeviceIdentity({ custody });
    await custody.storeSecret({ ref: `dev.${device.deviceId.toLowerCase().replace(/[^a-z0-9._-]/gu, "-")}`, secret: new Uint8Array([1, 2, 3]) });
    await expect(loadDevicePrivateKey({ custody, deviceId: device.deviceId }))
      .rejects.toMatchObject({ code: "custody_payload_invalid" });
    expect(isEntryError(await loadDevicePrivateKey({ custody, deviceId: device.deviceId }).catch((e) => e))).toBe(true);
  });
});
