#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    const separatorIndex = item.indexOf("=");
    if (separatorIndex > 2) {
      parsed[item.slice(2, separatorIndex)] = item.slice(separatorIndex + 1);
      continue;
    }

    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
      continue;
    }
    parsed[key] = next;
    index += 1;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));
const requestedDataDir = args["data-dir"] || process.env.MESHRIX_SERVER_DATA_DIR || ServerConfig.getDataDir();
const resolvedDataDir = path.resolve(String(requestedDataDir));

console.log(resolvedDataDir);
