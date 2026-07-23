import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  verifyUploadedFiles
} from "../../../packages/protocols/http/controllers/jobs-controller-upload-verification.mjs";

function u16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeStoredZip(entryNames = []) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entryName of entryNames) {
    const name = Buffer.from(entryName, "utf8");
    const local = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0),
      u16(name.length),
      u16(0),
      name
    ]);
    const central = Buffer.concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(0),
      u32(0),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(localOffset),
      name
    ]);
    localParts.push(local);
    centralParts.push(central);
    localOffset += local.length;
  }
  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(entryNames.length),
    u16(entryNames.length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0)
  ]);
  return Buffer.concat([localData, centralDirectory, eocd]);
}

function verifySingleUpload(buffer) {
  return verifyUploadedFiles({
    uploadedFiles: [{
      name: "upload.bin",
      relativePath: "upload.bin",
      dataBase64: buffer.toString("base64"),
      byteSize: buffer.length
    }]
  }).uploadedFiles[0];
}

describe("jobs controller upload verification", () => {
  it("infers Office ZIP containers from central directory names without unpacking file data", () => {
    assert.match(verifySingleUpload(makeStoredZip(["word/document.xml"])).name, /\.docx$/u);
    assert.match(verifySingleUpload(makeStoredZip(["xl/workbook.xml"])).name, /\.xlsx$/u);
    assert.match(verifySingleUpload(makeStoredZip(["ppt/presentation.xml"])).name, /\.pptx$/u);
  });

  it("keeps over-limit ZIP central directories as generic zip instead of deep inspecting entries", () => {
    const names = Array.from({ length: 513 }, (_, index) => `folder-${index}/file.txt`);
    names[512] = "word/document.xml";

    assert.match(verifySingleUpload(makeStoredZip(names)).name, /\.zip$/u);
  });

  it("does not infer Office extensions from local payload text when central directory is unavailable", () => {
    const localOnlyZipLikePayload = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from("word/document.xml")
    ]);

    assert.match(verifySingleUpload(localOnlyZipLikePayload).name, /\.zip$/u);
  });
});
