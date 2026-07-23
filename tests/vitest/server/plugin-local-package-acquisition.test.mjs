import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

import { createLocalPluginPackageSource } from "#lico/contracts/plugins/plugin-package-source";
import { createPluginPackageAcquisition } from "#lico/foundation/module-system/plugin-package-acquisition";
import { createLocalPluginPackageAcquisition } from "#lico/foundation/module-system/local-plugin-package-source";
import { createGitHubReleasePluginPackageAcquisition } from "#lico/foundation/module-system/github-release-plugin-package-source";
import { createPluginPackageLifecycle } from "#lico/foundation/module-system/plugin-package-lifecycle";
import { createPluginPackageCustody } from "#lico/foundation/module-system/plugin-package-custody";

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

describe("local plugin package acquisition", () => {
  it("requires explicit import root and relative file without discovery", () => {
    assert.throws(() => createLocalPluginPackageSource({}), /importRootId/);
    const source = createLocalPluginPackageSource({
      importRootId: "plugins-offline",
      relativePath: "sample-plugin.tar.gz"
    });
    assert.equal(source.expectedDigest, null);
  });

  it("acquires from an authorized root and matches GitHub digest for identical bytes", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-pkg-"));
    try {
      const bytes = Buffer.from("identical-plugin-bytes");
      await fs.writeFile(path.join(root, "sample-plugin.tar.gz"), bytes, { mode: 0o644 });
      const local = createLocalPluginPackageAcquisition({
        resolveImportRoot: async (id) => {
          assert.equal(id, "plugins-offline");
          return root;
        }
      });
      const acquired = await local.acquire({
        importRootId: "plugins-offline",
        relativePath: "sample-plugin.tar.gz",
        expectedDigest: sha256(bytes)
      });
      assert.equal(acquired.sourceKind, "local_package");
      assert.equal(acquired.archiveDigest, sha256(bytes));

      const github = createGitHubReleasePluginPackageAcquisition({
        fetchImpl: async (url) => {
          const parsed = new URL(String(url));
          if (parsed.pathname.includes("/releases/tags/")) {
            return {
              status: 200,
              headers: { get: () => null },
              body: null,
              async arrayBuffer() {
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
            headers: { get: () => null },
            body: null,
            async arrayBuffer() {
              return Uint8Array.from(bytes).buffer;
            }
          };
        }
      });
      const online = await github.acquire({
        repository: "acme/plugins",
        release: "v1.0.0",
        asset: "sample-plugin.tar.gz"
      });
      assert.equal(online.archiveDigest, acquired.archiveDigest);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects links, path escape, unsafe modes, oversize, and cancellation with path-free errors", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-pkg-"));
    try {
      await fs.writeFile(path.join(root, "ok.tar.gz"), Buffer.from("ok"), { mode: 0o644 });
      await fs.symlink(path.join(root, "ok.tar.gz"), path.join(root, "link.tar.gz"));
      await fs.mkdir(path.join(root, "dir"));
      const widePath = path.join(root, "wide.tar.gz");
      await fs.writeFile(widePath, Buffer.from("wide"), { mode: 0o644 });
      await fs.chmod(widePath, 0o666);

      const local = createLocalPluginPackageAcquisition({
        resolveImportRoot: async () => root,
        maxBytes: 8
      });

      await assert.rejects(
        () => local.acquire({ importRootId: "r", relativePath: "link.tar.gz" }),
        /symbolic links/
      );
      await assert.rejects(
        () => local.acquire({ importRootId: "r", relativePath: "../escape.tar.gz" }),
        /escapes/
      );
      await assert.rejects(
        () => local.acquire({ importRootId: "r", relativePath: "dir" }),
        /regular file/
      );
      await assert.rejects(
        () => local.acquire({ importRootId: "r", relativePath: "wide.tar.gz" }),
        /mode is unsafe/
      );
      await fs.writeFile(path.join(root, "big.tar.gz"), Buffer.alloc(16), { mode: 0o644 });
      await assert.rejects(
        () => local.acquire({ importRootId: "r", relativePath: "big.tar.gz" }),
        /byte budget/
      );

      const controller = new AbortController();
      controller.abort();
      await assert.rejects(
        () => local.acquire({ importRootId: "r", relativePath: "ok.tar.gz" }, {}, controller.signal),
        /cancelled/
      );

      try {
        await local.acquire({ importRootId: "r", relativePath: "missing.tar.gz" });
        assert.fail("expected missing rejection");
      } catch (error) {
        assert.match(String(error.message), /PLUGIN_PACKAGE_/);
        assert.equal(String(error.message).includes(root), false);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("coalesces identical imports and does not stage plugins", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-pkg-"));
    try {
      const bytes = Buffer.from("coalesce");
      await fs.writeFile(path.join(root, "sample-plugin.tar.gz"), bytes, { mode: 0o644 });
      let opens = 0;
      const local = createLocalPluginPackageAcquisition({
        resolveImportRoot: async () => root,
        openFile: async (candidate) => {
          opens += 1;
          return fs.open(candidate, "r");
        }
      });
      const source = {
        importRootId: "plugins-offline",
        relativePath: "sample-plugin.tar.gz"
      };
      const [a, b] = await Promise.all([local.acquire(source), local.acquire(source)]);
      assert.equal(a.archiveDigest, b.archiveDigest);
      assert.equal(opens, 1);

      const acquisition = createPluginPackageAcquisition({
        local: { resolveImportRoot: async () => root }
      });
      const custodyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-life-"));
      try {
        const lifecycle = createPluginPackageLifecycle({
          custody: createPluginPackageCustody({ rootDir: custodyRoot }),
          acquisitionPort: acquisition.port
        });
        const receipt = await lifecycle.acquire({
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

  it("keeps the offline adapter free of network calls", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "lico-local-pkg-"));
    try {
      await fs.writeFile(path.join(root, "sample-plugin.tar.gz"), Buffer.from("offline"), { mode: 0o644 });
      const previousFetch = globalThis.fetch;
      globalThis.fetch = async () => {
        throw new Error("network should not be reached");
      };
      try {
        const local = createLocalPluginPackageAcquisition({
          resolveImportRoot: async () => root
        });
        const acquired = await local.acquire({
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
