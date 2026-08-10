import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Type } from "typebox";

const TOOL_PREFIX = "mcp_lico_";

function configPath() {
  const configured = String(process.env.MESHRIX_MCP_PI_CONFIG || "").trim();
  return configured || path.join(os.homedir(), ".lico", "mcp", "pi.json");
}

async function loadConfig() {
  try {
    const parsed = JSON.parse(await readFile(configPath(), "utf8"));
    const command = typeof parsed?.command === "string" ? parsed.command.trim() : "";
    const args = Array.isArray(parsed?.args) && parsed.args.every((value) => typeof value === "string") ? parsed.args : [];
    return command ? { command, args } : null;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Meshrix Pi configuration is invalid.");
  }
}

function stableHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(8, "0").slice(0, 8);
}

export function piToolName(name) {
  const safe = `${TOOL_PREFIX}${name}`.replace(/[^a-zA-Z0-9_]/g, "_");
  return safe.length <= 64 ? safe : `${safe.slice(0, 55)}_${stableHash(safe)}`;
}

export function piContent(content) {
  if (!Array.isArray(content)) return [{ type: "text", text: String(content ?? "") }];
  return content.map((item) => {
    if (item?.type === "text") return { type: "text", text: String(item.text ?? "") };
    if (item?.type === "image" && item.data && item.mimeType) {
      return { type: "image", data: String(item.data), mimeType: String(item.mimeType) };
    }
    if (item?.type === "resource" && item.resource?.text) {
      return { type: "text", text: String(item.resource.text) };
    }
    return { type: "text", text: JSON.stringify(item ?? null) };
  });
}

export default async function meshrixPiExtension(pi) {
  let client = null;
  let started = false;

  async function start(ctx) {
    if (started) return;
    const config = await loadConfig();
    if (!config) return;
    started = true;
    try {
      client = new Client({ name: "meshrix-pi-extension", version: "0.0.1" }, { capabilities: {} });
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === "string")),
        stderr: "pipe"
      });
      await client.connect(transport);
      const listed = await client.listTools();
      for (const tool of listed.tools) {
        const mcpName = tool.name;
        pi.registerTool({
          name: piToolName(mcpName),
          label: tool.title || mcpName,
          description: tool.description || `Meshrix MCP tool ${mcpName}`,
          parameters: Type.Unsafe(tool.inputSchema || { type: "object", properties: {} }),
          async execute(_toolCallId, params, signal) {
            if (!client) throw new Error("Meshrix MCP connection is not available.");
            const result = await client.callTool({ name: mcpName, arguments: params }, undefined, signal ? { signal } : undefined);
            return { content: piContent(result.content), details: { isError: result.isError === true } };
          }
        });
      }
    } catch {
      started = false;
      await client?.close().catch(() => {});
      client = null;
      ctx?.ui?.notify?.("Meshrix MCP could not be started. Run meshrix-mcp doctor for details.", "error");
    }
  }

  pi.on("session_start", async (_event, ctx) => start(ctx));
  pi.on("session_shutdown", async () => {
    started = false;
    await client?.close().catch(() => {});
    client = null;
  });
}
