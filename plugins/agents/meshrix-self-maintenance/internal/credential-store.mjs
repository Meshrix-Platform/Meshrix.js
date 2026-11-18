import fs from "node:fs/promises";
import path from "node:path";

const REF_PATTERN = /^credential:([a-zA-Z0-9._-]+)$/u;

function closedCredential(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === "token" && typeof value.token === "string" && value.token.length > 0;
}

export class FileCredentialStore {
  #root;

  constructor(root) {
    this.#root = root;
  }

  async resolve(reference) {
    const match = REF_PATTERN.exec(reference);
    if (!match) throw new Error("credential_reference_invalid");
    const file = path.join(this.#root, `${match[1]}.json`);
    const relative = path.relative(this.#root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("credential_reference_invalid");
    const stat = await fs.stat(file);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("credential_file_not_private");
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    if (!closedCredential(value)) throw new Error("credential_record_invalid");
    return Object.freeze({ token: value.token });
  }
}
