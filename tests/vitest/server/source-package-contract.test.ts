import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUTHORIZED_VENDORED_PACKAGE_ROOT,
  AUTHORIZED_VENDORED_TARBALL_PATTERN,
  SOURCE_PACKAGE_ROOTS
} from "../../../tools/server-scripts/lib/source-package-contract.ts";

const REPO_ROOT: any = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const VENDORED_TARBALL: any = "vendor/pactium-0.8.0.tgz";

describe("server source package vendor root", () : void => {
  it("treats the authorized Pactium tarball as a public source root", async () : Promise<void> => {
    expect(SOURCE_PACKAGE_ROOTS).toContain(AUTHORIZED_VENDORED_PACKAGE_ROOT);
    expect(VENDORED_TARBALL).toMatch(AUTHORIZED_VENDORED_TARBALL_PATTERN);
    await fs.access(path.join(REPO_ROOT, VENDORED_TARBALL));
  });

  it("includes the service-owned Model Gateway contract needed by release tooling", async () : Promise<void> => {
    const contractRoot: any = "services/model-gateway/contracts";
    expect(SOURCE_PACKAGE_ROOTS).toContain(contractRoot);
    await fs.access(path.join(REPO_ROOT, contractRoot, "provider-manifest-contract.mjs"));
    await fs.access(path.join(REPO_ROOT, contractRoot, "provider-manifest-contract.d.mts"));
  });
});
