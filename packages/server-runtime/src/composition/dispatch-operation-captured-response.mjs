export function createCapturedResponse() {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      this.headers = {
        ...this.headers,
        ...headers
      };
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    getHeader(name) {
      const lowerName = String(name || "").toLowerCase();
      const entry = Object.entries(this.headers).find(
        ([headerName]) => headerName.toLowerCase() === lowerName
      );
      return entry?.[1];
    },
    write(chunk) {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk) {
      this.write(chunk);
      this.ended = true;
    }
  };
}

export function getHeader(headers, name) {
  const lowerName = String(name || "").toLowerCase();
  const entry = Object.entries(headers || {}).find(
    ([headerName]) => headerName.toLowerCase() === lowerName
  );
  return entry?.[1] || "";
}

export function parseCapturedResult({ operation, captured }) {
  const buffer = Buffer.concat(captured.chunks);
  const contentType = String(getHeader(captured.headers, "content-type") || "");
  if (/json/i.test(contentType)) {
    return buffer.length > 0 ? JSON.parse(buffer.toString("utf8")) : {};
  }
  if (/^text\//i.test(contentType) || /html/i.test(contentType)) {
    return {
      contentType,
      text: buffer.toString("utf8")
    };
  }
  return {
    contentType: contentType || (operation.binary ? "application/octet-stream" : ""),
    byteLength: buffer.length,
    base64: buffer.toString("base64")
  };
}
