import { createJobArtifactHandlers } from "./jobs-controller-artifact-handlers.ts";
import { createJobHandlers } from "./jobs-controller-job-handlers.ts";
import {
  createLoadNormalizedDocumentStoreRuntime,
  optionalStorageObjectProvider,
  requireJobWorkflowProvider,
  requireUploadSessionStore
} from "./jobs-controller-providers.ts";
import { createUploadSessionHandlers } from "./jobs-controller-upload-handlers.ts";
import { defaultArchiveBatchResolver } from "./jobs-controller-job-admission.ts";
import { createWorkQueueHandlers } from "./jobs-controller-work-queue-handlers.ts";

export function createJobsController({
  userDataPath,
  jobWorkflowProvider = null,
  storageProvider = null,
  deletionCoordinator,
  getDiscoveryState,
  proxyApiRequest,
  protocolEventBus,
  loadNormalizedDocumentStore = null,
  uploadSessionStore = null,
  uploadWorkspaceMaterializationProvider = null,
  resolveArchiveBatchIdentity = defaultArchiveBatchResolver
}: Record<string, any>) : any {
  const checkpointUploadSessionStore: any = requireUploadSessionStore(uploadSessionStore);
  const jobWorkflow: any = requireJobWorkflowProvider(jobWorkflowProvider);
  const storageObjectProvider: any = optionalStorageObjectProvider(storageProvider);
  const loadNormalizedDocumentStoreRuntime: any = createLoadNormalizedDocumentStoreRuntime(
    loadNormalizedDocumentStore
  );

  const context: Record<string, any> = {
    userDataPath,
    checkpointUploadSessionStore,
    jobWorkflow,
    storageObjectProvider,
    deletionCoordinator,
    getDiscoveryState,
    proxyApiRequest,
    protocolEventBus,
    loadNormalizedDocumentStoreRuntime,
    resolveArchiveBatchIdentity,
    uploadWorkspaceMaterializationProvider
  };

  return {
    ...createUploadSessionHandlers(context),
    ...createJobHandlers(context),
    ...createWorkQueueHandlers(context),
    ...createJobArtifactHandlers(context)
  };
}
