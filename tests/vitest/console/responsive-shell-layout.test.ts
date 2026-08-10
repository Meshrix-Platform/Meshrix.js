import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const responsiveCssPath: any = fileURLToPath(
  new URL("../../../apps/console/styles/features/responsive.css", import.meta.url),
);

describe("console responsive shell layout", () : any => {
  it("removes reserved sidebar columns from compact collapsed and locked shells", () : any => {
    const css: any = readFileSync(responsiveCssPath, "utf8");

    expect(css).toMatch(
      /@media\s*\(max-width:\s*860px\)[\s\S]*?\.dashboard-shell,\s*\.dashboard-shell\.is-collapsed,\s*\.dashboard-shell\.is-locked\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\);/u,
    );
  });

  it("gives the page heading its own row on phone-width topbars", () : any => {
    const css: any = readFileSync(responsiveCssPath, "utf8");

    expect(css).toMatch(
      /@media\s*\(max-width:\s*520px\)[\s\S]*?\.topbar\s*\{[\s\S]*?grid-template-areas:\s*"actions status"\s*"heading heading";/u,
    );
    expect(css).toMatch(/\.topbar-heading\s*\{\s*grid-area:\s*heading;\s*width:\s*100%;/u);
  });
});
