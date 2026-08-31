import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { createLocalPluginPackageSource } from "#meshrix/contracts/plugins/plugin-package-source";
import { createPluginPackageAcquisition } from "#meshrix/foundation/module-system/plugin-package-acquisition";
import { createLocalPluginPackageAcquisition } from "#meshrix/foundation/module-system/local-plugin-package-source";
import { createGitHubReleasePluginPackageAcquisition } from "#meshrix/foundation/module-system/github-release-plugin-package-source";
import { createPluginPackageLifecycle } from "#meshrix/foundation/module-system/plugin-package-lifecycle";
import { createPluginPackageCustody } from "#meshrix/foundation/module-system/plugin-package-custody";

function sha256(bytes?: any) : any {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("local plugin package acquisition", () : any => {
  it("requires explicit import root and relative file without discovery", () : any => {
    assert.throws(() : any => createLocalPluginPackageSource({}), /importRootId/);
    const source: any = createLocalPluginPackageSource({
      importRootId: "plugins-offline",
      relativePath: "sample-plugin.tar.gz"
    });
    assert.equal(source.expectedDigest, null);
  });

  it("acquires from an authorized root and matches GitHub digest for identical bytes", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-pkg-"));
    try {
      const bytes: any = Buffer.from("identical-plugin-bytes");
      await fs.writeFile(path.join(root, "sample-plugin.tar.gz"), bytes, { mode: 0o644 });
      const local: any = createLocalPluginPackageAcquisition({
        resolveImportRoot: async (id?: any) : Promise<any> => {
          assert.equal(id, "plugins-offline");
          return root;
        }
      });
      const acquired: any = await local.acquire({
        importRootId: "plugins-offline",
        relativePath: "sample-plugin.tar.gz",
        expectedDigest: sha256(bytes)
      });
      assert.equal(acquired.sourceKind, "local_package");
      assert.equal(acquired.archiveDigest, sha256(bytes));

      const github: any = createGitHubReleasePluginPackageAcquisition({
        fetchImpl: async (url?: any) : Promise<any> => {
          const parsed: any = new URL(String(url));
          if (parsed.pathname.includes("/releases/tags/")) {
            return {
              status: 200,
              headers: { get: () : any => null },
              body: null,
              async arrayBuffer() : Promise<any> {
                return Uint8Array.from(Buffer.from(JSON.stringify({
                  id: 1,
                  assets: [{
                    id: 2,
                    name: "sample-plugin.tar.gz",
                    url: "https://api.github.com/repos/acme/plugins/releases/assets/2"
                  }]
                }))).buffer;
              }
            };
          }
          return {
            status: 200,
            headers: { get: () : any => null },
            body: null,
            async arrayBuffer() : Promise<any> {
              return Uint8Array.from(bytes).buffer;
            }
          };
        }
      });
      const online: any = await github.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz",
        expectedDigest: acquired.archiveDigest
      });
      assert.equal(online.archiveDigest, acquired.archiveDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects links, path escape, unsafe modes, oversize, and cancellation with path-free errors", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-pkg-"));
    try {
      await fs.writeFile(path.join(root, "ok.tar.gz"), Buffer.from("ok"), { mode: 0o644 });
      await fs.symlink(path.join(root, "ok.tar.gz"), path.join(root, "link.tar.gz"));
      await fs.mkdir(path.join(root, "dir"));
      const widePath: any = path.join(root, "wide.tar.gz");
      await fs.writeFile(widePath, Buffer.from("wide"), { mode: 0o644 });
      await fs.chmod(widePath, 0o666);

      const local: any = createLocalPluginPackageAcquisition({
        resolveImportRoot: async () : Promise<any> => root,
        maxBytes: 8
      });

      await assert.rejects(
        () : any => local.acquire({ importRootId: "r", relativePath: "link.tar.gz" }),
        /symbolic links/
      );
      await assert.rejects(
        () : any => local.acquire({ importRootId: "r", relativePath: "../escape.tar.gz" }),
        /escapes/
      );
      await assert.rejects(
        () : any => local.acquire({ importRootId: "r", relativePath: "dir" }),
        /regular file/
      );
      await assert.rejects(
        () : any => local.acquire({ importRootId: "r", relativePath: "wide.tar.gz" }),
        /mode is unsafe/
      );
      await fs.writeFile(path.join(root, "big.tar.gz"), Buffer.alloc(16), { mode: 0o644 });
      await assert.rejects(
        () : any => local.acquire({ importRootId: "r", relativePath: "big.tar.gz" }),
        /byte budget/
      );

      const controller: any = new AbortController();
      controller.abort();
      await assert.rejects(
        () : any => local.acquire({ importRootId: "r", relativePath: "ok.tar.gz" }, {}, controller.signal),
        /cancelled/
      );

      try {
        await local.acquire({ importRootId: "r", relativePath: "missing.tar.gz" });
        assert.fail("expected missing rejection");
      } catch (error: any) {
        assert.match(String(error.message), /PLUGIN_PACKAGE_/);
        assert.equal(String(error.message).includes(root), false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces identical imports and does not stage plugins", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-pkg-"));
    try {
      const bytes: any = Buffer.from("coalesce");
      await fs.writeFile(path.join(root, "sample-plugin.tar.gz"), bytes, { mode: 0o644 });
      let opens: any = 0;
      const local: any = createLocalPluginPackageAcquisition({
        resolveImportRoot: async () : Promise<any> => root,
        openFile: async (candidate?: any) : Promise<any> => {
          opens += 1;
          return fs.open(candidate, "r");
        }
      });
      const source: Record<string, any> = {
        importRootId: "plugins-offline",
        relativePath: "sample-plugin.tar.gz"
      };
      const [a, b] = await Promise.all([local.acquire(source), local.acquire(source)]);
      assert.equal(a.archiveDigest, b.archiveDigest);
      assert.equal(opens, 1);

      const acquisition: any = createPluginPackageAcquisition({
        local: { resolveImportRoot: async () : Promise<any> => root }
      });
      const custodyRoot: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-life-"));
      try {
        const lifecycle: any = createPluginPackageLifecycle({
          custody: createPluginPackageCustody({ rootDir: custodyRoot }),
          acquisitionPort: acquisition.port
        });
        const receipt: any = await lifecycle.acquire({
          pluginId: "sample-plugin",
          source: {
            kind: "local_package",
            importRootId: "plugins-offline",
            relativePath: "sample-plugin.tar.gz",
            expectedDigest: sha256(bytes)
          }
        });
        assert.equal(receipt.state, "acquired");
        assert.equal(lifecycle.getHealth("sample-plugin").ready, false);
      } finally {
        await fs.rm(custodyRoot, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the offline adapter free of network calls", async () : Promise<any> => {
    const root: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-local-pkg-"));
    try {
      await fs.writeFile(path.join(root, "sample-plugin.tar.gz"), Buffer.from("offline"), { mode: 0o644 });
      const previousFetch: any = globalThis.fetch;
      globalThis.fetch = async () : Promise<any> => {
        throw new Error("network should not be reached");
      };
      try {
        const local: any = createLocalPluginPackageAcquisition({
          resolveImportRoot: async () : Promise<any> => root
        });
        const acquired: any = await local.acquire({
          importRootId: "plugins-offline",
          relativePath: "sample-plugin.tar.gz"
        });
        assert.equal(acquired.byteLength, 7);
      } finally {
        globalThis.fetch = previousFetch;
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
