#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH,
  renderUpstreamServicePublishingBlankTemplate
} from "../server-scripts/lib/upstream-service-publishing-html.ts";

const ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const templatePath: any = path.join(ROOT, UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH);

export function generateUpstreamServicePublishingReportTemplate({ check = false }: Record<string, any> = {}) : any {
  const expected: any = renderUpstreamServicePublishingBlankTemplate();
  const current: any = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, "utf8") : null;
  if (check) {
    if (current !== expected) {
      const error: Error & Record<string, any> = new Error(
        "The tracked upstream-service publishing report template is missing or stale."
      );
      error.code = "upstream_service_publishing_report_template_stale";
      throw error;
    }
    return { changed: false, path: UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH };
  }
  fs.mkdirSync(path.dirname(templatePath), { recursive: true });
  fs.writeFileSync(templatePath, expected, "utf8");
  return { changed: current !== expected, path: UPSTREAM_SERVICE_PUBLISHING_BLANK_TEMPLATE_PATH };
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    const result: any = generateUpstreamServicePublishingReportTemplate({
      check: process.argv.includes("--check")
    });
    console.log(`${result.changed ? "Generated" : "OK"}: ${result.path}`);
  } catch (error: any) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
