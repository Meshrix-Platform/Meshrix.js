import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  commandAvailable,
  commandPath,
  commandVersion,
  resolveCommandCandidate,
  resolveCommandCandidates
} from "../../../packages/foundation/src/environment-compatibility/host-runtime.ts";
import { commandExistsInPath } from "../../../packages/foundation/src/environment-compatibility/host-backends.ts";

describe("Foundation host command resolution", () => {
  it("uses PATH order and never invokes a shell or where command", () => {
    const executablePaths = new Set([
      path.posix.join("/first", "node"),
      path.posix.join("/second", "node")
    ]);
    const executableExistsFn = vi.fn((candidate: string) => executablePaths.has(candidate));
    const spawnSync = vi.fn(() => ({ status: 0, stdout: "v24.0.0", stderr: "" }));
    const options = {
      platform: "linux",
      env: { PATH: "/first:/second" },
      executableExistsFn,
      spawnSync
    };

    expect(commandPath("node", options)).toBe("/first/node");
    expect(commandAvailable("node", options)).toBe(true);
    expect(commandVersion("node", ["--version"], options)).toBe("v24.0.0");
    expect(resolveCommandCandidates("node", options).map(({ path: candidate }) => candidate))
      .toEqual(["/first/node", "/second/node"]);
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync.mock.calls[0]?.[0]).toBe("/first/node");
  });

  it("keeps host-only checks out of package-local bins while explicit local bins remain opt-in", () => {
    const localBin = path.posix.join("/workspace", "node_modules", ".bin");
    const localExecutable = path.posix.join(localBin, "tool");
    const executableExistsFn = (candidate: string) => candidate === localExecutable;
    const options = {
      platform: "linux",
      cwd: "/workspace",
      env: { PATH: "" },
      executableExistsFn
    };

    expect(commandPath("tool", options)).toBe("");
    expect(commandExistsInPath("tool", { platform: "linux", env: { PATH: "" } })).toBe(false);
    expect(resolveCommandCandidate("tool", options)).toMatchObject({ found: true, path: localExecutable });
    expect(resolveCommandCandidate("tool", { ...options, includeDefaultLocalBin: false })).toMatchObject({
      found: false,
      path: ""
    });
  });

  it("honors Windows PATH, PATHEXT order, and normalized duplicate paths", () => {
    const winPath = path.win32;
    const executablePaths = new Set([
      "c:\\one\\meshrix.cmd",
      "c:\\two\\meshrix.cmd"
    ]);
    const executableExistsFn = (candidate: string) => executablePaths.has(candidate.toLowerCase());
    const options = {
      platform: "win32",
      env: {
        Path: "C:\\one;C:\\two",
        PATHEXT: ".CMD;.EXE"
      },
      executableExistsFn
    };

    expect(resolveCommandCandidate("meshrix", options)).toMatchObject({
      found: true,
      path: winPath.join("C:\\one", "meshrix.cmd")
    });
    expect(resolveCommandCandidates("meshrix", options).map(({ path: candidate }) => candidate)).toEqual([
      winPath.join("C:\\one", "meshrix.cmd"),
      winPath.join("C:\\two", "meshrix.cmd")
    ]);
  });

  it("checks only the caller's PATH for host backend capability probes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-host-command-resolution-"));
    try {
      const executable = path.join(root, "owned-tool");
      await fs.writeFile(executable, "#!/bin/sh\nexit 0\n");
      await fs.chmod(executable, 0o755);

      expect(commandExistsInPath("owned-tool", { env: { PATH: root } })).toBe(true);
      expect(commandExistsInPath("missing-tool", { env: { PATH: root } })).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("accepts an explicit Windows extension without appending PATHEXT again", () => {
    const executableExistsFn = vi.fn((candidate: string) => candidate === "C:\\tools\\node.EXE");
    const candidate = resolveCommandCandidate("C:\\tools\\node.EXE", {
      platform: "win32",
      env: { Path: "C:\\elsewhere", PATHEXT: ".CMD;.EXE" },
      executableExistsFn
    });

    expect(candidate).toMatchObject({ found: true, path: "C:\\tools\\node.EXE" });
    expect(executableExistsFn).toHaveBeenCalledTimes(1);
  });
});
