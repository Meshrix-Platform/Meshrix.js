import { PassThrough, Transform } from "node:stream";
import { createHash } from "node:crypto";
import { digestBytes, throwIfAborted } from "../utils.ts";

export interface StreamObservation {
  readonly bytes: number;
  readonly digest: string;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly owner: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly digest: string;
}

export function createCountingTransform(maxBytes: number): Transform & { observation(): StreamObservation } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive integer.");
  let bytes = 0;
  const hash = createHash("sha256");
  const transform = new Transform({
    transform(chunk: unknown, _encoding, callback) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += buffer.byteLength;
      if (bytes > maxBytes) {
        callback(Object.assign(new Error("Stream exceeds the configured byte budget."), { code: "transit_budget_exceeded", status: 413 }));
        return;
      }
      hash.update(buffer);
      callback(null, buffer);
    }
  }) as Transform & { observation(): StreamObservation };
  transform.observation = () => Object.freeze({ bytes, digest: hash.copy().digest("hex") });
  return transform;
}

export async function collectOpaqueStream(source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, options: { readonly maxBytes: number; readonly signal?: AbortSignal } ): Promise<{ readonly bytes: Uint8Array; readonly observation: StreamObservation }> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  const hash = createHash("sha256");
  const iterable: AsyncIterable<Uint8Array> = Symbol.asyncIterator in Object(source)
    ? source as AsyncIterable<Uint8Array>
    : (async function* streamIterator() {
        const reader = (source as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            const item = await reader.read();
            if (item.done) return;
            yield item.value;
          }
        } finally {
          reader.releaseLock();
        }
      })();
  for await (const chunk of iterable) {
    throwIfAborted(options.signal);
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    size += bytes.byteLength;
    if (size > options.maxBytes) throw Object.assign(new Error("Stream exceeds the configured byte budget."), { code: "transit_budget_exceeded", status: 413 });
    chunks.push(bytes.slice());
    hash.update(bytes);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return Object.freeze({ bytes: output, observation: Object.freeze({ bytes: size, digest: hash.digest("hex") }) });
}

export class MemoryArtifactStore {
  readonly #records = new Map<string, ArtifactRecord>();
  readonly #nextId = { value: 0 };

  put(input: { readonly owner: string; readonly bytes: Uint8Array; readonly contentType?: string }): ArtifactRecord {
    const id = `artifact_${++this.#nextId.value}`;
    const bytes = input.bytes.slice();
    const record = Object.freeze({ id, owner: input.owner, bytes, contentType: input.contentType ?? "application/octet-stream", digest: digestBytes(bytes) });
    this.#records.set(id, record);
    return record;
  }

  head(id: string, subject: string): Pick<ArtifactRecord, "id" | "owner" | "contentType" | "digest"> & { readonly length: number } {
    const record = this.#authorize(id, subject);
    return Object.freeze({ id: record.id, owner: record.owner, contentType: record.contentType, digest: record.digest, length: record.bytes.byteLength });
  }

  read(id: string, subject: string, range?: { readonly start?: number; readonly end?: number }): Uint8Array {
    const record = this.#authorize(id, subject);
    const start = Math.max(0, Math.floor(range?.start ?? 0));
    const end = Math.min(record.bytes.byteLength, Math.floor(range?.end ?? record.bytes.byteLength));
    if (start > end || start > record.bytes.byteLength) throw Object.assign(new Error("Artifact range is invalid."), { code: "artifact_range_invalid", status: 416 });
    return record.bytes.slice(start, end);
  }

  #authorize(id: string, subject: string): ArtifactRecord {
    const record = this.#records.get(id);
    if (!record) throw Object.assign(new Error("Artifact was not found."), { code: "artifact_not_found", status: 404 });
    if (record.owner !== subject) throw Object.assign(new Error("Artifact access is not authorized."), { code: "artifact_forbidden", status: 403 });
    return record;
  }
}

export function createOpaquePassThrough(): PassThrough {
  return new PassThrough({ objectMode: false });
}
