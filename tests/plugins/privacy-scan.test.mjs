import assert from "node:assert/strict";
import test from "node:test";

import { findPrivacyFindings } from "../../tools/plugins/privacy-scan.mjs";

const macosHome = (...segments) => ["", "Users", ...segments].join("/");
const linuxHome = (...segments) => ["", "home", ...segments].join("/");
const windowsHome = (...segments) => ["C:", "Users", ...segments].join("\\");

function homePathRules(text) {
  return findPrivacyFindings("fixture.md", text)
    .filter(({ ruleId }) => ruleId === "local-home-path" || ruleId === "windows-home-path")
    .map(({ ruleId }) => ruleId);
}

test("home path rules allow username placeholders", () => {
  const placeholders = [
    macosHome("<user>", "project"),
    macosHome("$USER", "project"),
    macosHome("${USER}", "project"),
    macosHome("{{ user }}", "project"),
    linuxHome("<user-home>", "project"),
    linuxHome("$USER", "project"),
    linuxHome("${USER}", "project"),
    linuxHome("{{ user }}", "project"),
    windowsHome("<user>", "project"),
    windowsHome("$USER", "project"),
    windowsHome("${USER}", "project"),
    windowsHome("%USERNAME%", "project"),
    windowsHome("{{ user }}", "project")
  ];

  for (const [index, candidate] of placeholders.entries()) {
    assert.deepEqual(homePathRules(candidate), [], `placeholder case ${index}`);
  }
});

test("home path rules block realistic account names", () => {
  const candidates = [
    [macosHome("user", "project"), "local-home-path"],
    [macosHome("build.bot", "project"), "local-home-path"],
    [linuxHome("_service", "project"), "local-home-path"],
    [linuxHome("machine$", "project"), "local-home-path"],
    [windowsHome("real-user", "project"), "windows-home-path"]
  ];

  for (const [index, [candidate, expectedRule]] of candidates.entries()) {
    assert.deepEqual(homePathRules(candidate), [expectedRule], `account case ${index}`);
  }
});

test("home path rules block bare account roots", () => {
  assert.deepEqual(homePathRules(macosHome("user")), ["local-home-path"]);
  assert.deepEqual(homePathRules(linuxHome("example")), ["local-home-path"]);
  assert.deepEqual(homePathRules(windowsHome("account")), ["windows-home-path"]);
});

test("home path rules still block real accounts followed by placeholder segments", () => {
  const candidates = [
    [macosHome("real-user", "<repo-root>"), "local-home-path"],
    [linuxHome("_service", "${PROJECT_ROOT}"), "local-home-path"],
    [windowsHome("example", "{{ project }}"), "windows-home-path"]
  ];

  for (const [index, [candidate, expectedRule]] of candidates.entries()) {
    assert.deepEqual(homePathRules(candidate), [expectedRule], `placeholder-tail case ${index}`);
  }
});

test("home path rules do not match a valid-looking prefix of an invalid account component", () => {
  const candidates = [
    macosHome("name@template", "project"),
    macosHome("name.", "project"),
    linuxHome("-user", "project"),
    linuxHome(".hidden", "project"),
    windowsHome("name%USERNAME%", "project"),
    windowsHome("name{template}", "project")
  ];

  for (const [index, candidate] of candidates.entries()) {
    assert.deepEqual(homePathRules(candidate), [], `invalid-component case ${index}`);
  }
});
