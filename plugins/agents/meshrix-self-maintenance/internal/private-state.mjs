import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { MAX_JOURNAL_RECORDS } from "./constants.mjs";

async function atomicWrite(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.replace-${crypto.randomUUID()}`;
  await fs.writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await fs.rename(temporary, file);
}

async function readArray(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

export class PrivateStateStore {
  #journalFile;
  #queueFile;
  #journalTail = Promise.resolve();
  #queueTail = Promise.resolve();

  constructor(root) {
    this.#journalFile = path.join(root, "journal.json");
    this.#queueFile = path.join(root, "queue.json");
  }

  async record(entry) {
    this.#journalTail = this.#journalTail.catch(() => {}).then(async () => {
      const records = await readArray(this.#journalFile);
      records.push(Object.freeze({
        at: new Date().toISOString(),
        runId: entry.runId || null,
        revision: entry.revision || null,
        scheduleId: entry.scheduleId || null,
        state: entry.state,
        code: entry.code || null,
        operationId: entry.operationId || null
      }));
      await atomicWrite(this.#journalFile, records.slice(-MAX_JOURNAL_RECORDS));
    });
    await this.#journalTail;
  }

  async loadQueue() {
    return readArray(this.#queueFile);
  }

  async saveQueue(items) {
    this.#queueTail = this.#queueTail.catch(() => {}).then(() => atomicWrite(this.#queueFile, items));
    await this.#queueTail;
  }
}
