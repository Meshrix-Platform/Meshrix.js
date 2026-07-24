import path from "node:path";
import process from "node:process";
import { locateStorageEntity } from "../../packages/foundation/src/storage/ops-tools.mjs";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv) {
  const args = {
    userDataPath: path.resolve(ServerConfig.getDataDir()),
    jobId: "",
    batchId: "",
    objectId: ""
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    const next = argv[index + 1];

    if (current === "--data-dir" && next) {
      args.userDataPath = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    if (current === "--job-id" && next) {
      args.jobId = next;
      index += 1;
      continue;
    }

    if (current === "--batch-id" && next) {
      args.batchId = next;
      index += 1;
      continue;
    }

    if (current === "--object-id" && next) {
      args.objectId = next;
      index += 1;
    }
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));
const report = await locateStorageEntity(args);
console.log(JSON.stringify(report, null, 2));
