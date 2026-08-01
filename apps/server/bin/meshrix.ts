#!/usr/bin/env node
import { DEFAULT_SERVER_PORT } from "../../../packages/foundation/src/config/server-env.ts";
import { runNamedRpc, runRpc, runServerRpcCall, runToolsCommand } from "./lib/meshrix-cli-rpc-tools.ts";
import { runSecretCommand } from "./lib/meshrix-cli-secrets.ts";
import { runSecurityCommand } from "./lib/meshrix-cli-security.ts";
import { runUpload } from "./lib/meshrix-cli-upload.ts";

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = {
    _: [],
    file: [],
    header: [],
    path: [],
    input: []
  };

  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }

    const keyValue: any = item.slice(2);
    const equalIndex: any = keyValue.indexOf("=");
    const key: any = equalIndex >= 0 ? keyValue.slice(0, equalIndex) : keyValue;
    const inlineValue: any = equalIndex >= 0 ? keyValue.slice(equalIndex + 1) : null;
    const next: any = argv[index + 1];
    const value: any =
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

function usage() : any {
  return [
    "Usage:",
    "  meshrix --file a.txt [--wait] [--output-result result.json]",
    "  meshrix --path ./local [--wait] [--output-result result.json]",
    `  meshrix upload --path ./local --server-url http://127.0.0.1:${DEFAULT_SERVER_PORT}`,
    "  meshrix rpc --method GET --path /api/healthz",
    "  meshrix rpc-call jobs.list --params '{\"limit\":20}'",
    "  meshrix interfaces --format markdown",
    "  meshrix health",
    "  meshrix jobs list|get|result|cancel|delete ...",
    "  meshrix jobs normalized-docs --id JOB_ID",
    "  meshrix jobs normalized-doc --id JOB_ID --document-id DOC_ID --output out.docx",
    "  meshrix settings get|set --body settings.json",
    "  meshrix agents create --name NAME --model MODEL [--provider PROVIDER]",
    "  meshrix agents update --id AGENT_UID [--name NAME] [--model MODEL] [--system-prompt TEXT]",
    "  meshrix agents delete --id AGENT_UID",
    "  meshrix secret init --target-file TARGET.json --json-stdin",
    "  meshrix secret rotate --target-file TARGET.json --expected-revision N --json-stdin",
    "  meshrix secret revoke --secret-ref secret://namespace/name --expected-revision N",
    "  meshrix secret list|status",
    "  meshrix security capability-kernel status [--backend local-file] [--alias meshrix-tool-grants]",
    "  meshrix security binding-guard status [--binding-backend local-file] [--binding-alias meshrix-tool-bindings]",
    "  meshrix security recovery export --output recovery.json --passphrase-stdin",
    "  meshrix security recovery import --input recovery.json --passphrase-stdin",
    "  meshrix tools catalog|toolsets|toolsets resolve|execute|dry-run|audit|metrics ...",
    "  meshrix tools metrics [--tool-id ID] [--grant-id ID] [--profile-id ID] [--route PATH] [--transport mcp|http|operation-permission] [--bucket-seconds N]",
    "  meshrix tools metrics export [--kind all|tool|request] [--grant-id ID] [--profile-id ID] [--output metrics.json]",
    "  meshrix tools metrics health [--window-seconds 300]",
    "  meshrix tools metrics prometheus [--window-seconds 300]",
    "  meshrix tools metrics storage",
    "  meshrix tools metrics prune --confirm --body prune.json",
    "  meshrix tools grants list|create|rotate|revoke ...",
    "  meshrix tools policy preview --body preview.json",
    "",
    "Global options:",
    "  --data-dir PATH         Directory for offline data resolution",
    `  --server-url URL        Defaults to MESHRIX_SERVER_URL or http://127.0.0.1:${DEFAULT_SERVER_PORT}`,
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
    "  MESHRIX_LOCAL_SECRET_MASTER_KEY_FILE must name an external 32-byte hex key file for secret init/rotate",
    "  --payload-key KEY      Required payload field name when --from-env is used",
    "  --passphrase-stdin     Read recovery package passphrase from stdin",
    "  --passphrase-file FILE Read recovery package passphrase from a file",
    "  --passphrase-env NAME  Read recovery package passphrase from an environment variable",
    "  --backend NAME         Capability kernel backend: auto, local-file, macos-keychain",
    "  --alias NAME           Capability kernel alias; defaults to meshrix-tool-grants",
    "  --binding-backend NAME Capability Binding Guard backend; defaults to --backend or auto",
    "  --binding-alias NAME   Capability Binding Guard alias; defaults to meshrix-tool-bindings",
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

async function main() : Promise<any> {
  const args: any = parseArgs(process.argv.slice(2));
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

main().catch((error?: any) : any => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
