import { readFile, writeFile } from "node:fs/promises";
import { upstreamServiceImportFromOpenApi } from "@meshrix/contracts/upstream-service-publishing";

/**
 * Local upstream-authoring helpers. `import-openapi` converts an OpenAPI 3.x
 * JSON document into the portable service-import draft the Console panel and
 * the publishing command already accept; it performs no network calls and no
 * server writes — the operator reviews the draft before publication.
 */
export async function runUpstreamCommand(args: Record<string, any>): Promise<boolean> {
  if (args._?.[0] !== "upstream") return false;
  const subcommand = String(args._?.[1] ?? "");
  if (subcommand !== "import-openapi") {
    throw new Error("Usage: meshrix upstream import-openapi --file openapi.json [--service-key NAME] [--base-url URL] [--output draft.json]");
  }
  const file = typeof args.file?.[0] === "string" && args.file[0]
    ? args.file[0]
    : typeof args.input?.[0] === "string" ? args.input[0] : "";
  if (!file) {
    throw new Error("meshrix upstream import-openapi requires --file openapi.json.");
  }
  const source = await readFile(file, "utf8");
  const result = upstreamServiceImportFromOpenApi(source, {
    serviceKey: args["service-key"],
    baseUrl: args["base-url"]
  });
  const serialized = `${JSON.stringify(result.document, null, 2)}\n`;
  if (typeof args.output === "string" && args.output) {
    await writeFile(args.output, serialized, "utf8");
  } else {
    process.stdout.write(serialized);
  }
  for (const skipped of result.skippedOperations) {
    process.stderr.write(`skipped ${skipped.method.toUpperCase()} ${skipped.path}: ${skipped.reason}\n`);
  }
  for (const warning of result.warnings) {
    process.stderr.write(`warning: ${warning}\n`);
  }
  return true;
}
