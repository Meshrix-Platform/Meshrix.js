import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { payloadRepresentationError } from "./payload-contract.ts";

function plainObject(value?: any) : any {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function quoted(value: any = "") : any {
  return String(value || "").replace(/[\r\n]/gu, "").replace(/["\\]/gu, "\\$&").slice(0, 255);
}

function scalarBytes(value?: any, label?: any) : any {
  if (!["string", "number", "boolean"].includes(typeof value)) {
    throw payloadRepresentationError("payload_mapping_unsafe", `${label} must be a string, number, or boolean.`);
  }
  const bytes: any = Buffer.from(String(value), "utf8");
  if (bytes.byteLength > 64 * 1024) {
    throw payloadRepresentationError("payload_too_large", `${label} exceeds the scalar field limit.`, 413);
  }
  return bytes;
}

function filePartHeader(boundary?: any, partName?: any, metadata?: any) : any {
  const name: any = quoted(metadata.name || "artifact.bin") || "artifact.bin";
  const encodedName: any = encodeURIComponent(name).replace(/['()]/gu, (character?: any) : any => `%${character.charCodeAt(0).toString(16)}`);
  const mediaType: any = String(metadata.mediaType || "application/octet-stream").trim() || "application/octet-stream";
  return Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${quoted(partName)}"; filename="${name}"; filename*=UTF-8''${encodedName}\r\n` +
    `Content-Type: ${mediaType}\r\n\r\n`,
    "utf8"
  );
}

function scalarPartHeader(boundary?: any, partName?: any) : any {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(partName)}"\r\n\r\n`,
    "utf8"
  );
}

function artifactReferences(value?: any, declaration?: any) : any {
  if (declaration.multiple) {
    if (value === undefined || value === null || value === "") return [];
    if (!Array.isArray(value)) {
      throw payloadRepresentationError("payload_mapping_unsafe", `Artifact argument ${declaration.argument} must be an array.`);
    }
    if (value.length > declaration.maxCount) {
      throw payloadRepresentationError("payload_mapping_unsafe", `Artifact argument ${declaration.argument} exceeds maxCount.`);
    }
    return value.map((entry?: any) : any => String(entry || "").trim()).filter(Boolean);
  }
  const reference: any = String(value || "").trim();
  return reference ? [reference] : [];
}

export async function createArtifactBodySource({
  reference,
  artifactPort,
  subject,
  readAccess = {},
  maxBytes
}: Record<string, any> = {}) : Promise<any> {
  const source: any = await artifactPort.openRead(String(reference || "").trim(), subject, "upstream-request", null, readAccess);
  if (Number(source.metadata.byteLength || 0) > Number(maxBytes || 0)) {
    throw payloadRepresentationError("request_body_too_large", "Artifact request body exceeds its published limit.", 413);
  }
  return Object.freeze({
    contentType: source.metadata.mediaType || "application/octet-stream",
    contentLength: Number(source.metadata.byteLength || 0),
    replayable: true,
    metadata: source.metadata,
    openBody: () : any => source.open()
  });
}

export async function createMultipartBodyStream({
  mapping,
  fields,
  artifactPort,
  subject,
  readAccess = {},
  maxBytes
}: Record<string, any> = {}) : Promise<any> {
  const input: any = plainObject(fields);
  const boundary: any = `meshrix-${randomBytes(18).toString("hex")}`;
  const parts: any[] = [];
  for (const declaration of mapping.scalarFields || []) {
    const value: any = input[declaration.argument];
    if ((value === undefined || value === null || value === "") && !declaration.required) continue;
    if (value === undefined || value === null || value === "") {
      throw payloadRepresentationError("payload_mapping_unsafe", `Required scalar argument ${declaration.argument} is missing.`);
    }
    const body: any = scalarBytes(value, `Scalar argument ${declaration.argument}`);
    parts.push(Object.freeze({
      header: scalarPartHeader(boundary, declaration.partName),
      byteLength: body.byteLength,
      open: () : any => Readable.from([body])
    }));
  }
  for (const declaration of mapping.artifactParts || []) {
    const references: any = artifactReferences(input[declaration.argument], declaration);
    if (declaration.required && references.length === 0) {
      throw payloadRepresentationError("payload_mapping_unsafe", `Required artifact argument ${declaration.argument} is missing.`);
    }
    for (const reference of references) {
      const source: any = await artifactPort.openRead(reference, subject, "upstream-request", null, readAccess);
      parts.push(Object.freeze({
        header: filePartHeader(boundary, declaration.partName, source.metadata),
        byteLength: Number(source.metadata.byteLength || 0),
        open: source.open
      }));
    }
  }
  if (parts.length > mapping.maxParts) {
    throw payloadRepresentationError("payload_mapping_unsafe", "Multipart request exceeds its published part count.");
  }
  const separator: any = Buffer.from("\r\n", "utf8");
  const closing: any = Buffer.from(`--${boundary}--\r\n`, "utf8");
  const contentLength: any = parts.reduce(
    (total?: any, part?: any) : any => total + part.header.byteLength + part.byteLength + separator.byteLength,
    closing.byteLength
  );
  if (contentLength > Number(maxBytes || 0)) {
    throw payloadRepresentationError("request_body_too_large", "Multipart request exceeds its published byte limit.", 413);
  }
  return Object.freeze({
    contentType: `multipart/form-data; boundary=${boundary}`,
    contentLength,
    replayable: true,
    openBody() : any {
      return Readable.from((async function* multipartBody() : AsyncGenerator<any, any, any> {
        for (const part of parts) {
          yield part.header;
          for await (const chunk of part.open()) yield chunk;
          yield separator;
        }
        yield closing;
      })());
    }
  });
}
