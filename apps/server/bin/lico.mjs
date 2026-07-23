#!/usr/bin/env node
import { DEFAULT_SERVER_PORT } from "../../../packages/foundation/src/config/server-env.mjs";
import { runNamedRpc, runRpc, runServerRpcCall, runToolsCommand } from "./lib/lico-cli-rpc-tools.mjs";
import { runSecretCommand } from "./lib/lico-cli-secrets.mjs";
import { runSecurityCommand } from "./lib/lico-cli-security.mjs";
import { runUpload } from "./lib/lico-cli-upload.mjs";

function parseArgs(argv) {
  const args = {
    _: [],
    file: [],
    header: [],
    path: [],
    input: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }

    const keyValue = item.slice(2);
    const equalIndex = keyValue.indexOf("=");
    const key = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
    const next = argv[index + 1];
    const value =
      inlineValue !== null
        ? inlineValue
        : !next || next.startsWith("--")
          ? true
          : next;

    if (inlineValue === null && value !== true) {
      index += 1;
    }

    if (key === "file" || key === "header" || key === "path" || key === "input") {
      args[key].push(String(value));
      continue;
    }

    args[key] = value;
  }

  return args;
}

function usage() {
  return [
    "Usage:",
    "  lico --file a.txt [--wait] [--output-result result.json]",
    "  lico --path ./local [--wait] [--output-result result.json]",
    `  lico upload --path ./local --server-url http://127.0.0.1:${DEFAULT_SERVER_PORT}`,
    "  lico rpc --method GET --path /api/healthz",
    "  lico rpc-call jobs.list --params '{\"limit\":20}'",
    "  lico interfaces --format markdown",
    "  lico health",
    "  lico jobs list|get|result|cancel|delete ...",
    "  lico jobs normalized-docs --id JOB_ID",
    "  lico jobs normalized-doc --id JOB_ID --document-id DOC_ID --output out.docx",
    "  lico settings get|set --body settings.json",
    "  lico agents create --name NAME --model MODEL [--provider PROVIDER]",
    "  lico agents update --id AGENT_UID [--name NAME] [--model MODEL] [--system-prompt TEXT]",
    "  lico agents delete --id AGENT_UID",
    "  lico secret init --target-file TARGET.json --json-stdin",
    "  lico secret rotate --target-file TARGET.json --expected-revision N --json-stdin",
    "  lico secret revoke --secret-ref secret://namespace/name --expected-revision N",
    "  lico secret list|status",
    "  lico security capability-kernel status [--backend local-file] [--alias lico-tool-grants]",
    "  lico security binding-guard status [--binding-backend local-file] [--binding-alias lico-tool-bindings]",
    "  lico security recovery export --output recovery.json --passphrase-stdin",
    "  lico security recovery import --input recovery.json --passphrase-stdin",
    "  lico tools catalog|toolsets|toolsets resolve|execute|dry-run|audit|metrics ...",
    "  lico tools metrics [--tool-id ID] [--grant-id ID] [--profile-id ID] [--route PATH] [--transport mcp|http|operation-permission] [--bucket-seconds N]",
    "  lico tools metrics export [--kind all|tool|request] [--grant-id ID] [--profile-id ID] [--output metrics.json]",
    "  lico tools metrics health [--window-seconds 300]",
    "  lico tools metrics prometheus [--window-seconds 300]",
    "  lico tools metrics storage",
    "  lico tools metrics prune --confirm --body prune.json",
    "  lico tools grants list|create|rotate|revoke ...",
    "  lico tools policy preview --body preview.json",
    "",
    "Global options:",
    "  --data-dir PATH         Directory for offline data resolution",
    `  --server-url URL        Defaults to LICO_SERVER_URL or http://127.0.0.1:${DEFAULT_SERVER_PORT}`,
    "  --body JSON_OR_FILE     JSON string or path to a JSON file",
    "  --body-file FILE        JSON request body file",
    "  --params JSON_OR_FILE   JSON-RPC params string or path to a JSON file",
    "  --params-file FILE      JSON-RPC params file",
    "  --raw-file FILE         Raw request body file for rpc/named HTTP calls",
    "  --content-type TYPE     Content-Type for --raw-file; defaults to application/octet-stream",
    "  --header 'K: V'         Extra non-secret request header; repeatable",
    "  --confirm              Add confirm=true for repair_write operations",
    "  --output FILE           Save response body",
    "  --pretty               Pretty-print JSON responses",
    "  --target-file FILE     Explicit non-secret target contract for secret init/rotate",
    "  --expected-revision N  Required compare-and-swap revision for secret rotate/revoke",
    "  --json-stdin           Read a secret JSON object from stdin for secret init/rotate",
    "  --token-stdin          Read an opaque token from stdin for secret init/rotate",
    "  --api-key-stdin        Read an API key from stdin for secret init/rotate",
    "  --http-password-stdin  Read an HTTP password from stdin for secret init/rotate",
    "  --from-env NAME        Read one secret value from an explicit environment variable",
    "  --payload-key KEY      Required payload field name when --from-env is used",
    "  --passphrase-stdin     Read recovery package passphrase from stdin",
    "  --passphrase-file FILE Read recovery package passphrase from a file",
    "  --passphrase-env NAME  Read recovery package passphrase from an environment variable",
    "  --backend NAME         Capability kernel backend: auto, local-file, macos-keychain",
    "  --alias NAME           Capability kernel alias; defaults to lico-tool-grants",
    "  --binding-backend NAME Capability Binding Guard backend; defaults to --backend or auto",
    "  --binding-alias NAME   Capability Binding Guard alias; defaults to lico-tool-bindings",
    "",
    "Upload options:",
    "  --file FILE             Upload one file; repeatable",
    "  --path FILE_OR_DIR      Upload file or folder; repeatable",
    "  --wait                  Poll job until completed",
    "  --output-result FILE    Save completed job result JSON",
    "  --settings JSON_OR_FILE Inline settings JSON or path to JSON file",
    "  --checkpoint-id ID      Defaults to a digest of the upload manifest",
    "  --chunk-size BYTES      Defaults to 1048576"
  ].join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    console.log(usage());
    return;
  }

  if (await runSecretCommand(args)) {
    return;
  }

  if (await runSecurityCommand(args)) {
    return;
  }

  if (args._[0] === "rpc") {
    await runRpc(args);
    return;
  }

  if (args._[0] === "rpc-call") {
    await runServerRpcCall(args);
    return;
  }

  if (args._[0] === "tools") {
    await runToolsCommand(args);
    return;
  }

  if (args.file.length > 0 || args.path.length > 0 || args._[0] === "upload") {
    if (args._[0] === "upload") {
      args.input.push(...args._.slice(1));
    }
    await runUpload(args);
    return;
  }

  await runNamedRpc(args, { usage });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
