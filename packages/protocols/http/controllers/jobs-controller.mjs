import { createJobArtifactHandlers } from "./jobs-controller-artifact-handlers.mjs";
import { createJobHandlers } from "./jobs-controller-job-handlers.mjs";
import {
  createLoadNormalizedDocumentStoreRuntime,
  optionalStorageObjectProvider,
  requireJobWorkflowProvider,
  requireUploadSessionStore
} from "./jobs-controller-providers.mjs";
import { createUploadSessionHandlers } from "./jobs-controller-upload-handlers.mjs";
import { defaultArchiveBatchResolver } from "./jobs-controller-upload-verification.mjs";
import { createWorkQueueHandlers } from "./jobs-controller-work-queue-handlers.mjs";

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
}) {
  const checkpointUploadSessionStore = requireUploadSessionStore(uploadSessionStore);
  const jobWorkflow = requireJobWorkflowProvider(jobWorkflowProvider);
  const storageObjectProvider = optionalStorageObjectProvider(storageProvider);
  const loadNormalizedDocumentStoreRuntime = createLoadNormalizedDocumentStoreRuntime(
    loadNormalizedDocumentStore
  );

  const context = {
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
