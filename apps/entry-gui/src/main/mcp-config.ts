/**
 * Standard MCP client setup — snippet generation and owned managed config.
 *
 * The product's preferred local transport is stdio: the MCP client launches
 * `meshrix-entry --mcp-stdio` per session, so no listener, port or auth token
 * is needed. The snippet is plain JSON for the client's `mcpServers` block.
 * `writeManagedMcpConfig` writes ONLY inside the app's owned data dir — a
 * file the app created and the uninstaller removes.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface McpSnippetInput {
  readonly serverName: string;
  readonly command: string;
  readonly args?: readonly string[];
}

/** The managed config path the app owns inside its data dir. */
export function managedMcpConfigPath(dataDir: string): string {
  return join(dataDir, "mcp", "meshrix-entry.mcp.json");
}

/** Standard MCP `mcpServers` snippet for the entry stdio face. */
export function buildMcpStdioSnippet(input: McpSnippetInput): string {
  const body = {
    mcpServers: {
      [input.serverName]: {
        command: input.command,
        args: [...(input.args ?? ["--mcp-stdio"])]
      }
    }
  };
  return JSON.stringify(body, null, 2);
}

/** Write the app's own managed MCP snippet file (created 0o600). */
export async function writeManagedMcpConfig(input: {
  readonly filePath: string;
  readonly snippet: string;
}): Promise<void> {
  await mkdir(dirname(input.filePath), { recursive: true, mode: 0o700 });
  await writeFile(input.filePath, `${input.snippet}\n`, { encoding: "utf8", mode: 0o600 });
}
