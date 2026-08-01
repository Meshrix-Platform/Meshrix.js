#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const DEFAULT_LICO_DEV_ROOT: any = path.resolve(REPO_ROOT, "../lico-dev");
const RECEIPT_PATH: any = "tools/registry/lico-dev-upstream-workflow-receipt.json";
const GIT_SHA1: any = /^[a-f0-9]{40}$/u;
const TASK_ID: any = /^[a-z0-9-]+\.[a-z0-9-]+$/u;

export const LICO_DEV_UPSTREAM_SOURCE_ALLOWLIST: readonly any[] = Object.freeze([
  Object.freeze({ path: "config/repositories.json", role: "repository-routing" }),
  Object.freeze({ path: "lib/constants.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/io.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/privacy-classifier.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/repositories.ts", role: "workflow-planner" }),
  Object.freeze({ path: "lib/workflow.ts", role: "workflow-planner" }),
  Object.freeze({ path: "tests/helpers.ts", role: "workflow-tests" }),
  Object.freeze({ path: "tests/workflow.test.ts", role: "workflow-tests" }),
  Object.freeze({ path: "workflows/catalog.json", role: "workflow-catalog" }),
  Object.freeze({ path: "skills/catalog.json", role: "skill-catalog" }),
  Object.freeze({
    path: "skills/lico-upstream-service-publishing/SKILL.md",
    role: "skill-contract"
  }),
  Object.freeze({
    path: "skills/lico-upstream-service-publishing/references/publishing-contract.md",
    role: "skill-contract"
  })
]);

const ROUTE_PROFILES: Readonly<Record<string, any>> = Object.freeze({
  prepublication: "upstream-service-prepublication",
  full: "upstream-service-publishing"
});
const EXTERNAL_TEST_COMMAND: Readonly<Record<string, any>> = Object.freeze({
  executable: "node",
  args: Object.freeze(["--test", "tests/workflow.test.ts"])
});

