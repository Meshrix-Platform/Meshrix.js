---
name: meshrix-js-performance-load-testing
description: Plan, implement, run, and interpret bounded observable Meshrix.js performance tests, including load or stress smoke, capacity and saturation profiles, throughput and P95/P99 regression, event-loop and ELU observation, CPU and memory pressure, noisy-neighbor fairness, failure recovery, and performance-result reduction. Use whenever a task mentions pressure testing, load testing, performance regression, capacity, throughput, latency percentiles, resource saturation, benchmark tooling, or comparison before and after an optimization.
---

# Meshrix.js Performance Load Testing

Read [the observation and evidence contract](references/observation-contract.md)
completely before designing, changing, running, or interpreting a performance
profile.

## Select one claim

- Use **observed smoke** for a fast bounded regression signal and probe
  validation. It is not capacity evidence.
- Use **capacity profile** for declared-environment throughput, P95/P99,
  fairness, saturation, and recovery evidence. Require an external driver and
  fresh service processes.
- Use `$meshrix-js-memory-leak-detection` for retained heap, profiler live bytes,
  RSS, log, or storage growth across repeated post-warmup work.
- Use **fault profile** for overload shedding, slow clients, provider failure,
  restart, retry amplification, and resource recovery.

Do not merge these claims or promote a child report into platform readiness.

## Run the current observed smoke

Plan first:

```sh
npm run server:stress:mcp-gateway-observed
```

Run only when the user has explicitly authorized isolated runtime data and a
local service process:

```sh
npm run server:stress:mcp-gateway-observed
```

The workflow starts the existing MCP gateway stress smoke in a child process,
injects a private runtime observer, and emits one bounded report containing
only aggregate workload, CPU, memory, ELU, event-loop-delay, and GC facts. It
always records `capacityCertified: false`.

Use the separate memory gate when retained growth is in scope:

```sh
npm run server:verify:memory-leaks
npm run server:verify:memory-leaks
```

## Change or add a profile

1. Resolve the owning repository path with `git status --short` and load
   `$meshrix-js-repository` plus the relevant specialist skills.
2. Keep the load generator, fixture, service, runtime observer, and reducer as
   explicit owners. A capacity profile must put the driver and service in
   different processes.
3. Use an open-loop schedule for capacity work, with finite duration, request
   count, rate, in-flight requests, response bytes, and timeout.
4. Record latencies in fixed-range histograms rather than retaining one object
   per request. Record schedule delay so coordinated omission remains visible.
5. Send only bounded numeric runtime samples through private IPC. Never send
   paths, addresses, process identifiers, environment values, payloads,
   responses, stacks, credentials, or tenant facts.
6. Reduce workload integrity before interpreting latency or resources. Failed
   or incomplete load invalidates the performance claim.
7. Atomically replace one compact report and delete the exact private run root.
   Preserve dependency and profiler caches.
8. Register executable commands in `workflows/catalog.json`, regenerate the
   skill lock, and use `$meshrix-js-regression-planner` for the focused closure.

## Interpret results

Compare only identical scenario and environment classifications. Lead with
workload completeness, unexpected errors, safety cutoffs, observation
coverage, P95/P99, schedule delay, throughput, fairness, and resource recovery.
Treat a single run as diagnostic evidence; use repeated clean baselines before
setting or changing a regression threshold.

Never raise a limit merely to make a failure pass. Identify the owning hot
path, change one bounded subsystem, rerun the smallest profile, and report the
remaining uncertainty explicitly.
