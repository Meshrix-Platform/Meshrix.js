import { createJobManager } from "../../jobs/jobs/job-manager.mjs";
import { createProtocolEventBus } from "#lico/protocols/pubsub/event-bus";
import { createQueuedJobWorkflowProvider } from "../queued-job-workflow-provider.mjs";
import { createQueueApplicationPort } from "../queue-application-port.mjs";

export async function createImportWorkerRuntime({ userDataPath }) {
  const protocolEventBus = createProtocolEventBus({ userDataPath });
  const jobManager = createJobManager({
    userDataPath,
    processingEnabled: true,
    protocolEventBus
  });
  let jobWorkflowProvider;
  let queueApplicationPort;
  try {
    queueApplicationPort = await createQueueApplicationPort({ userDataPath });
    jobWorkflowProvider = await createQueuedJobWorkflowProvider({
      jobManager,
      queueApplicationPort,
      autoStart: true
    });
    queueApplicationPort.start();
  } catch (error) {
    await queueApplicationPort?.close?.().catch(() => {});
    await jobManager.close().catch(() => {});
    await protocolEventBus.close?.().catch(() => {});
    throw error;
  }

  return {
    mode: "active",
    async tick() {
      const jobs = await jobWorkflowProvider.listJobs({ limit: 1 });
      return {
        status: "running",
        details: {
          mode: "external_import_queue_worker",
          jobs: jobs.summary
        }
      };
    },
    async close() {
      await queueApplicationPort.stop();
      await jobWorkflowProvider.close();
      await queueApplicationPort.close();
      await jobManager.close();
      await protocolEventBus.close?.();
    }
  };
}