function canonicalJson(value?: any) : any {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map(
      (key?: any) : any => `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value?: any) : any {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function withDigest(facts?: any, digestKey?: any) : any {
  return {
    ...facts,
    [digestKey]: sha256(canonicalJson(facts))
  };
}

function fixedError(code?: any) : any {
  return Object.assign(new Error("The lico-dev upstream workflow receipt could not be generated."), {
    code
  });
}

async function readGitRevision(licoDevRoot?: any) : Promise<any> {
  return new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: licoDevRoot,
      stdio: ["ignore", "pipe", "ignore"]
    });
    let stdout: any = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk?: any) : any => {
      stdout += chunk;
      if (stdout.length > 128) child.kill();
    });
    child.once("error", () : any => reject(fixedError("lico_dev_receipt_revision_unavailable")));
    child.once("close", (code?: any, signal?: any) : any => {
      const revision: any = stdout.trim();
      if (code !== 0 || signal || !GIT_SHA1.test(revision)) {
        reject(fixedError("lico_dev_receipt_revision_unavailable"));
        return;
      }
      resolve(revision);
    });
  });
}

async function readSourceSnapshot(licoDevRoot?: any) : Promise<any> {
  const [revision, allowlist] = await Promise.all([
    readGitRevision(licoDevRoot),
    Promise.all(LICO_DEV_UPSTREAM_SOURCE_ALLOWLIST.map(async (entry?: any) : Promise<any> => {
      const sourcePath: any = path.resolve(licoDevRoot, entry.path);
      const relative: any = path.relative(licoDevRoot, sourcePath);
      if (
        relative !== entry.path
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)
      ) {
        throw fixedError("lico_dev_receipt_source_path_invalid");
      }
      const sourceStat: any = await fs.lstat(sourcePath).catch(() : any => null);
      if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
        throw fixedError("lico_dev_receipt_source_unavailable");
      }
      const sourceBytes: any = await fs.readFile(sourcePath);
      return {
        path: entry.path,
        role: entry.role,
        digest: sha256(sourceBytes)
      };
    }))
  ]);
  return {
    revision,
    allowlist,
    treeDigest: sha256(canonicalJson(allowlist))
  };
}

async function deriveRoutes(licoDevRoot?: any) : Promise<any> {
  const workflowModuleUrl: any = pathToFileURL(
    path.join(licoDevRoot, "lib/workflow.ts")
  ).href;
  const { planWorkflow } = await import(workflowModuleUrl);
  if (typeof planWorkflow !== "function") {
    throw fixedError("lico_dev_receipt_planner_unavailable");
  }
  const routeEntries: any = await Promise.all(
    (Object.entries(ROUTE_PROFILES) as [string, any][]).map(async ([name, profile]: any[]) : Promise<any> => {
      const plan: any = await planWorkflow(profile, { root: licoDevRoot });
      if (
        !Array.isArray(plan?.tasks)
        || plan.tasks.length === 0
        || plan.tasks.length > 32
        || plan.tasks.some((task?: any) : any => (
          task?.owner !== "meshrix"
          || !TASK_ID.test(String(task?.id || ""))
        ))
      ) {
        throw fixedError("lico_dev_receipt_route_invalid");
      }
      const taskOrder: any = plan.tasks.map((task?: any) : any => task.id);
      if (new Set<any>(taskOrder).size !== taskOrder.length) {
        throw fixedError("lico_dev_receipt_route_invalid");
      }
      return [name, withDigest({ profile, taskOrder }, "taskOrderDigest")];
    })
  );
  return Object.fromEntries(routeEntries);
}

async function runExternalWorkflowTest(licoDevRoot?: any, nodeExecutable?: any) : Promise<any> {
  await new Promise((resolve?: any, reject?: any) : any => {
    const child: any = spawn(nodeExecutable, EXTERNAL_TEST_COMMAND.args, {
      cwd: licoDevRoot,
      stdio: "ignore"
    });
    child.once("error", () : any => reject(fixedError("lico_dev_receipt_external_test_failed")));
    child.once("close", (code?: any, signal?: any) : any => {
      if (code !== 0 || signal) {
        reject(fixedError("lico_dev_receipt_external_test_failed"));
        return;
      }
      resolve();
    });
  });
}

async function readBoundFacts(licoDevRoot?: any) : Promise<any> {
  const [source, routes] = await Promise.all([
    readSourceSnapshot(licoDevRoot),
    deriveRoutes(licoDevRoot)
  ]);
  return { source, routes };
}

export async function createLicoDevUpstreamWorkflowReceipt({
  licoDevRoot = DEFAULT_LICO_DEV_ROOT,
  nodeExecutable = process.execPath
}: Record<string, any> = {}) : Promise<any> {
  const resolvedLicoDevRoot: any = path.resolve(licoDevRoot);
  const before: any = await readBoundFacts(resolvedLicoDevRoot);
  await runExternalWorkflowTest(resolvedLicoDevRoot, nodeExecutable);
  const after: any = await readBoundFacts(resolvedLicoDevRoot);
  if (canonicalJson(before) !== canonicalJson(after)) {
    throw fixedError("lico_dev_receipt_source_changed");
  }

  const source: Record<string, any> = {
    repository: "lico-dev",
    revision: after.source.revision,
    revisionAlgorithm: "git-sha1",
    allowlist: after.source.allowlist,
    treeDigest: after.source.treeDigest,
    treeDigestAlgorithm: "sha256-canonical-json-v1"
  };
  const command: Record<string, any> = {
    executable: EXTERNAL_TEST_COMMAND.executable,
    args: [...EXTERNAL_TEST_COMMAND.args]
  };
  const externalTest: any = withDigest({
    command,
    commandDigest: sha256(canonicalJson(command)),
    revision: source.revision,
    sourceTreeDigest: source.treeDigest,
    passed: true,
    exitCode: 0
  }, "factDigest");
  const receipt: Record<string, any> = {
    schemaVersion: "v1:meshrix:lico-dev-upstream-workflow-receipt",
    receiptId: "meshrix:lico-dev-upstream-workflows",
    owner: "meshrix",
    source,
    routes: {
      digestAlgorithm: "sha256-canonical-json-v1",
      prepublication: after.routes.prepublication,
      full: after.routes.full
    },
    externalTest,
    privacy: {
      rawOutputIncluded: false,
      localInformationIncluded: false
    }
  };
  return {
    ...receipt,
    receiptDigest: sha256(canonicalJson(receipt))
  };
}

export async function generateLicoDevUpstreamWorkflowReceipt({
  check = false,
  repoRoot = REPO_ROOT,
  licoDevRoot = DEFAULT_LICO_DEV_ROOT,
  nodeExecutable = process.execPath
}: Record<string, any> = {}) : Promise<any> {
  const receipt: any = await createLicoDevUpstreamWorkflowReceipt({
    licoDevRoot,
    nodeExecutable
  });
  const expected: any = `${JSON.stringify(receipt, null, 2)}\n`;
  const outputPath: any = path.join(path.resolve(repoRoot), RECEIPT_PATH);
  const current: any = await fs.readFile(outputPath, "utf8").catch((error?: any) : any => {
    if (error?.code === "ENOENT") return null;
    throw fixedError("lico_dev_receipt_read_failed");
  });
  if (check) {
    if (current !== expected) throw fixedError("lico_dev_receipt_stale");
    return Object.freeze({ changed: false, path: RECEIPT_PATH, receipt });
  }
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, expected, "utf8");
  return Object.freeze({
    changed: current !== expected,
    path: RECEIPT_PATH,
    receipt
  });
}

const invokedDirectly: any = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const arguments_: any = process.argv.slice(2);
  if (arguments_.some((argument?: any) : any => argument !== "--check")) {
    process.stderr.write("[lico-dev-upstream-workflow-receipt] failed=invalid-arguments\n");
    process.exitCode = 1;
  } else {
    generateLicoDevUpstreamWorkflowReceipt({
      check: arguments_.includes("--check")
    }).then((result?: any) : any => {
      process.stdout.write(
        `[lico-dev-upstream-workflow-receipt] ${result.changed ? "generated" : "verified"}=true\n`
      );
    }).catch(() : any => {
      process.stderr.write(
        "[lico-dev-upstream-workflow-receipt] failed=receipt-generation-failed\n"
      );
      process.exitCode = 1;
    });
  }
}
