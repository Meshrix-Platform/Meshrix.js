import { describe, expect, it } from "vitest";

import {
  containsSensitiveReportData,
  redactReportText,
  sensitiveReportFindings
} from "../../../packages/foundation/src/observability/sensitive-report-scan.ts";

describe("sensitive report URL scanning", () : any => {
  it("keeps ordinary public documentation URLs while ignoring URL path-shaped prose", () : any => {
    const value: any = ["https://docs.example.test", "/", ["home", "example", "guide"].join("/")].join("");
    expect(sensitiveReportFindings(value)).toEqual([]);
    expect(redactReportText(value)).toBe(value);
  });

  it("does not treat a SHA-256 digest beginning with an IPv6 prefix as an endpoint", () : any => {
    expect(sensitiveReportFindings({
      sourceRevision: "sha256:fc7f3c9ebefae770d62cdbdb83e4fbe386668249c2568cf1b417edde08a56ef5"
    })).toEqual([]);
  });

  it.each([
    ["embedded credentials", ["https://", "operator", ":", "private-value", "@service.example.test/api"].join(""), "url_credentials"],
    ["sensitive query", `https://service.example.test/api?${["access", "token"].join("_")}=private-value`, "url_sensitive_query"],
    ["loopback", ["http://", [127, 0, 0, 1].join("."), ":49322/api/healthz"].join(""), "private_endpoint"],
    ["private IPv4", ["https://", [10, 20, 30, 40].join("."), ":8443/api"].join(""), "private_endpoint"],
    ["private IPv6", "https://[fc00::1]:8443/api", "private_endpoint"],
    ["local hostname", ["https://backend", ".local/api"].join(""), "private_endpoint"]
  ])("detects %s before public URL normalization", (_label?: any, value?: any, finding?: any) : any => {
    expect(sensitiveReportFindings(value)).toContain(finding);
    expect(containsSensitiveReportData(value)).toBe(true);
    expect(redactReportText(value)).toBe("[redacted-url]");
  });

  // User-home vectors are assembled at runtime so the suite ships no real
  // home-path literal; the other roots are already non-identifying.
  it.each([
    ["/Users", "/operator/Library/data/state.json"].join(""),
    ["/home", "/operator/.config/meshrix/state.json"].join(""),
    ["/private/var/folders", "/ab/cd/state.json"].join(""),
    "/var/lib/meshrix/state.json",
    "/root/.local/share/state.json",
    "/tmp/meshrix-run/state.json",
    "/opt/meshrix/state.json",
    "/Volumes/external/meshrix/state.json",
    ["file://", "/Users", "/operator/state.json"].join("")
  ])("detects and redacts absolute local path %s", (value?: any) : any => {
    expect(sensitiveReportFindings(value)).toContain("local_path");
    const redacted: any = redactReportText(value);
    expect(redacted).not.toContain("operator");
    expect(redacted).not.toContain("meshrix-run");
    expect(redacted).toContain("[redacted-path]");
  });

  it("detects and redacts absolute Windows paths", () : any => {
    const value: any = ["C:", "\\", "Users", "\\", "operator", "\\", "state.json"].join("");
    expect(sensitiveReportFindings(value)).toContain("local_path");
    expect(redactReportText(value)).toContain("[redacted-path]");
  });
});
