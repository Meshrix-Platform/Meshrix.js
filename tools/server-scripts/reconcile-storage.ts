import path from "node:path";
import process from "node:process";
import { reconcileStorage } from "../../packages/foundation/src/storage/ops-tools.ts";
import { ServerConfig } from "#meshrix/server-config";

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = {
    userDataPath: path.resolve(ServerConfig.getDataDir()),
    apply: false,
    pruneOrphanObjects: false
  };

  for (let index: any = 0; index < argv.length; index += 1) {
    const current: any = argv[index];
    const next: any = argv[index + 1];

    if (current === "--data-dir" && next) {
      args.userDataPath = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }

    if (current === "--apply") {
      args.apply = true;
      continue;
    }

    if (current === "--prune-orphan-objects") {
      args.pruneOrphanObjects = true;
    }
  }

  return args;
}

const args: any = parseArgs(process.argv.slice(2));
const report: any = await reconcileStorage(args);
console.log(JSON.stringify(report, null, 2));
