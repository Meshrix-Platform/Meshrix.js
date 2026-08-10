let buffer = "";

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    if (request.method === "initialize") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          protocolVersion: request.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "pi-test", version: "1" }
        }
      });
    } else if (request.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: {
          tools: [{
            name: "file.convert",
            description: "Convert a file.",
            inputSchema: {
              type: "object",
              properties: { source: { type: "string" } },
              required: ["source"],
              additionalProperties: false
            }
          }]
        }
      });
    } else if (request.method === "tools/call") {
      send({
        jsonrpc: "2.0",
        id: request.id,
        result: { content: [{ type: "text", text: `converted:${request.params.arguments.source}` }] }
      });
    }
  }
});
