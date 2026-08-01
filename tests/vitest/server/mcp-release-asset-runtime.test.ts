import { describe, expect, it } from "vitest";

import {
  assertMacArmHost,
  parseFinalReleaseAssetArguments,
  parseReleaseChecksumIndex
} from "../../../tools/server-scripts/verify-mcp-final-release-asset.ts";

describe("macOS arm64 MCP release asset runtime verifier", () : any => {
  it("requires an actual macOS arm64 host", () : any => {
    expect(() : any => assertMacArmHost("darwin", "arm64")).not.toThrow();
    expect(() : any => assertMacArmHost("darwin", "x64"))
      .toThrow("mcp_final_release_asset_host_mismatch");
    expect(() : any => assertMacArmHost("linux", "arm64"))
      .toThrow("mcp_final_release_asset_host_mismatch");
  });

  it("parses only explicit input and report paths", () : any => {
    expect(parseFinalReleaseAssetArguments([])).toEqual({
      inputDir: "build/release/mcp",
      reportPath: "build/reports/mcp-final-release-asset.json"
    });
    expect(parseFinalReleaseAssetArguments([
      "--input-dir", "build/release/mcp",
      "--report-path", "build/reports/final.json"
    ])).toEqual({
      inputDir: "build/release/mcp",
      reportPath: "build/reports/final.json"
    });
    expect(() : any => parseFinalReleaseAssetArguments(["--unknown"]))
      .toThrow("mcp_final_release_asset_argument_unknown");
  });

  it("rejects duplicate, ambiguous, and malformed checksum entries", () : any => {
    const digest: any = "a".repeat(64);
    expect(parseReleaseChecksumIndex(`${digest}  asset.tar.gz\n`))
      .toEqual(new Map<any, any>([["asset.tar.gz", digest]]));
    expect(() : any => parseReleaseChecksumIndex(
      `${digest}  asset.tar.gz\n${digest}  asset.tar.gz\n`
    )).toThrow("mcp_final_release_asset_checksum_index_invalid");
    expect(() : any => parseReleaseChecksumIndex(`${digest}  ambiguous asset.tar.gz\n`))
      .toThrow("mcp_final_release_asset_checksum_index_invalid");
    expect(() : any => parseReleaseChecksumIndex("{}"))
      .toThrow("mcp_final_release_asset_checksum_index_invalid");
  });
});
