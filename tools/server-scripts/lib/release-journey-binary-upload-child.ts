#!/usr/bin/env node
import { uploadBinaryFixtureThroughConnector } from "./release-journey-mcp.ts";

const MAX_FIXTURE_BYTES: any = 64 * 1024 * 1024;

async function readStdin() : Promise<any> {
  const chunks: any[] = [];
  let byteLength: any = 0;
  for await (const chunk of process.stdin) {
    const bytes: any = Buffer.from(chunk);
    byteLength += bytes.length;
    if (byteLength > MAX_FIXTURE_BYTES) {
      const error: Error & Record<string, any> = new Error("Release journey fixture exceeds the child upload limit.");
      error.code = "release_journey_upload_fixture_too_large";
      throw error;
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, byteLength);
}

async function main() : Promise<any> {
  const [baseUrl, target = "kimi", fixtureFileName = "fixture.bin"] = process.argv.slice(2);
  const fixtureBytes: any = await readStdin();
  const result: any = await uploadBinaryFixtureThroughConnector({
    baseUrl,
    target,
    fixtureFileName,
    fixtureBytes
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error?: any) : any => {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    code: String(error?.code || "release_journey_binary_upload_failed").slice(0, 96),
    statusCode: Number(error?.statusCode || 0)
  })}\n`);
  process.exitCode = 1;
});
