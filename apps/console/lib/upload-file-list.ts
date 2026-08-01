import type { SplitJob } from "./types";

type FileWithRelativePath = File & {
  webkitRelativePath?: string;
};

export type UploadFileEntry = {
  key: string;
  name: string;
  relativePath: string;
  directory: string;
  extension: string;
  size: number;
  detail?: string;
  href?: string;
  actionLabel?: string;
  downloadName?: string;
  statusLabel?: string;
  statusTone?: string;
};

export type FileListResultEntry = {
  key?: string;
  name: string;
  relativePath?: string;
  extension?: string;
  size?: number;
  detail?: string;
  href?: string;
  actionLabel?: string;
  downloadName?: string;
  statusLabel?: string;
  statusTone?: string;
};

export type UploadProgressState = {
  completedSteps: number;
  detail: string;
  label: string;
  tone: string;
};

export const uploadFileListIcons: Record<string, any> = {
  chevronDown: "/icons/octicon-chevron-down-16.svg",
  file: "/icons/octicon-file-24.svg",
  folder: "/icons/octicon-file-directory-fill-24.svg",
  upload: "/icons/octicon-upload-24.svg",
};

export const uploadProgressStepLabels: any[] = ["已选择", "上传", "解析", "入库", "完成"];
export const uploadTotalProgressSteps: any = uploadProgressStepLabels.length;

export function buildUploadFileEntries(options: {
  files: File[];
  mode: "upload" | "download";
  resultFiles: FileListResultEntry[];
}) : any {
  if (options.mode === "download") {
    return options.resultFiles.map((file?: any, index?: any): UploadFileEntry => {
      const relativePath: any = String(file.relativePath || file.name);
      const name: any = String(file.name || relativePath || "result");
      const extension: any = String(
        file.extension || (name.includes(".") ? name.split(".").pop() : "FILE") || "FILE",
      ).toUpperCase();
      return {
        key: String(file.key || `${relativePath}:${file.size || 0}:${index}`),
        name,
        relativePath,
        directory: "",
        extension,
        size: Number(file.size || 0),
        detail: file.detail,
        href: file.href,
        actionLabel: file.actionLabel,
        downloadName: file.downloadName,
        statusLabel: file.statusLabel,
        statusTone: file.statusTone,
      };
    });
  }

  return options.files.map((file?: any, index?: any): UploadFileEntry => {
    const relativePath: any = String((file as FileWithRelativePath).webkitRelativePath || file.name);
    const segments: any = relativePath.split(/[\\/]/g).filter(Boolean);
    const name: any = segments.at(-1) || file.name;
    const directory: any = segments.length > 1 ? segments.slice(0, -1).join("/") : "";
    const extension: any = name.includes(".") ? name.split(".").pop()?.toUpperCase() || "FILE" : "FILE";
    return {
      key: `${relativePath}:${file.size}:${file.lastModified}:${index}`,
      name,
      relativePath,
      directory,
      extension,
      size: file.size,
    };
  });
}

export function summarizeUploadSelection(options: {
  files: File[];
  fileEntries: UploadFileEntry[];
  formatBytes: (bytes: number) => string;
  mode: "upload" | "download";
  summary: string;
}) : any {
  if (options.summary) {
    return options.summary;
  }
  if (options.mode === "download") {
    if (options.fileEntries.length === 0) {
      return "0 个文件";
    }
    const knownBytes: any = options.fileEntries.reduce(
      (sum?: any, file?: any) : any => sum + Math.max(0, Number(file.size || 0)),
      0,
    );
    return knownBytes > 0
      ? `${options.fileEntries.length} 个文件 · ${options.formatBytes(knownBytes)}`
      : `${options.fileEntries.length} 个文件`;
  }
  if (options.files.length === 0) {
    return "0 个文件";
  }
  const totalBytes: any = options.files.reduce((sum?: any, file?: any) : any => sum + file.size, 0);
  return `${options.files.length} 个文件 · ${options.formatBytes(totalBytes)}`;
}

export function resolveUploadProgressState(options: {
  files: File[];
  ingestJob: SplitJob | null;
  ingestProgress: string;
  isBusy: boolean;
  jobStatusLabels: Record<string, string>;
  jobStatusTone: (status: string) => string;
}): UploadProgressState {
  const job: any = options.ingestJob;
  if (options.files.length === 0) {
    return {
      completedSteps: 0,
      detail: "等待文件",
      label: "未选择",
      tone: "neutral",
    };
  }
  if (!job) {
    return {
      completedSteps: options.isBusy ? 2 : 1,
      detail: options.ingestProgress || (options.isBusy ? "正在准备上传" : "等待入库"),
      label: options.isBusy ? "上传中" : "待处理",
      tone: options.isBusy ? "running" : "neutral",
    };
  }
  if (job.status === "completed") {
    return {
      completedSteps: uploadTotalProgressSteps,
      detail: job.stage || "处理完成",
      label: options.jobStatusLabels[job.status] || "已完成",
      tone: options.jobStatusTone(job.status),
    };
  }
  if (job.status === "failed") {
    return {
      completedSteps: Math.max(
        2,
        Math.min(uploadTotalProgressSteps - 1, Math.ceil(Number(job.progressPercent || 0) / 25)),
      ),
      detail: job.error || job.stage || "处理失败",
      label: options.jobStatusLabels[job.status] || "失败",
      tone: options.jobStatusTone(job.status),
    };
  }
  const progressPercent: any = Math.max(0, Math.min(100, Number(job.progressPercent || 0)));
  return {
    completedSteps: Math.max(
      2,
      Math.min(uploadTotalProgressSteps - 1, Math.ceil(progressPercent / 25) + 1),
    ),
    detail: job.stage || options.ingestProgress || "队列处理中",
    label: options.jobStatusLabels[job.status] || job.status,
    tone: options.jobStatusTone(job.status),
  };
}
