import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const responsiveCssPath = fileURLToPath(
  new URL("../../../apps/console/styles/features/responsive.css", import.meta.url),
);

describe("console responsive shell layout", () => {
  it("removes reserved sidebar columns from compact collapsed and locked shells", () => {
    const css = readFileSync(responsiveCssPath, "utf8");

    expect(css).toMatch(
      /@media\s*\(max-width:\s*860px\)[\s\S]*?\.dashboard-shell,\s*\.dashboard-shell\.is-collapsed,\s*\.dashboard-shell\.is-locked\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
  });
});
