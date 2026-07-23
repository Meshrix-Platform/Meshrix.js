import type { SplitJob, SplitJobStatus } from "../lib/types";
import { jobStatusLabels } from "./console-defaults";
import { formatDuration } from "./console-format-utils";

export function jobElapsed(item: SplitJob) {
  return formatDuration(
    item.startedAt || item.createdAt,
    item.finishedAt || item.updatedAt,
  );
}

export function splitJobStatusLabel(status?: string) {
  return jobStatusLabels[status as SplitJobStatus] || status || "待处理";
}
