<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const id = ref("");
const displayName = ref("");
const description = ref("");
const command = ref("");
const argsText = ref("");
const cwd = ref("");
const envText = ref("");
const busy = ref(false);

function parseEnvironment(text: string): Record<string, { kind: "host_environment"; variable: string }> {
  const environment: Record<string, { kind: "host_environment"; variable: string }> = {};
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const splitAt = line.indexOf("=");
    if (splitAt <= 0) throw new Error("Environment mappings must use AGENT_NAME=HOST_NAME, one per line.");
    const name = line.slice(0, splitAt).trim();
    const variable = line.slice(splitAt + 1).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(variable)) {
      throw new Error("Environment mappings must contain valid variable names, not secret values.");
    }
    environment[name] = { kind: "host_environment", variable };
  }
  return environment;
}

async function enroll(): Promise<void> {
  busy.value = true;
  try {
    const environment = parseEnvironment(envText.value);
    const result = await runOp("agent.register", {
      id: id.value.trim(),
      displayName: displayName.value.trim(),
      description: description.value.trim() || null,
      command: command.value.trim(),
      args: argsText.value.split(/\r?\n/u).filter((line) => line.length > 0),
      cwd: cwd.value.trim(),
      environment,
      permissionPolicy: "ask",
      enabled: true
    });
    if (result) {
      id.value = "";
      displayName.value = "";
      description.value = "";
      command.value = "";
      argsText.value = "";
      cwd.value = "";
      envText.value = "";
    }
  } catch (error) {
    await runOp("state.get");
    if (error instanceof Error) window.alert(error.message);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h2>Agents on this device</h2>
    <p>Enroll the local Agent command and working directory here. Remote tasks can select only an enrolled Agent; they cannot choose an executable, working directory, or environment.</p>
    <p v-if="!state.applications.agents.length">No local Agent is enrolled yet.</p>
    <article v-for="agent in state.applications.agents" :key="agent.id" class="agent-row">
      <div>
        <strong>{{ agent.displayName }}</strong>
        <span class="mono"> ({{ agent.id }})</span>
        <span class="badge" :class="agent.enabled ? 'enabled' : 'disabled'">{{ agent.enabled ? 'enabled' : 'disabled' }}</span>
        <span class="badge">{{ agent.permissionMode }}</span>
      </div>
      <button class="danger" @click="runOp('agent.remove', { agentId: agent.id })">Remove</button>
    </article>
  </section>

  <section class="card">
    <h3>Enroll a local ACP Agent</h3>
    <label class="field">Agent ID<input v-model="id" autocomplete="off" placeholder="local-coding-agent" /></label>
    <label class="field">Display name<input v-model="displayName" autocomplete="off" placeholder="Coding Agent" /></label>
    <label class="field">Description<input v-model="description" autocomplete="off" placeholder="Optional short description" /></label>
    <label class="field">Executable command<input v-model="command" autocomplete="off" placeholder="/absolute/path/to/agent" /></label>
    <label class="field">Arguments, one per line<textarea v-model="argsText" rows="3" /></label>
    <label class="field">Working directory<input v-model="cwd" autocomplete="off" placeholder="/path/to/workspace" /></label>
    <label class="field">Optional host environment mappings, one AGENT_NAME=HOST_NAME per line<textarea v-model="envText" rows="3" autocomplete="off" /></label>
    <p class="hint">Every ACP tool permission is shown here for your approval. Environment mappings read values from the Meshrix process when the Agent starts; never paste secret values.</p>
    <div class="row"><button class="primary" :disabled="busy || !id.trim() || !displayName.trim() || !command.trim() || !cwd.trim()" @click="enroll">Save local Agent</button></div>
    <p class="hint">Command, arguments, working directory, and environment-source names stay in this device's protected Agent registry and are never included in status updates or peer messages.</p>
  </section>
</template>

<style scoped>
.agent-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; border-top: 1px solid #8885; padding: 0.7rem 0; }
.field select { display: block; margin-top: 0.25rem; padding: 0.4rem; }
.hint { font-size: 0.8rem; opacity: 0.75; }
</style>
