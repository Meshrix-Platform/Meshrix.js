import { fileURLToPath } from "node:url";
import { unstable_getMiniflareWorkerOptions, unstable_readConfig, type Unstable_MiniflareWorkerOptions } from "wrangler";

const emptyEnvFile = fileURLToPath(new URL("../../../tests/support/worker-test-env.txt", import.meta.url));

interface LocalWorkerTestConfig {
  main: Unstable_MiniflareWorkerOptions["main"];
  remoteBindings: false;
  miniflare: Unstable_MiniflareWorkerOptions["workerOptions"] & {
    workers: Unstable_MiniflareWorkerOptions["externalWorkers"];
  };
}

/** Convert the maintained local Wrangler bindings without discovering private vars. */
export function localWorkerTestConfig(configPath: string): LocalWorkerTestConfig {
  const environmentKeys = [
    "CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV",
    "CLOUDFLARE_INCLUDE_PROCESS_ENV",
    "CLOUDFLARE_ENV",
  ] as const;
  const previous = environmentKeys.map((key) => process.env[key]);
  try {
    process.env.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV = "false";
    process.env.CLOUDFLARE_INCLUDE_PROCESS_ENV = "false";
    delete process.env.CLOUDFLARE_ENV;
    const config = unstable_readConfig({ config: configPath });
    // Wrangler 4.147 implements envFiles here, although its declaration omits it.
    // A nonempty list is required: [] still discovers sibling .dev.vars.
    const options: Parameters<typeof unstable_getMiniflareWorkerOptions>[2] & { envFiles: string[] } = {
      envFiles: [emptyEnvFile],
      overrides: { enableContainers: false },
    };
    const { main, workerOptions, externalWorkers } = unstable_getMiniflareWorkerOptions(config, undefined, options);
    return {
      main,
      remoteBindings: false as const,
      miniflare: { ...workerOptions, workers: externalWorkers },
    };
  } finally {
    environmentKeys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
}
