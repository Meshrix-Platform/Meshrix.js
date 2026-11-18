# Observable Performance Evidence Contract

## Contents

- Claim selection
- Process and workload isolation
- Required observations
- Bounded collection
- Reduction order
- Scenario matrix
- Report contract
- Verification and interpretation

## Claim selection

Choose one evidence claim before execution:

1. `observed_smoke` detects gross regression and proves the observation path.
2. `capacity_profile` determines declared-environment throughput and tail
   latency under a fixed scenario.
3. `memory_leak_gate` detects retained resource growth after warmup and
   collection.
4. `fault_profile` evaluates overload, dependency failure, restart, and
   recovery semantics.

The report schema, workload, thresholds, and pass criteria must name the same
claim. `observed_smoke` always sets `capacityCertified: false`. Only the
canonical platform acceptance reducer may make a platform-readiness decision.

## Process and workload isolation

For capacity or fault evidence, run these as separate fresh processes:

- scenario controller;
- load driver;
- synthetic fixture or neutral peer;
- complete Meshrix.js service;
- independent reducer when the workflow supports it.

Use an isolated temporary data root and loopback-only synthetic endpoints.
Never target a production, public, or user-configured service from a catalog
performance task.

Warm the service before measurement. Keep warmup results out of the measured
histograms. Declare duration, target rate, concurrency, maximum in-flight
requests, request timeout, response byte limit, and total operation count.

Capacity work uses open-loop scheduled arrivals. Record the difference between
planned and actual issue time and reject unbounded driver queues. Closed-loop
concurrency is acceptable only for smoke or explicitly named saturation work.

## Required observations

### Driver

- planned, issued, completed, successful, expected rejection, unexpected
  failure, timeout, and overflow counts;
- effective requests per second;
- response-latency P50, P95, P99, and maximum;
- schedule-delay P50, P95, P99, and maximum;
- response bytes consumed and discarded by bounded policy.

### Service runtime

- event-loop-delay P50, P95, P99, and maximum;
- event-loop utilization;
- CPU to wall-clock ratio;
- RSS, heap used, external, and array-buffer bytes;
- GC count, total duration, and maximum duration;
- observation interval, sample count, backpressure, and dropped samples.

Use Node's maintained `perf_hooks` APIs for event-loop delay, ELU, GC entries,
and bounded histograms. A runtime observer sends numeric aggregates through
private IPC and resets interval histograms after each sample.

### Domain resources

When the target path exposes them, observe fixed-vocabulary aggregates for:

- admission and queue depth, wait, rejection, and fairness;
- telemetry buffer depth, aggregation, shedding, and flush duration;
- transport pool entries, leases, waiters, reuse, and retirement;
- endpoint in-flight state, selection, ejection, and recovery;
- SQLite transaction, busy, WAL, and checkpoint behavior;
- log and persistent byte, record, and file growth.

Runtime identifier, user, tenant, Grant, request, URL, path, host, payload, and
exception text are forbidden metric dimensions.

## Bounded collection

Every profile declares hard limits for:

- processes and process lifetime;
- requests, rate, in-flight work, retries, and response bytes;
- runtime samples, histogram range and precision, labels, and series;
- captured child output and report bytes;
- temporary artifacts, log growth, storage growth, and cleanup time.

Do not retain an array of per-request observations. Use a fixed-range
histogram and counters. Do not queue IPC indefinitely; record backpressure and
fail the observation claim when samples are lost.

Passing runs retain one compact report. Raw output, request bodies, responses,
profiles, readiness state, and service data remain private and temporary. A
separate explicitly authorized diagnostic flow is required to retain a raw
failure profile.

## Reduction order

Reduce evidence in this order and stop stronger interpretation when an earlier
stage fails:

1. schema, source, freshness, and declared profile;
2. exact workload completion and expected status classes;
3. privacy projection and collection budgets;
4. safety cutoffs and observer coverage;
5. scenario semantics, including expected rejection and retry bounds;
6. throughput, P95/P99, and schedule delay;
7. fairness, queueing, and resource recovery;
8. relative regression against compatible repeated baselines.

Do not compute a favorable latency result from incomplete requests. Timeouts,
driver overflow, lost samples, or a resource cutoff are failures, not omitted
observations.

## Scenario matrix

Capacity evidence ultimately covers:

- sustained fixed-rate load;
- short burst and post-burst recovery;
- noisy-neighbor fairness between synthetic identities;
- slow client and stream backpressure;
- boundary and oversized payloads;
- upstream connection, timeout, and response failures;
- controlled process restart;
- shared quota across fresh service replicas.

Each scenario declares expected status classes and failure reasons. Expected
overload rejection is not counted as success or unexpected failure; it is a
separate outcome with its own SLO.

## Report contract

A durable report may contain only:

- schema, verifier, claim, and profile identifiers;
- bounded workload configuration and aggregate counts;
- fixed percentiles and resource maxima;
- finite environment classification without machine identity;
- stable violation codes;
- privacy, cleanup, and cache-retention booleans;
- `observedSmokeReady` or the claim-specific verdict;
- `capacityCertified: false` unless the complete capacity contract ran.

Do not include paths, hostnames, addresses, ports, process IDs, commands,
environment variables, output tails, stack traces, payloads, responses,
credentials, runtime rows, user data, or machine identity. Atomically replace
the report rather than appending a history.

## Verification and interpretation

Use this sequence while implementing:

1. unit-test histogram and reducer math with synthetic inputs;
2. test probe IPC, sample limits, invalid samples, timeouts, and cleanup;
3. test report privacy and byte budgets;
4. run the catalog plan without side effects;
5. run the real profile only with explicit side-effect authorization;
6. run the smallest changed-file regression closure;
7. run the full repository gate once after all bounded changes are complete.

Establish thresholds from repeated clean runs on one declared environment
class. Use both absolute safety ceilings and relative regression limits. Do not
compare different runtime versions, hardware classes, scenario definitions, or
functional configurations as if they were the same baseline.
