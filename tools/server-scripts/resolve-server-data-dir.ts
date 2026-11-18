#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv?: any) : any {
  const parsed: Record<string, any> = {};
  for (let index: any = 0; index < argv.length; index += 1) {
    const item: any = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const separatorIndex: any = item.indexOf("=");
    if (separatorIndex > 2) {
      parsed[item.slice(2, separatorIndex)] = item.slice(separatorIndex + 1);
      continue;
    }

    const key: any = item.slice(2);
    const next: any = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

const args: any = parseArgs(process.argv.slice(2));
const requestedDataDir: any = args["data-dir"] || process.env.MESHRIX_SERVER_DATA_DIR || ServerConfig.getDataDir();
const resolvedDataDir: any = path.resolve(String(requestedDataDir));

console.log(resolvedDataDir);
