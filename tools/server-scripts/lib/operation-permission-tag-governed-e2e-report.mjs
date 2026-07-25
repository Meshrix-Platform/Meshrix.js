import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  OPERATION_PERMISSION_TAG_GOVERNED_E2E
} from "./operation-permission-tag-governed-e2e-constants.mjs";

export function createOperationPermissionTagGovernedE2eReportHarness({
  userDataPath,
  getFixtureUrl = () => ""
} = {}) {
  const dynamicSecretNeedles = new Set([userDataPath, os.homedir()].filter(Boolean));
  const report = {
    schemaVersion: "v0.0.1:operation-permission:tag-governed-e2e-report-1",
    verifier: "tools/server-scripts/verify-operation-permission-tag-governed-e2e.mjs",
    startedAt: new Date().toISOString(),
    algorithm: {
      setup: "Create governance allow and deny tags through the real HTTP tag-management API, store entity projections in tag metadata, rebuild projections, then issue a real Operation Permission MCP grant.",
      allowPath: "Execute real MCP operations with tagPolicy allowTags across gateway forwarding, workspace file access, document download, and console administration.",
      denyPath: "Add deny-tag projections for the same governed entities, then prove the same operation families are rejected before side effects.",
      observability: "Query real Operation Permission audit and metrics APIs for ok, denied, and pending_approval evidence, then archive the deny tag for cleanup."
    },
    tests: [],
    destructiveTests: [],
    summary: {}
  };

  function trackSecret(...values) {
    for (const value of values) {
      const text = String(value || "").trim();
      if (text) {
        dynamicSecretNeedles.add(text);
      }
    }
  }

  function redactText(value = "") {
    let text = String(value || "");
    for (const needle of dynamicSecretNeedles) {
      if (needle && text.includes(needle)) {
        text = text.split(needle).join("[redacted]");
      }
    }
    const fixtureUrl = String(getFixtureUrl() || "");
    if (fixtureUrl) {
      text = text.split(fixtureUrl).join("[redacted-upstream-url]");
      text = text.split(new URL(fixtureUrl).host).join("[redacted-upstream-host]");
    }
    text = text.replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    text = text.replace(/"token"\s*:\s*"[^"]+"/gi, "\"token\":\"[redacted]\"");
    text = text.replace(/meshrix_[A-Za-z0-9_-]{12,}/g, "meshrix_[redacted]");
    text = text.replace(/\b(?:grant|tool_exec|trace|pending_op|workspace)_[A-Za-z0-9_-]{8,}\b/g, "[redacted-id]");
    return text;
  }

  function safeEvidence(value = {}) {
    return JSON.parse(JSON.stringify(value, (_, child) => {
      if (typeof child !== "string") {
        return child;
      }
      return redactText(child);
    }));
  }

  function assertNoLeakText(text = "", label = "text") {
    const value = String(text || "");
    for (const needle of dynamicSecretNeedles) {
      assert.equal(needle ? value.includes(needle) : false, false, `${label} leaked verifier data`);
    }
    assert.equal(/Bearer\s+(?!\[redacted\])\S+/i.test(value), false, `${label} leaked bearer token`);
    assert.equal(/"token"\s*:\s*"(?!\[redacted\])[^"]+"/i.test(value), false, `${label} leaked token field`);
    assert.equal(/meshrix_[A-Za-z0-9_-]{12,}/.test(value), false, `${label} leaked token-like value`);
  }

  function assertNoLeak(value, label = "payload") {
    assertNoLeakText(JSON.stringify(value), label);
  }

  async function writeReport() {
    report.finishedAt = new Date().toISOString();
    report.summary.testCount = report.tests.length;
    report.summary.destructiveTestCount = report.destructiveTests.length;
    report.summary.failedCount = [...report.tests, ...report.destructiveTests].filter((item) => item.status !== "passed").length;
    report.summary.releaseReady = report.summary.failedCount === 0;
    report.summary.reportLeakScan = true;
    assertNoLeak(report, "operation permission tag-governed E2E report");
    await fs.mkdir(path.dirname(OPERATION_PERMISSION_TAG_GOVERNED_E2E.reportPath), { recursive: true });
    await fs.writeFile(
      OPERATION_PERMISSION_TAG_GOVERNED_E2E.reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf8"
    );
  }

  function record(collection, name, status, evidence = {}) {
    collection.push({ name, status, evidence: safeEvidence(evidence) });
  }

  function failureEvidence(error) {
    return {
      errorName: error instanceof Error ? error.name : typeof error,
      code: String(error?.code || ""),
      status: Number(error?.status || 0) || 0
    };
  }

  async function test(name, fn) {
    process.stdout.write(`  ${name} ... `);
    try {
      const evidence = await fn();
      record(report.tests, name, "passed", evidence);
      console.log("ok");
    } catch (error) {
      record(report.tests, name, "failed", failureEvidence(error));
      console.log("FAIL");
      throw error;
    }
  }

  async function destructiveTest(name, fn) {
    process.stdout.write(`  destructive ${name} ... `);
    try {
      const evidence = await fn();
      record(report.destructiveTests, name, "passed", evidence);
      console.log("ok");
    } catch (error) {
      record(report.destructiveTests, name, "failed", failureEvidence(error));
      console.log("FAIL");
      throw error;
    }
  }

  return {
    report,
    trackSecret,
    redactText,
    safeEvidence,
    assertNoLeakText,
    assertNoLeak,
    writeReport,
    test,
    destructiveTest
  };
}
