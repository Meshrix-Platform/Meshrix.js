import { createJobManager } from "../../jobs/jobs/job-manager.ts";
import { createProtocolEventRuntime } from "../../events/protocol-event-runtime.ts";
import { createProtocolEventBus } from "#meshrix/protocols/pubsub/event-bus";
import { createQueuedJobWorkflowProvider } from "../queued-job-workflow-provider.ts";
import { createQueueApplicationPort } from "../queue-application-port.ts";

export async function createImportWorkerRuntime({ userDataPath }: Record<string, any>) : Promise<any> {
  const protocolEventRuntime: any = await createProtocolEventRuntime({
    userDataPath,
    createEventBus: createProtocolEventBus
  });
  const { protocolEventBus } = protocolEventRuntime;
  const jobManager: any = createJobManager({
    userDataPath,
    processingEnabled: true,
    protocolEventBus
  });
  let jobWorkflowProvider: any;
  let queueApplicationPort: any;
  try {
    queueApplicationPort = await createQueueApplicationPort({ userDataPath });
    jobWorkflowProvider = await createQueuedJobWorkflowProvider({
      jobManager,
      queueApplicationPort,
      autoStart: true
    });
    queueApplicationPort.start();
  } catch (error: any) {
    await queueApplicationPort?.close?.().catch(() : any => {});
    await jobManager.close().catch(() : any => {});
    await protocolEventRuntime.close().catch(() : any => {});
    throw error;
  }

  return {
    mode: "active",
    async tick() : Promise<any> {
      const jobs: any = await jobWorkflowProvider.listJobs({ limit: 1 });
      return {
        status: "running",
        details: {
          mode: "external_import_queue_worker",
          jobs: jobs.summary
        }
      };
    },
    async close() : Promise<any> {
      await queueApplicationPort.stop();
      await jobWorkflowProvider.close();
      await queueApplicationPort.close();
      await jobManager.close();
      await protocolEventRuntime.close();
    }
  };
}
