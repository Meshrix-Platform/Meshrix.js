<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import type { McpSnippetResult } from "../../shared/ipc-contract.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const snippet = ref<string | null>(null);
const managedPath = ref<string | null>(null);
const copied = ref(false);

async function generate(): Promise<void> {
  const result = await runOp<McpSnippetResult>("mcp.snippet");
  if (result) {
    snippet.value = result.snippet;
    managedPath.value = result.managedPath;
  }
}

async function writeManaged(): Promise<void> {
  const result = await runOp<{ snippet: string; managedPath: string }>("mcp.writeConfig");
  if (result) {
    snippet.value = result.snippet;
    managedPath.value = result.managedPath;
  }
}

async function copy(): Promise<void> {
  if (!snippet.value) return;
  await navigator.clipboard.writeText(snippet.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <section class="card">
    <h2>MCP client setup</h2>
    <p>
      Standard MCP clients launch the entry's stdio face per session — no port,
      listener or token. Paste the snippet into your client's
      <code class="mono">mcpServers</code> config.
    </p>
    <div class="row">
      <button class="primary" @click="generate">Generate snippet</button>
      <button class="plain" @click="writeManaged">Write managed config file</button>
      <button class="plain" :disabled="!snippet" @click="copy">{{ copied ? "Copied" : "Copy" }}</button>
    </div>
    <pre v-if="snippet" class="mono snippet">{{ snippet }}</pre>
    <p v-if="managedPath" class="mono">{{ managedPath }}</p>
    <p class="hint">
      The snippet launches <code class="mono">meshrix-entry --mcp-stdio</code>. Loopback-HTTP
      facing is available in the CLI for tools that cannot spawn stdio, but stdio is the
      recommended face: it binds no socket at all.
    </p>
  </section>
</template>

<style scoped>
.snippet {
  background: #8882;
  padding: 0.75rem;
  border-radius: 0.4rem;
  overflow: auto;
}
.hint { font-size: 0.8rem; opacity: 0.75; }
</style>
