import fs from "node:fs/promises";
import path from "node:path";

import { createVerifiedPluginPackage } from "@meshrix/contracts/plugins/verified-plugin-package";

function digestFileName(digest) {
  return String(digest || "").replace(/^sha256:/u, "");
}

export function createPluginPackageCustody({ rootDir } = {}) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: custody root is required");
  }
  const root = path.resolve(rootDir);
  const verifiedDir = path.join(root, "verified");
  const activeDir = path.join(root, "active");
  const archivesDir = path.join(root, "archives");

  async function ensure() {
    await fs.mkdir(verifiedDir, { recursive: true });
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(archivesDir, { recursive: true });
  }

  return Object.freeze({
    async putArchive(digest, bytes) {
      await ensure();
      const file = path.join(archivesDir, `${digestFileName(digest)}.tar.gz`);
      await fs.writeFile(file, bytes, { flag: "wx" }).catch(async (error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      return file;
    },

    async getArchive(digest) {
      await ensure();
      return fs.readFile(path.join(archivesDir, `${digestFileName(digest)}.tar.gz`));
    },

    async putVerified(record) {
      const verified = createVerifiedPluginPackage(record);
      await ensure();
      const file = path.join(verifiedDir, `${digestFileName(verified.packageDigest)}.json`);
      await fs.writeFile(file, `${JSON.stringify(verified, null, 2)}\n`, { flag: "wx" }).catch(async (error) => {
        if (error?.code !== "EEXIST") throw error;
      });
      return verified;
    },

    async getVerified(digest) {
      await ensure();
      const text = await fs.readFile(path.join(verifiedDir, `${digestFileName(digest)}.json`), "utf8");
      return createVerifiedPluginPackage(JSON.parse(text));
    },

    async setActiveGeneration(pluginId, generation) {
      await ensure();
      const file = path.join(activeDir, `${pluginId}.json`);
      const payload = Object.freeze({
        pluginId,
        generation: generation?.generation ?? null,
        packageDigest: generation?.packageDigest ?? null,
        state: generation?.state ?? null,
        updatedAt: new Date().toISOString()
      });
      const temp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`);
      await fs.rename(temp, file);
      return payload;
    },

    async getActiveGeneration(pluginId) {
      await ensure();
      try {
        return JSON.parse(await fs.readFile(path.join(activeDir, `${pluginId}.json`), "utf8"));
      } catch (error) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    async clearActiveGeneration(pluginId) {
      await ensure();
      await fs.rm(path.join(activeDir, `${pluginId}.json`), { force: true });
    }
  });
}
