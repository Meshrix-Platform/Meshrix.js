import { createJobManager } from "../../jobs/jobs/job-manager.ts";
import { createQueuedJobWorkflowProvider } from "../queued-job-workflow-provider.ts";
import { createServerCompositionRoot } from "../composition-root.ts";
import { getRuntimeLogger } from "#meshrix/product-api";

export async function createImportWorkerRuntime({ userDataPath }: Record<string, any>) : Promise<any> {
  const compositionRoot: any = await createServerCompositionRoot({
    userDataPath,
    runtimeLogger: getRuntimeLogger()
  });
  const {
    protocolEventBus,
    queueApplicationPort,
    storageProvider,
    uploadSessionStore
  } = compositionRoot;
  let jobManager: any;
  let jobWorkflowProvider: any;
  try {
    jobManager = createJobManager({
      userDataPath,
      processingEnabled: true,
      protocolEventBus,
      storageProvider,
      uploadSessionStore
    });
    jobWorkflowProvider = await createQueuedJobWorkflowProvider({
      jobManager,
      queueApplicationPort,
      autoStart: true
    });
    queueApplicationPort.start();
  } catch (error: any) {
    await queueApplicationPort?.stop?.().catch(() : any => {});
    await jobWorkflowProvider?.close?.().catch(() : any => {});
    await jobManager?.close?.().catch(() : any => {});
    await compositionRoot.close().catch(() : any => {});
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
      await jobManager.close();
      await compositionRoot.close();
    }
  };
}
