#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH,
  UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH,
  renderUpstreamServicePublishingHtml
} from "../server-scripts/lib/upstream-service-publishing-html.ts";
import {
  UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH
} from "../server-scripts/lib/upstream-service-publishing-evidence.ts";
import {
  RELEASE_JOURNEY_REPORT_PATH
} from "../server-scripts/lib/release-journey-report.ts";

const ROOT: any = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

const journeyReport: any = JSON.parse(
  await fs.readFile(path.join(ROOT, RELEASE_JOURNEY_REPORT_PATH), "utf8")
);
let html: any;
if (journeyReport.releaseReady !== true) {
  html = renderUpstreamServicePublishingHtml(
    null,
    journeyReport,
    "",
    new Map<any, any>(),
    null
  );
} else {
  const [coreReportText, upstreamServiceBasicConfigText] = await Promise.all([
    fs.readFile(path.join(ROOT, UPSTREAM_SERVICE_PUBLISHING_REPORT_PATH), "utf8"),
    fs.readFile(path.join(ROOT, UPSTREAM_SERVICE_BASIC_CONFIG_JSON_PATH), "utf8")
  ]);
  const visualEvidenceFiles: any = new Map<any, any>(await Promise.all(
    journeyReport.visualEvidence.map(async (item?: any) : Promise<any> => {
    if (
      typeof item?.file !== "string"
      || !/^build\/reports\/upstream-service-publishing\/screenshots\/[a-z0-9][a-z0-9-]*\.png$/u
        .test(item.file)
    ) {
      throw new Error("The release journey contains an unsafe screenshot path.");
    }
    return [item.file, await fs.readFile(path.join(ROOT, item.file))];
    })
  ));
  const candidateProjection: Record<string, any> = {
    claim: "upstream-publishing-prepublication-passed",
    release: {
      version: journeyReport.candidate?.releaseVersion,
      tag: journeyReport.candidate?.releaseTag,
      definitionVersion: journeyReport.candidate?.releaseDefinitionVersion,
      definitionSha256: journeyReport.candidate?.releaseDefinitionSha256
    },
    source: {
      commit: journeyReport.candidate?.sourceCommit,
      tree: journeyReport.candidate?.sourceTree
    }
  };
  html = renderUpstreamServicePublishingHtml(
    JSON.parse(coreReportText),
    journeyReport,
    upstreamServiceBasicConfigText,
    visualEvidenceFiles,
    candidateProjection
  );
}
await fs.writeFile(path.join(ROOT, UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH), html, "utf8");
console.log(`Generated: ${UPSTREAM_SERVICE_PUBLISHING_HTML_REPORT_PATH}`);
