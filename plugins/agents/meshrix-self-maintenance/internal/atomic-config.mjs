import fs from "node:fs/promises";

import { assertLocalConfig } from "./config-schema.mjs";

const MAX_CONFIG_BYTES = 256 * 1024;

function identity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

export class AtomicConfigSource {
  #path;
  #identity = null;
  #signature = null;
  #revision = null;

  constructor(path) {
    if (typeof path !== "string" || path.length === 0) throw new TypeError("config_path_required");
    this.#path = path;
  }

  async read() {
    let before;
    try {
      before = await fs.stat(this.#path);
    } catch (error) {
      if (error?.code === "ENOENT") return Object.freeze({ status: "missing" });
      return Object.freeze({ status: "invalid", code: "config_unreadable" });
    }
    if (!before.isFile() || before.size > MAX_CONFIG_BYTES) {
      return Object.freeze({ status: "invalid", code: "config_file_invalid" });
    }
    const currentIdentity = identity(before);
    if (this.#identity === currentIdentity) {
      const currentSignature = `${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
      if (currentSignature !== this.#signature) {
        return Object.freeze({ status: "invalid", code: "config_in_place_mutation" });
      }
      return Object.freeze({ status: "unchanged" });
    }
    try {
      const bytes = await fs.readFile(this.#path);
      const after = await fs.stat(this.#path);
      if (identity(after) !== currentIdentity || after.size !== bytes.byteLength) {
        return Object.freeze({ status: "invalid", code: "config_non_atomic_read" });
      }
      const config = assertLocalConfig(JSON.parse(bytes.toString("utf8")));
      if (this.#revision !== null && config.enabledRevision === this.#revision) {
        return Object.freeze({ status: "invalid", code: "config_revision_reused" });
      }
      this.#identity = currentIdentity;
      this.#signature = `${after.size}:${after.mtimeMs}:${after.ctimeMs}`;
      this.#revision = config.enabledRevision;
      return Object.freeze({ status: "replaced", config });
    } catch (error) {
      return Object.freeze({ status: "invalid", code: String(error?.message || "config_invalid") });
    }
  }
}
