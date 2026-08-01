import path from "node:path";
import process from "node:process";
import { locateStorageEntity } from "../../packages/foundation/src/storage/ops-tools.ts";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = {
    userDataPath: path.resolve(ServerConfig.getDataDir()),
    jobId: "",
    batchId: "",
    objectId: ""
  };

  for (let index: any = 0; index < argv.length; index += 1) {
    const current: any = argv[index];
    const next: any = argv[index + 1];

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

const args: any = parseArgs(process.argv.slice(2));
const report: any = await locateStorageEntity(args);
console.log(JSON.stringify(report, null, 2));
