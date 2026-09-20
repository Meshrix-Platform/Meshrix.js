import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";

export const GATEWAY_BENCHMARK_SCHEMA = "v0.0.1:meshrix:gateway-benchmark-1" as const;

export interface GatewayBenchmarkOptions {
  readonly iterations?: number;
  readonly concurrency?: number;
  readonly evaluate?: boolean;
  readonly operation?: () => Promise<void>;
}

export interface GatewayBenchmarkReport {
  readonly schemaVersion: typeof GATEWAY_BENCHMARK_SCHEMA;
  readonly evaluated: boolean;
  readonly workload: { readonly iterations: number; readonly concurrency: number };
  readonly measurements: { readonly elapsedMs?: number; readonly operationsPerSecond?: number };
  readonly resourceContract: { readonly bounded: true; readonly closeRequired: true; readonly externalNetwork: false };
}

export async function runGatewayBenchmark(options: GatewayBenchmarkOptions = {}): Promise<GatewayBenchmarkReport> {
  const iterations = Math.max(1, Math.min(100_000, Math.floor(options.iterations ?? 64)));
  const concurrency = Math.max(1, Math.min(64, Math.floor(options.concurrency ?? 1)));
  if (!options.evaluate) {
    return Object.freeze({
      schemaVersion: GATEWAY_BENCHMARK_SCHEMA,
      evaluated: false,
      workload: Object.freeze({ iterations, concurrency }),
      measurements: Object.freeze({}),
      resourceContract: Object.freeze({ bounded: true, closeRequired: true, externalNetwork: false })
    });
  }
  const operation = options.operation ?? (async () => undefined);
  const started = performance.now();
  let completed = 0;
  while (completed < iterations) {
    const batch = Math.min(concurrency, iterations - completed);
    await Promise.all(Array.from({ length: batch }, () => operation()));
    completed += batch;
  }
  const elapsedMs = Math.max(0.001, performance.now() - started);
  return Object.freeze({
    schemaVersion: GATEWAY_BENCHMARK_SCHEMA,
    evaluated: true,
    workload: Object.freeze({ iterations, concurrency }),
    measurements: Object.freeze({ elapsedMs, operationsPerSecond: (iterations * 1000) / elapsedMs }),
    resourceContract: Object.freeze({ bounded: true, closeRequired: true, externalNetwork: false })
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const evaluate = args.includes("--evaluate");
  const output = args[args.indexOf("--output") + 1];
  runGatewayBenchmark({ evaluate }).then(async (report) => {
    const text = `${JSON.stringify(report, null, 2)}\n`;
    if (output && output !== "--evaluate") await writeFile(output, text, { encoding: "utf8", mode: 0o600 });
    else console.log(text);
  }).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}

