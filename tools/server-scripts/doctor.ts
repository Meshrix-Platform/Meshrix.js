import path from "node:path";
import process from "node:process";
import { runStorageDoctor } from "../../packages/foundation/src/storage/ops-tools.ts";
import { ServerConfig } from "#meshrix/server-config";
import {
  describeCapabilityBindingGuardStatus,
  describeCapabilityKernelStatus
} from "../../packages/foundation/src/security/authorization/capability-kernel-status.ts";

function parseArgs(argv?: any) : any {
  const args: Record<string, any> = {
    userDataPath: path.resolve(ServerConfig.getDataDir())
  };

  for (let index: any = 0; index < argv.length; index += 1) {
    const current: any = argv[index];
    const next: any = argv[index + 1];

    if (current === "--data-dir" && next) {
      args.userDataPath = path.resolve(process.cwd(), next);
      index += 1;
      continue;
    }
    if (current === "--capability-backend" && next) {
      args.capabilityKernelBackend = next;
      index += 1;
      continue;
    }
    if (current === "--capability-alias" && next) {
      args.capabilityKernelAlias = next;
      index += 1;
      continue;
    }
    if (current === "--binding-backend" && next) {
      args.capabilityBindingBackend = next;
      index += 1;
      continue;
    }
    if (current === "--binding-alias" && next) {
      args.capabilityBindingAlias = next;
      index += 1;
      continue;
    }
    if (current.startsWith("--")) {
      throw new Error(`Unknown doctor argument: ${current}`);
    }
  }

  return args;
}

const args: any = parseArgs(process.argv.slice(2));
const report: any = await runStorageDoctor({
  userDataPath: args.userDataPath
});
report.capabilityKernel = await describeCapabilityKernelStatus({
  userDataPath: args.userDataPath,
  backend: args.capabilityKernelBackend,
  alias: args.capabilityKernelAlias
});
report.capabilityBindingGuard = await describeCapabilityBindingGuardStatus({
  userDataPath: args.userDataPath,
  backend: args.capabilityBindingBackend,
  alias: args.capabilityBindingAlias
});

console.log(JSON.stringify(report, null, 2));
