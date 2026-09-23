# Optional Node gateway benchmark

This is an opt-in, source-CLI-only development experiment. It does not run in
Core deployment, installation, acceptance or release, and does not change the
gateway's implementation. [中文说明](gateway-benchmark.zh-CN.md).

## Mandatory order: usable Meshrix first, performance second

Before implementing or validating this benchmark, running a load experiment, or optimizing
performance, establish current evidence that the same Meshrix candidate and relevant configuration
are usable. Follow [the repository rule](../../AGENTS.md#functional-availability-before-benchmarking-and-optimization):

1. Start the real backend through a supported entry point and complete an authorized operation.
2. Open the real Console in a browser, verify assets/authentication/rendering, and complete a UI
   action that reaches that backend and displays the correct result.
3. Use a standard MCP client through real Meshrix to a controlled upstream and verify the result.
4. Verify normal settlement/shutdown; record candidate, configuration, checks, observed results and
   privacy-safe evidence with explicit passed/failed/not_run/blocked states.

Builds, typechecks, a health endpoint, benchmark self-tests, Mock tests, npm/archive checks and image
construction are not this evidence. A source-CLI fixture alone does not prove Console/backend
usability. Neither the separate package nor `--profile fixture` exempts performance work from the
prerequisite. Missing, failed or stale evidence pauses benchmark work; continue authorized functional
diagnosis/repair instead. Relevant product/configuration changes require fresh affected checks.
Do not execute performance work alongside the functional verification it depends on, and do not
replace this bounded prerequisite with repeated full regressions. Final regression/review follow
the functional and authorized performance work, not the other way around.

This is an execution rule, not a claim that the benchmark CLI automatically verifies the frontend.
The commands below apply only after the functional prerequisite is satisfied.

## Explicit development installation and invocation

The independent private `meshrix-node-benchmark` package is maintained only
under `Meshrix.js-Benchmark/packages/node-benchmark` (outside this repository).
Pack it explicitly from that directory, then install the resulting tarball in
the ignored Meshrix development prefix:

```sh
npm pack --json --ignore-scripts --pack-destination <local-artifact-directory>
npm install --prefix .cache/gateway-benchmark --save-dev --ignore-scripts --no-audit --no-fund <local-artifact-directory>/meshrix-node-benchmark-0.1.0.tgz
npm run gateway:benchmark -- --help
npm run gateway:benchmark
npm run gateway:benchmark -- --evaluate --profile standard --output build/reports/gateway-benchmark.json
```

The first pack command is run from the *independent package directory*;
the remaining commands run from the Meshrix.js root. No root dependency or
lockfile is added. Remove only the owned ignored development installation
when finished. `--help` loads no package or process; the default invocation
reads an installed package and prints `evaluated:false` without latency data.
Explicit standard evaluation additionally requires clean committed executable
SUT inputs and `MESHRIX_BENCHMARK_TOOL_COMMIT=<40-hex-character commit>` from
the exact independent package checkout committed and packed by the maintainer.
Do not run the standard profile on an uncommitted or locally modified candidate.
`--profile fixture` is for tiny local correctness checks only and cannot emit
committed-standard evidence. A missing package is a named prerequisite failure,
not an auto-download, sibling-checkout import or no-op replacement.

The installed tool starts an independent generator, the unchanged real gateway
source CLI with a private local service profile, and an independent synthetic
upstream process. Both direct-to-upstream and gateway paths use the same modern
MCP request/response validation and separately observed effects. It measures
only one successful read-only `tools/call` single-completion shape with
loopback HTTP/1.1 keep-alive; it does not assert complete protocol or installed
product conformance. The standalone package README documents the precise
profile, arrival schedule, calibration, workload, RTT boundary, count equations,
unknown hardware properties, outcome classes, privacy and cleanup.

An unfilled histogram has `null`, not zero. Every planned arrival is reconciled;
skipped scheduling means generator limitation, full in-flight admission means a
client budget limit without known target attribution. CPU one-core ratios can
exceed one; logical available CPUs are not dedicated cores. Direct minus gateway
latency includes transport, scheduling and client effects, not a pure gateway
service cost. The 100 RPS ceiling is a *bounded point*, not maximum capacity,
a pass/fail SLO, or a ten-percent comparison against historical work. Candidate
and source CLI observations do not close independent PR acceptance findings.

`npm run test:gateway-benchmark` covers installed tool tests and tiny real CLI
fixtures. `npm run test:gateway-benchmark:distribution` checks actual fresh
build and product npm/source artifacts; the Docker final/runtime and runtime-ui
images require a committed candidate and usable local engine, separately
inspected for actual filesystem **and retained layer** absence. Source flags,
private npm metadata, `.dockerignore`, or a Dockerfile line alone never prove
artifact absence. No archive or image is published by these commands.
