import fs from "node:fs/promises";
import path from "node:path";

import { createVerifiedPluginPackage } from "@meshrix/contracts/plugins/verified-plugin-package";

function digestFileName(digest?: any) : any {
  return String(digest || "").replace(/^sha256:/u, "");
}

export function createPluginPackageCustody({ rootDir }: Record<string, any> = {}) : any {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new Error("PLUGIN_PACKAGE_STAGING_FAILED: custody root is required");
  }
  const root: any = path.resolve(rootDir);
  const verifiedDir: any = path.join(root, "verified");
  const activeDir: any = path.join(root, "active");
  const archivesDir: any = path.join(root, "archives");

  async function ensure() : Promise<any> {
    await fs.mkdir(verifiedDir, { recursive: true });
    await fs.mkdir(activeDir, { recursive: true });
    await fs.mkdir(archivesDir, { recursive: true });
  }

  return Object.freeze({
    async putArchive(digest?: any, bytes?: any) : Promise<any> {
      await ensure();
      const file: any = path.join(archivesDir, `${digestFileName(digest)}.tar.gz`);
      await fs.writeFile(file, bytes, { flag: "wx" }).catch(async (error?: any) : Promise<any> => {
        if (error?.code !== "EEXIST") throw error;
      });
      return file;
    },

    async getArchive(digest?: any) : Promise<any> {
      await ensure();
      return fs.readFile(path.join(archivesDir, `${digestFileName(digest)}.tar.gz`));
    },

    async putVerified(record?: any) : Promise<any> {
      const verified: any = createVerifiedPluginPackage(record);
      await ensure();
      const file: any = path.join(verifiedDir, `${digestFileName(verified.packageDigest)}.json`);
      await fs.writeFile(file, `${JSON.stringify(verified, null, 2)}\n`, { flag: "wx" }).catch(async (error?: any) : Promise<any> => {
        if (error?.code !== "EEXIST") throw error;
      });
      return verified;
    },

    async getVerified(digest?: any) : Promise<any> {
      await ensure();
      const text: any = await fs.readFile(path.join(verifiedDir, `${digestFileName(digest)}.json`), "utf8");
      return createVerifiedPluginPackage(JSON.parse(text));
    },

    async setActiveGeneration(pluginId?: any, generation?: any) : Promise<any> {
      await ensure();
      const file: any = path.join(activeDir, `${pluginId}.json`);
      const payload: Readonly<Record<string, any>> = Object.freeze({
        pluginId,
        generation: generation?.generation ?? null,
        packageDigest: generation?.packageDigest ?? null,
        state: generation?.state ?? null,
        updatedAt: new Date().toISOString()
      });
      const temp: any = `${file}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify(payload, null, 2)}\n`);
      await fs.rename(temp, file);
      return payload;
    },

    async getActiveGeneration(pluginId?: any) : Promise<any> {
      await ensure();
      try {
        return JSON.parse(await fs.readFile(path.join(activeDir, `${pluginId}.json`), "utf8"));
      } catch (error: any) {
        if (error?.code === "ENOENT") return null;
        throw error;
      }
    },

    async clearActiveGeneration(pluginId?: any) : Promise<any> {
      await ensure();
      await fs.rm(path.join(activeDir, `${pluginId}.json`), { force: true });
    }
  });
}
