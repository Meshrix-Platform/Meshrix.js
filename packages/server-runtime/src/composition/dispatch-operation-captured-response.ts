export function createCapturedResponse() : any {
  return {
    statusCode: 200,
    headers: {},
    chunks: [],
    writeHead(statusCode?: any, headers: Record<string, any> = {}) : any {
      this.statusCode = statusCode;
      this.headers = {
        ...this.headers,
        ...headers
      };
    },
    setHeader(name?: any, value?: any) : any {
      this.headers[name] = value;
    },
    getHeader(name?: any) : any {
      const lowerName: any = String(name || "").toLowerCase();
      const entry: any = (Object.entries(this.headers) as [string, any][]).find(
        ([headerName]: any[]) : any => headerName.toLowerCase() === lowerName
      );
      return entry?.[1];
    },
    write(chunk?: any) : any {
      if (chunk !== undefined && chunk !== null) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    end(chunk?: any) : any {
      this.write(chunk);
      this.ended = true;
    }
  };
}

export function getHeader(headers?: any, name?: any) : any {
  const lowerName: any = String(name || "").toLowerCase();
  const entry: any = (Object.entries(headers || {}) as [string, any][]).find(
    ([headerName]: any[]) : any => headerName.toLowerCase() === lowerName
  );
  return entry?.[1] || "";
}

export function parseCapturedResult({ operation, captured }: Record<string, any>) : any {
  const buffer: any = Buffer.concat(captured.chunks);
  const contentType: any = String(getHeader(captured.headers, "content-type") || "");
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
