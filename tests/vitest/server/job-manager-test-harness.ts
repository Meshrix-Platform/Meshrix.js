import { createJobManager } from "../../../packages/server-runtime/src/jobs/jobs/job-manager.ts";
import { createUploadSessionStore } from "../../../packages/server-runtime/src/state/upload-session-store.ts";

export function createTestJobManager(options: Record<string, any>) : any {
  if (options.processingEnabled === false) return createJobManager(options);
  const rejectUnexpectedUploadAccess: any = async () : Promise<never> => {
    throw new Error("This JobManager test does not admit upload-session access.");
  };
  const uploadSessionStore: any = options.uploadSessionStore || createUploadSessionStore({
    userDataPath: options.userDataPath,
    custodyPort: {
      begin: rejectUnexpectedUploadAccess,
      append: rejectUnexpectedUploadAccess,
      seal: rejectUnexpectedUploadAccess
    },
    custodyDescribe: rejectUnexpectedUploadAccess
  });
  return createJobManager({
    ...options,
    uploadSessionStore,
    storageProvider: options.storageProvider || {
      commitUploadConsumptionReceipt: rejectUnexpectedUploadAccess
    }
  });
}
