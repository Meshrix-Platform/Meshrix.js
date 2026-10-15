import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const OWNER_DATABASE = ".meshrix-self-maintenance-owner.sqlite";

async function prepareOwnerFile(databasePath) {
  let ownerFile;
  try {
    try {
      ownerFile = await fs.open(databasePath, "wx", 0o600);
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const pathInfo = await fs.lstat(databasePath);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink()) {
        throw new Error("self_maintenance_owner_file_invalid");
      }
      const noFollow = fsConstants.O_NOFOLLOW || 0;
      ownerFile = await fs.open(databasePath, fsConstants.O_RDONLY | noFollow);
      let openedInfo = await ownerFile.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino) {
        throw new Error("self_maintenance_owner_file_invalid");
      }
      await ownerFile.chmod(0o600);
      await ownerFile.close();
      ownerFile = null;

      ownerFile = await fs.open(databasePath, fsConstants.O_RDWR | noFollow);
      openedInfo = await ownerFile.stat();
      const currentPathInfo = await fs.lstat(databasePath);
      if (!openedInfo.isFile() || !currentPathInfo.isFile() || currentPathInfo.isSymbolicLink() ||
          openedInfo.dev !== pathInfo.dev || openedInfo.ino !== pathInfo.ino ||
          currentPathInfo.dev !== pathInfo.dev || currentPathInfo.ino !== pathInfo.ino) {
        throw new Error("self_maintenance_owner_file_invalid");
      }
    }
    await ownerFile.chmod(0o600);
  } finally {
    await ownerFile?.close();
  }
}

export async function acquireDataRootOwnership(dataRoot) {
  const root = path.resolve(dataRoot);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const databasePath = path.join(root, OWNER_DATABASE);
  await prepareOwnerFile(databasePath);

  const database = new DatabaseSync(databasePath, { timeout: 0 });
  try {
    database.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    database.close();
    if (error?.errcode === 5 || error?.errcode === 6) {
      throw new Error("self_maintenance_data_root_in_use", { cause: error });
    }
    throw error;
  }

  let closed = false;
  return Object.freeze({
    close() {
      if (closed) return;
      try {
        if (database.isTransaction) database.exec("ROLLBACK");
      } finally {
        database.close();
        closed = true;
      }
    }
  });
}
