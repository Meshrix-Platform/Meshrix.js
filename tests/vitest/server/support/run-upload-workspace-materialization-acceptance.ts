import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const vitestPath: any = fileURLToPath(new URL(
  "../../../../node_modules/vitest/vitest.mjs",
  import.meta.url
));
const testPath: any =
  "tests/vitest/server/upload-custody-workspace-materialization.test.ts";
const expectedTestPath: any = path.resolve(testPath);
const EXPECTED_TEST_COUNT: any = 80;

function escapeRegExp(value?: any) : any {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

if (process.platform !== "linux") {
  throw new Error(
    "Upload workspace materialization acceptance requires Linux."
  );
}

const listing: any = spawnSync(
  process.execPath,
  [vitestPath, "list", testPath, "--json"],
  {
    cwd: process.cwd(),
    encoding: "utf8",
    env: process.env,
    maxBuffer: 1024 * 1024,
    timeout: 120_000
  }
);
if (listing.error) throw listing.error;
if (listing.status !== 0) {
  throw new Error("Materialization acceptance collection failed.");
}
const collected: any = JSON.parse(listing.stdout);
const names: any = collected.map((entry?: any) : any => String(entry?.name || ""));
const runtimeNames: any = names.map((name?: any) : any => name.replace(" > ", " "));
if (
  collected.length !== EXPECTED_TEST_COUNT ||
  new Set<any>(names).size !== EXPECTED_TEST_COUNT ||
  new Set<any>(runtimeNames).size !== EXPECTED_TEST_COUNT ||
  collected.some((entry?: any) : any =>
    path.resolve(String(entry?.file || "")) !== expectedTestPath ||
    entry?.projectName !== "serial" ||
    !String(entry?.name || "").startsWith(
      "opaque upload custody to governed workspace materialization > "
    )
  )
) {
  throw new Error(
    "Materialization acceptance collection is not the frozen test set."
  );
}

for (const [index, name] of names.entries()) {
  const runtimeName: any = runtimeNames[index];
  const result: any = spawnSync(
    process.execPath,
    [
      vitestPath,
      "run",
      testPath,
      "--testNamePattern",
      `^${escapeRegExp(runtimeName)}$`,
      "--reporter=json"
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000
    }
  );
  if (result.error) throw result.error;
  let report: any = null;
  try {
    report = JSON.parse(result.stdout);
  } catch {}
  const assertions: any = report?.testResults?.flatMap(
    (entry?: any) : any => entry.assertionResults || []
  ) || [];
  const passedAssertions: any = assertions.filter(
    (entry?: any) : any => entry.status === "passed"
  );
  const issues: any[] = [
    ...(result.status === 0 ? [] : ["process_status"]),
    ...(report?.success === true ? [] : ["report_success"]),
    ...(report?.numTotalTests === EXPECTED_TEST_COUNT
      ? [] : ["total_count"]),
    ...(report?.numPassedTests === 1 ? [] : ["passed_count"]),
    ...(report?.numFailedTests === 0 ? [] : ["failed_count"]),
    ...(report?.numPendingTests === EXPECTED_TEST_COUNT - 1
      ? [] : ["pending_count"]),
    ...(passedAssertions.length === 1
      ? [] : ["passed_assertion_count"]),
    ...(passedAssertions[0]?.fullName === runtimeName
      ? [] : ["passed_assertion_identity"])
  ];
  if (issues.length > 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    throw Object.assign(
      new Error(
        `Materialization acceptance case failed (${issues.join(",")}): ${name}.`
      ),
      { code: "materialization_acceptance_case_failed" }
    );
  }
}
