import {
  STATIC_SEMANTIC_FAMILY_COUNT,
  resolveAcpPromptRisk
} from "./operation-registry-governed-definitions.mjs";

export const CONTEXT_JOB_OPERATION_DEFINITIONS = Object.freeze([
{
      id: "context.preview",
      feature: "context_runtime",
      label: "预览上下文编译结果",
      target: { controller: "system", method: "handleContextPreview" },
      http: { method: "POST", path: "/api/context/preview" },
      rpc: { method: "context.preview", body: "params" },
      cli: { command: ["context", "preview"], usage: "context preview --body input.json" },
      requiredScopes: ["console:read"]
    },
{
      id: "context.compaction.preview",
      feature: "context_runtime",
      label: "预览上下文压缩结果",
      target: { controller: "system", method: "handleContextCompactionPreview" },
      http: { method: "POST", path: "/api/context/compaction/preview" },
      rpc: { method: "context.compaction.preview", body: "params" },
      cli: { command: ["context", "compaction", "preview"], usage: "context compaction preview --body input.json" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          contextProfileId: { type: "string" },
          profileId: { type: "string" },
          sessionId: { type: "string" },
          messages: { type: "array" },
          transcript: { type: "array" },
          force: { type: "boolean" }
        }
      },
      requiredScopes: ["console:read"]
    },
{
      id: "context.compaction.run",
      feature: "context_runtime",
      label: "执行上下文压缩",
      target: { controller: "system", method: "handleContextCompactionRun" },
      http: { method: "POST", path: "/api/context/compaction/run" },
      rpc: { method: "context.compaction.run", body: "params" },
      cli: { command: ["context", "compaction", "run"], usage: "context compaction run --body input.json" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          contextProfileId: { type: "string" },
          profileId: { type: "string" },
          sessionId: { type: "string" },
          messages: { type: "array" },
          transcript: { type: "array" },
          force: { type: "boolean" },
          persist: { type: "boolean" }
        }
      },
      requiredScopes: ["workspace:write"]
    },
{
      id: "context.compaction.records",
      feature: "context_runtime",
      label: "上下文压缩记录",
      target: { controller: "system", method: "handleContextCompactionRecords" },
      http: {
        method: "GET",
        path: "/api/context/compaction/records",
        query: [{ name: "limit", aliases: ["limit"], type: "number" }],
        coerce: { limit: "number" }
      },
      rpc: { method: "context.compaction.records" },
      cli: { command: ["context", "compaction", "records"], usage: "context compaction records --limit 50" },
      requiredScopes: ["console:read"]
    },
{
      id: "context.session_memory.get",
      feature: "agent_memory",
      label: "读取上下文会话记忆",
      target: { controller: "system", method: "handleContextSessionMemory" },
      http: {
        method: "GET",
        path: "/api/context/session-memory",
        query: [
          { name: "limit", aliases: ["limit"], type: "number" },
    { name: "sessionId", aliases: ["session-id", "sessionId"] },
    { name: "profileId", aliases: ["profile-id", "profileId"] }
        ],
        coerce: { limit: "number" }
      },
      rpc: { method: "context.session_memory.get" },
      cli: { command: ["context", "session-memory"], usage: "context session-memory --limit 50" },
      requiredScopes: ["console:read"]
    },
{
      id: "context.session_memory.clear",
      feature: "agent_memory",
      label: "清理上下文会话记忆",
      target: { controller: "system", method: "handleContextSessionMemoryClear" },
      http: { method: "POST", path: "/api/context/session-memory/clear" },
      rpc: { method: "context.session_memory.clear", body: "params" },
      cli: { command: ["context", "session-memory", "clear"], usage: "context session-memory clear --body clear.json" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          sessionId: { type: "string" },
          profileId: { type: "string" },
          reason: { type: "string" },
          confirm: { type: "boolean" }
        }
      },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "context.build_records",
      feature: "context_runtime",
      label: "上下文编译记录",
      target: { controller: "system", method: "handleContextBuildRecords" },
      http: {
        method: "GET",
        path: "/api/context/build-records",
        query: [{ name: "limit", aliases: ["limit"], type: "number" }],
        coerce: { limit: "number" }
      },
      rpc: { method: "context.build_records" },
      cli: { command: ["context", "build-records"], usage: "context build-records --limit 50" },
      requiredScopes: ["console:read"]
    },
{
      id: "context.evaluation.runs.create",
      feature: "context_runtime",
      label: "运行上下文 replay 评估",
      target: { controller: "system", method: "handleContextEvaluationRuns" },
      http: { method: "POST", path: "/api/context/evaluation/runs" },
      rpc: { method: "context.evaluation.runs.create", body: "params" },
      cli: { command: ["context", "evaluation", "run"], usage: "context evaluation run --body cases.json" },
      requiredScopes: ["runtime:admin"]
    },
{
      id: "uploads.create_session",
      feature: "uploads",
      label: "创建或恢复上传会话",
      target: { controller: "jobs", method: "handleCreateUploadSession" },
      http: { method: "POST", path: "/api/upload-sessions", localInForwardMode: true },
      rpc: { method: "uploads.create_session", body: "params" },
      cli: { command: ["upload-session"], usage: "upload-session --body session.json" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["checkpoint", "manifest", "files"],
        properties: {
          checkpoint: { type: "object" },
          manifest: { type: "object" },
          files: {
            type: "array",
            minItems: 1,
            maxItems: 256,
            items: { type: "object" }
          }
        }
      },
      requiredScopes: ["jobs:write"]
    },
{
      id: "uploads.get_session",
      feature: "uploads",
      label: "读取上传会话",
      target: { controller: "jobs", method: "handleGetUploadSession" },
      http: { method: "GET", path: "/api/upload-sessions/:sessionId", localInForwardMode: true },
      rpc: {
        method: "uploads.get_session",
        params: [{ name: "sessionId", aliases: ["session-id", "id"], required: true }]
      },
      cli: {
        command: ["upload-session", "get"],
        usage: "upload-session get --id SESSION_ID",
        pathParams: { sessionId: ["session-id", "id"] }
      },
      requiredScopes: ["jobs:write"]
    },
{
      id: "uploads.upload_chunk",
      feature: "uploads",
      label: "上传文件分块",
      target: { controller: "jobs", method: "handleUploadChunk" },
      http: {
        method: "PUT",
        path: "/api/upload-sessions/:sessionId/files/:fileIndex",
        localInForwardMode: true,
        query: [{ name: "offset", aliases: ["offset"] }],
        coerce: { fileIndex: "number", offset: "number" }
      },
      rpc: {
        method: "uploads.upload_chunk",
        body: "raw",
        params: [
          { name: "sessionId", aliases: ["session-id", "id"], required: true },
    { name: "fileIndex", aliases: ["file-index"], required: true, type: "number" },
    { name: "offset", aliases: ["offset"], type: "number" }
        ]
      },
      cli: {
        command: ["upload-session", "chunk"],
        usage: "upload-session chunk --id SESSION_ID --file-index 0 --offset 0 --raw-file chunk.bin",
        pathParams: { sessionId: ["session-id", "id"], fileIndex: ["file-index"] }
      },
      requiredScopes: ["jobs:write"]
    },
{
      id: "jobs.create",
      feature: "jobs",
      label: "创建任务",
      target: { controller: "jobs", method: "handleCreateJob" },
      http: { method: "POST", path: "/api/jobs", localInForwardMode: true },
      rpc: { method: "jobs.create", body: "params" },
      cli: { command: ["jobs", "create"], usage: "jobs create --body job.json" },
      requiredScopes: ["jobs:write"]
    },
{
      id: "jobs.upload_workspace_materialize",
      feature: "jobs",
      label: "Materialize a completed upload into a workspace",
      target: { controller: "jobs", method: "handleUploadWorkspaceMaterialize" },
      http: { method: "POST", path: "/api/jobs/upload-workspace-materializations", localInForwardMode: true },
      rpc: { method: "jobs.upload_workspace_materialize", body: "params" },
      cli: { command: ["jobs", "upload-workspace-materialize"], usage: "jobs upload-workspace-materialize --body request.json" },
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["uploadSessionId", "workspaceId", "expectedWorkspaceRevision"],
        properties: {
          uploadSessionId: { type: "string" },
          workspaceId: { type: "string" },
          expectedWorkspaceRevision: { type: "string" },
          targetPrefix: { type: "string" },
          mutation: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: {
                type: "array",
                maxItems: 256,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["sourcePath", "targetPath"],
                  properties: {
                    sourcePath: { type: "string" },
                    targetPath: { type: "string" }
                  }
                }
              }
            }
          }
        }
      },
      requiredScopes: ["jobs:write", "storage:write"],
      safety: { risk: "repair_write", requiresConfirmation: true, approvalScope: "workspace:write" },
      concurrencyGroup: "workspace-materialization"
    },
{
      id: "jobs.upload_workspace_materialization_cancel",
      feature: "jobs",
      label: "Cancel upload workspace materialization",
      target: { controller: "jobs", method: "handleUploadWorkspaceMaterializationCancel" },
      http: {
        method: "POST",
        path: "/api/jobs/upload-workspace-materializations/:requestRef/cancel",
        localInForwardMode: true
      },
      rpc: {
        method: "jobs.upload_workspace_materialization_cancel",
        params: [{ name: "requestRef", aliases: ["request-ref", "id"], required: true }]
      },
      cli: {
        command: ["jobs", "upload-workspace-materialization-cancel"],
        usage: "jobs upload-workspace-materialization-cancel --id REQUEST_REF",
        pathParams: { requestRef: ["request-ref", "id"] }
      },
      requiredScopes: ["jobs:write", "storage:write"],
      safety: { risk: "safe_write" },
      concurrencyGroup: "workspace-materialization"
    },
{
      id: "jobs.list",
      feature: "jobs",
      label: "任务列表",
      target: { controller: "jobs", method: "handleListJobs" },
      http: {
        method: "GET",
        path: "/api/jobs",
        localInForwardMode: true,
        query: [{ name: "limit", aliases: ["limit"] }],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "jobs.list",
        params: [{ name: "limit", aliases: ["limit"], type: "number" }]
      },
      cli: { command: ["jobs", "list"], usage: "jobs list [--limit 50]" },
      requiredScopes: ["jobs:read"]
    },
{
      id: "jobs.failed_review",
      feature: "jobs",
      label: "失败任务复盘",
      target: { controller: "system", method: "handleFailedJobsReview" },
      http: {
        method: "GET",
        path: "/api/jobs/failed-review",
        query: [{ name: "limit", aliases: ["limit"] }],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "jobs.failed_review",
        params: [{ name: "limit", aliases: ["limit"], type: "number" }]
      },
      cli: { command: ["jobs", "failed-review"], usage: "jobs failed-review [--limit 50]" },
      requiredScopes: ["jobs:read"]
    },
{
      id: "jobs.work_queue.inspect",
      feature: "jobs",
      label: "任务队列状态",
      target: { controller: "jobs", method: "handleInspectWorkQueue" },
      http: {
        method: "GET",
        path: "/api/jobs/work-queue",
        localInForwardMode: true,
        query: [{ name: "limit", aliases: ["limit"] }],
        coerce: { limit: "number" }
      },
      rpc: {
        method: "jobs.work_queue.inspect",
        params: [{ name: "limit", aliases: ["limit"], type: "number" }]
      },
      cli: { command: ["jobs", "work-queue"], usage: "jobs work-queue [--limit 100]" },
      requiredScopes: ["jobs:read"]
    },
{
      id: "jobs.work_queue.pause",
      feature: "jobs",
      label: "暂停任务队列",
      target: { controller: "jobs", method: "handlePauseWorkQueue" },
      http: { method: "POST", path: "/api/jobs/work-queue/pause", localInForwardMode: true },
      rpc: { method: "jobs.work_queue.pause", body: "params" },
      cli: { command: ["jobs", "work-queue", "pause"], usage: "jobs work-queue pause --body reason.json" },
      requiredScopes: ["maintenance:admin"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } }
      },
      safety: { risk: "safe_write" }
    },
{
      id: "jobs.work_queue.resume",
      feature: "jobs",
      label: "恢复任务队列",
      target: { controller: "jobs", method: "handleResumeWorkQueue" },
      http: { method: "POST", path: "/api/jobs/work-queue/resume", localInForwardMode: true },
      rpc: { method: "jobs.work_queue.resume", body: "params" },
      cli: { command: ["jobs", "work-queue", "resume"], usage: "jobs work-queue resume --body reason.json" },
      requiredScopes: ["maintenance:admin"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } }
      },
      safety: { risk: "safe_write" }
    },
{
      id: "jobs.work_queue.drain",
      feature: "jobs",
      label: "排空任务队列",
      target: { controller: "jobs", method: "handleDrainWorkQueue" },
      http: { method: "POST", path: "/api/jobs/work-queue/drain", localInForwardMode: true },
      rpc: { method: "jobs.work_queue.drain", body: "params" },
      cli: { command: ["jobs", "work-queue", "drain"], usage: "jobs work-queue drain --body reason.json" },
      requiredScopes: ["maintenance:admin"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { reason: { type: "string" } }
      },
      safety: { risk: "safe_write" }
    },
{
      id: "jobs.work_queue.recover_failed",
      feature: "jobs",
      label: "Recover failed work queue items",
      target: { controller: "jobs", method: "handleRecoverFailedWorkQueue" },
      http: { method: "POST", path: "/api/jobs/work-queue/recover-failed", localInForwardMode: true },
      rpc: { method: "jobs.work_queue.recover_failed", body: "params" },
      cli: { command: ["jobs", "work-queue", "recover-failed"], usage: "jobs work-queue recover-failed [--body request.json]" },
      requiredScopes: ["maintenance:admin"],
      safety: { risk: "safe_write" }
    },
{
      id: "jobs.work_queue.rebuild",
      feature: "jobs",
      label: "重建任务队列投影证明",
      target: { controller: "jobs", method: "handleRebuildWorkQueue" },
      http: { method: "POST", path: "/api/jobs/work-queue/rebuild", localInForwardMode: true },
      rpc: { method: "jobs.work_queue.rebuild", body: "params" },
      cli: { command: ["jobs", "work-queue", "rebuild"], usage: "jobs work-queue rebuild [--body request.json]" },
      requiredScopes: ["maintenance:admin"],
      safety: { risk: "repair_write" }
    },
{
      id: "jobs.get",
      feature: "jobs",
      label: "任务详情",
      target: { controller: "jobs", method: "handleGetJob" },
      http: { method: "GET", path: "/api/jobs/:jobId", localInForwardMode: true },
      rpc: {
        method: "jobs.get",
        params: [{ name: "jobId", aliases: ["job-id", "id"], required: true }]
      },
      cli: {
        command: ["jobs", "get"],
        usage: "jobs get --id JOB_ID",
        pathParams: { jobId: ["job-id", "id"] }
      },
      requiredScopes: ["jobs:read"]
    },
{
      id: "jobs.reparse",
      feature: "jobs",
      label: "重新解析历史任务",
      target: { controller: "jobs", method: "handleReparseJob" },
      http: { method: "POST", path: "/api/jobs/:jobId/reparse", localInForwardMode: true },
      rpc: {
        method: "jobs.reparse",
        params: [{ name: "jobId", aliases: ["job-id", "id"], required: true }],
        body: "params"
      },
      cli: {
        command: ["jobs", "reparse"],
        usage: "jobs reparse --id JOB_ID --body options.json",
        pathParams: { jobId: ["job-id", "id"] }
      },
      requiredScopes: ["jobs:write"]
    },
{
      id: "jobs.cancel",
      feature: "jobs",
      label: "取消任务",
      target: { controller: "jobs", method: "handleCancelJob" },
      http: { method: "POST", path: "/api/jobs/:jobId/cancel", localInForwardMode: true },
      rpc: {
        method: "jobs.cancel",
        params: [{ name: "jobId", aliases: ["job-id", "id"], required: true }]
      },
      cli: {
        command: ["jobs", "cancel"],
        usage: "jobs cancel --id JOB_ID",
        pathParams: { jobId: ["job-id", "id"] }
      },
      requiredScopes: ["jobs:write"]
    },
{
      id: "jobs.delete",
      feature: "jobs",
      label: "删除任务",
      target: { controller: "jobs", method: "handleDeleteJob" },
      http: { method: "DELETE", path: "/api/jobs/:jobId", localInForwardMode: true },
      rpc: {
        method: "jobs.delete",
        params: [{ name: "jobId", aliases: ["job-id", "id"], required: true }]
      },
      cli: {
        command: ["jobs", "delete"],
        usage: "jobs delete --id JOB_ID",
        pathParams: { jobId: ["job-id", "id"] }
      },
      requiredScopes: ["jobs:write"]
    },
{
      id: "jobs.result",
      feature: "jobs",
      label: "任务结果",
      target: { controller: "jobs", method: "handleGetJobResult" },
      http: { method: "GET", path: "/api/jobs/:jobId/result", localInForwardMode: true },
      rpc: {
        method: "jobs.result",
        params: [{ name: "jobId", aliases: ["job-id", "id"], required: true }]
      },
      cli: {
        command: ["jobs", "result"],
        usage: "jobs result --id JOB_ID",
        pathParams: { jobId: ["job-id", "id"] }
      },
      requiredScopes: ["jobs:read"]
    },
{
      id: "jobs.normalized_documents",
      feature: "jobs",
      label: "归一化 DOCX 文档清单",
      target: { controller: "jobs", method: "handleListNormalizedDocuments" },
      http: {
        method: "GET",
        path: "/api/jobs/:jobId/normalized-documents",
        localInForwardMode: true
      },
      rpc: {
        method: "jobs.normalized_documents",
        params: [{ name: "jobId", aliases: ["job-id", "id"], required: true }]
      },
      cli: {
        command: ["jobs", "normalized-docs"],
        usage: "jobs normalized-docs --id JOB_ID",
        pathParams: { jobId: ["job-id", "id"] }
      },
      requiredScopes: ["jobs:read"]
    },
{
      id: "jobs.normalized_document.get",
      feature: "jobs",
      label: "下载归一化 DOCX 文档",
      target: { controller: "jobs", method: "handleGetNormalizedDocument" },
      http: {
        method: "GET",
        path: "/api/jobs/:jobId/normalized-documents/:documentId",
        localInForwardMode: true
      },
      rpc: {
        method: "jobs.normalized_document.get",
        params: [
          { name: "jobId", aliases: ["job-id", "id"], required: true },
    { name: "documentId", aliases: ["document-id"], required: true }
        ]
      },
      cli: {
        command: ["jobs", "normalized-doc"],
        usage: "jobs normalized-doc --id JOB_ID --document-id DOC_ID --output out.docx",
        pathParams: {
          jobId: ["job-id", "id"],
          documentId: ["document-id"]
        }
      },
      requiredScopes: ["jobs:read"],
      binary: true
    },
{
      id: "raw_objects.get",
      feature: "raw_objects",
      label: "读取原始对象",
      target: { controller: "jobs", method: "handleGetRawObject" },
      http: { method: "GET", path: "/api/raw-objects/:objectId" },
      rpc: {
        method: "raw_objects.get",
        params: [{ name: "objectId", aliases: ["object-id", "id"], required: true }]
      },
      cli: {
        command: ["raw-object"],
        usage: "raw-object --id OBJECT_ID --output raw.eml",
        pathParams: { objectId: ["object-id", "id"] }
      },
      requiredScopes: ["jobs:read"],
      binary: true
    }
]);
