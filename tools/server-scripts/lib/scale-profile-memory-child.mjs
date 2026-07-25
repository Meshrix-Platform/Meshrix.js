#!/usr/bin/env node
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import {
  createFixedQueueTimeSource,
  createQueueDefinitionRegistry,
  createQueuePushDispatcher,
  createSqliteWorkQueueStore,
  DEFAULT_QUEUE_POLICY,
} from "../../../packages/foundation/src/work-queue/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const reportPath = path.resolve(String(process.argv[2] || ""));
const SYNTHETIC_LOAD_TEST_SCOPE = Object.freeze({
  tenantId: "synthetic-load-test-tenant",
  workspaceId: "synthetic-load-test-workspace",
  projectId: "synthetic-load-test-project",
});

async function main() {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-scale-profile-memory-"));
  try {
    const registry = createQueueDefinitionRegistry();
    const definition = registry.registerQueueDefinition({
      queueDefinitionId: "queue.scale.profile.memory",
      label: "queue.scale.profile.memory",
      ownerCapability: "scale-memory-verification",
      policy: {
        capacity: {
          ...DEFAULT_QUEUE_POLICY.capacity,
          maxOutstanding: 16,
          maxLeased: 8,
        },
        retention: DEFAULT_QUEUE_POLICY.retention,
      },
    });
    const store = createSqliteWorkQueueStore({
      userDataPath,
      queueDefinitionId: definition.queueDefinitionId,
      timeSource: createFixedQueueTimeSource(0),
    });
    const workerRuntime = {
      workerId: "scale-memory-worker",
      async runLeased() {
        const buffer = Buffer.alloc(64 * 1024, 0x5a);
        return { action: "completed", bufferLength: buffer.length };
      },
    };
    const dispatcher = createQueuePushDispatcher({
      store,
      workerRuntime,
      queueDefinitionId: definition.queueDefinitionId,
    });
    const before = process.memoryUsage().rss;
    let peak = before;
    const startedAt = performance.now();
    for (let index = 0; index < 32; index += 1) {
      await store.enqueue({
        queueDefinitionId: definition.queueDefinitionId,
        ...SYNTHETIC_LOAD_TEST_SCOPE,
        payloadRef: { iteration: index },
      });
      await dispatcher.dispatchOnce();
      peak = Math.max(peak, process.memoryUsage().rss);
    }
    await dispatcher.drain({ timeoutMs: 5_000 });
    store.close();
    const durationMs = performance.now() - startedAt;
    const payload = {
      schemaVersion: "v0.0.1:scale:scale-profile-memory-child-1",
      generatedAt: new Date().toISOString(),
      profile: "scale",
      accepted: peak - before <= 64 * 1024 * 1024,
      summary: {
        iterations: 32,
        durationMs: Math.round(durationMs * 1000) / 1000,
        rssIncreaseBytes: Math.max(0, peak - before),
        rssBudgetBytes: 64 * 1024 * 1024,
      },
      privacySafe: true,
    };
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    if (!payload.accepted) process.exitCode = 1;
  } finally {
    await fs.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch(() => {
  process.exitCode = 1;
});
