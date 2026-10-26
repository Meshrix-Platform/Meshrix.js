import assert from "node:assert/strict";
import { test } from "node:test";
import path from "node:path";
import { isSystemDylibPath, linkedLibraryEntries } from "../../apps/entry-native/tools/package-macos.mjs";

const binary = path.join(path.sep, "build", "bin", "meshrix-entry");

const otoolOutput = [
  `${binary}:`,
  "\t/System/Library/Frameworks/Security.framework/Versions/A/Security (compatibility version 1.0.0, current version 61901.120.67)",
  "\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1356.0.0)",
].join("\n");

test("Mach-O dependency parsing records system dylibs and drops only the self entry", () => {
  const entries = linkedLibraryEntries(otoolOutput, binary);
  assert.deepEqual(entries, [
    "/System/Library/Frameworks/Security.framework/Versions/A/Security",
    "/usr/lib/libSystem.B.dylib",
  ]);
  assert.ok(entries.every((library) => isSystemDylibPath(library)));
});

test("a non-system load path sharing the executable basename is not dropped", () => {
  const hostile = `${otoolOutput}\n\t${path.join(path.sep, "tmp", "implant", "meshrix-entry")} (compatibility version 1.0.0, current version 1.0.0)`;
  const entries = linkedLibraryEntries(hostile, binary);
  assert.ok(entries.includes(path.join(path.sep, "tmp", "implant", "meshrix-entry")));
  assert.equal(isSystemDylibPath(path.join(path.sep, "tmp", "implant", "meshrix-entry")), false);
});

test("an exact self reference is excluded but an rpath entry is validated", () => {
  const relative = `${otoolOutput}\n\t${binary} (compatibility version 0.0.0, current version 0.0.0)`;
  assert.equal(linkedLibraryEntries(relative, binary).includes(binary), false);
  const rpath = `${otoolOutput}\n\t@rpath/libmeshrix.dylib (compatibility version 1.0.0, current version 1.0.0)`;
  const entries = linkedLibraryEntries(rpath, binary);
  assert.ok(entries.includes("@rpath/libmeshrix.dylib"));
  assert.equal(isSystemDylibPath("@rpath/libmeshrix.dylib"), false);
});

test("system dylib classification rejects traversal components and non-system roots", () => {
  assert.equal(isSystemDylibPath("/usr/lib/libSystem.B.dylib"), true);
  assert.equal(isSystemDylibPath("/System/Library/Frameworks/Security.framework/Versions/A/Security"), true);
  assert.equal(isSystemDylibPath("/usr/lib/../../../tmp/libimplant.dylib"), false);
  assert.equal(isSystemDylibPath("/System/Library/../../private/tmp/libimplant.dylib"), false);
  assert.equal(isSystemDylibPath("/usr/lib/./libSystem.B.dylib"), false);
  assert.equal(isSystemDylibPath("/usr/libdyld/x.dylib"), false);
  assert.equal(isSystemDylibPath("/private/usr/lib/x.dylib"), false);
  assert.equal(isSystemDylibPath("usr/lib/x.dylib"), false);
  assert.equal(isSystemDylibPath("@executable_path/../Frameworks/x.dylib"), false);
});

test("archives emit each member once and reproduce byte-identically", async () => {
  const { createArchive } = await import("../../apps/entry-native/tools/package-linux.mjs");
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const root = mkdtempSync(path.join(tmpdir(), "archive-entries-"));
  try {
    const staging = path.join(root, "staging");
    mkdirSync(path.join(staging, "bin"), { recursive: true });
    mkdirSync(path.join(staging, "licenses", "nested"), { recursive: true });
    writeFileSync(path.join(staging, "bin", "meshrix-entry"), "binary");
    writeFileSync(path.join(staging, "README.md"), "readme");
    writeFileSync(path.join(staging, "licenses", "nested", "NOTICE"), "notice");
    const first = path.join(root, "first.tar.gz");
    const second = path.join(root, "second.tar.gz");
    await createArchive(staging, first);
    await createArchive(staging, second);
    const members = execFileSync("tar", ["-tzf", first], { encoding: "utf8" }).trim().split("\n").sort();
    assert.deepEqual(members, [
      "README.md",
      "bin/meshrix-entry",
      "licenses/nested/NOTICE",
    ]);
    assert.equal(new Set(members).size, members.length, "archive members must be unique");
    assert.deepEqual(readFileSync(first), readFileSync(second), "same inputs must archive byte-identically");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
