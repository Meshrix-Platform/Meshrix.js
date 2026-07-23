import { describe, expect, it } from "vitest";

import {
  assertMacArmHost,
  parseFinalReleaseAssetArguments,
  parseReleaseChecksumIndex
} from "../../../tools/server-scripts/verify-mcp-final-release-asset.mjs";

describe("macOS arm64 MCP release asset runtime verifier", () => {
  it("requires an actual macOS arm64 host", () => {
    expect(() => assertMacArmHost("darwin", "arm64")).not.toThrow();
    expect(() => assertMacArmHost("darwin", "x64"))
      .toThrow("mcp_final_release_asset_host_mismatch");
    expect(() => assertMacArmHost("linux", "arm64"))
      .toThrow("mcp_final_release_asset_host_mismatch");
  });

  it("parses only explicit input and report paths", () => {
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
    expect(() => parseFinalReleaseAssetArguments(["--unknown"]))
      .toThrow("mcp_final_release_asset_argument_unknown");
  });

  it("rejects duplicate, ambiguous, and malformed checksum entries", () => {
    const digest = "a".repeat(64);
    expect(parseReleaseChecksumIndex(`${digest}  asset.tar.gz\n`))
      .toEqual(new Map([["asset.tar.gz", digest]]));
    expect(() => parseReleaseChecksumIndex(
      `${digest}  asset.tar.gz\n${digest}  asset.tar.gz\n`
    )).toThrow("mcp_final_release_asset_checksum_index_invalid");
    expect(() => parseReleaseChecksumIndex(`${digest}  ambiguous asset.tar.gz\n`))
      .toThrow("mcp_final_release_asset_checksum_index_invalid");
    expect(() => parseReleaseChecksumIndex("{}"))
      .toThrow("mcp_final_release_asset_checksum_index_invalid");
  });
});
