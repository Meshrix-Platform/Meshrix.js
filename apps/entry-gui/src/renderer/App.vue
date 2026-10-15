<script setup lang="ts">
import { ref } from "vue";

import AccountView from "./views/AccountView.vue";
import ActivityView from "./views/ActivityView.vue";
import AgentsView from "./views/AgentsView.vue";
import ConnectionsView from "./views/ConnectionsView.vue";
import LifecycleView from "./views/LifecycleView.vue";
import McpSetupView from "./views/McpSetupView.vue";
import PairingView from "./views/PairingView.vue";
import PersonalView from "./views/PersonalView.vue";
import RecoveryImportView from "./views/RecoveryImportView.vue";
import RecoveryView from "./views/RecoveryView.vue";
import { quitApp as requestQuit } from "./bridge.ts";
import { state, store } from "./store.ts";

type NavItem = "personal" | "connections" | "pair" | "agents" | "activity" | "account" | "recovery" | "recover" | "mcp" | "app";

const nav = ref<NavItem>(state.value.connections.length ? "connections" : "personal");

function quitApp(): void {
  void requestQuit().catch((error: unknown) => {
    store.lastError = error instanceof Error ? error.message : "Meshrix could not stop the profile service.";
  });
}

</script>

<template>
  <header class="top">
    <h1>Meshrix Entry</h1>
    <nav>
      <button class="nav" :class="{ on: nav === 'personal' }" @click="nav = 'personal'">Personal space</button>
      <button class="nav" :class="{ on: nav === 'connections' }" @click="nav = 'connections'">Connections</button>
      <button class="nav" :class="{ on: nav === 'pair' }" @click="nav = 'pair'">Pair New Device</button>
      <button class="nav" :class="{ on: nav === 'agents' }" @click="nav = 'agents'">Agents</button>
      <button class="nav" :class="{ on: nav === 'activity' }" @click="nav = 'activity'">Activity</button>
      <button class="nav" :class="{ on: nav === 'account' }" @click="nav = 'account'">Account</button>
      <button class="nav" :class="{ on: nav === 'recovery' }" @click="nav = 'recovery'">Recovery</button>
      <button class="nav" :class="{ on: nav === 'recover' }" @click="nav = 'recover'">Recover This Device</button>
      <button class="nav" :class="{ on: nav === 'mcp' }" @click="nav = 'mcp'">MCP Setup</button>
      <button class="nav" :class="{ on: nav === 'app' }" @click="nav = 'app'">App</button>
      <button class="nav" @click="quitApp">Quit Meshrix</button>
    </nav>
  </header>

  <p v-if="state.lifecycle.state === 'starting' && !store.lastError" class="startup-status" role="status">
    Starting Meshrix and reconnecting to the profile service…
  </p>
  <p v-if="store.lastError" class="startup-error error" role="alert">{{ store.lastError }}</p>

  <main>
    <PersonalView v-if="nav === 'personal'" :state="state" />
    <ConnectionsView v-else-if="nav === 'connections'" :state="state" />
    <PairingView v-else-if="nav === 'pair'" :state="state" />
    <AgentsView v-else-if="nav === 'agents'" :state="state" />
    <ActivityView v-else-if="nav === 'activity'" :state="state" />
    <AccountView v-else-if="nav === 'account'" :state="state" />
    <RecoveryView v-else-if="nav === 'recovery'" :state="state" />
    <RecoveryImportView v-else-if="nav === 'recover'" :state="state" />
    <McpSetupView v-else-if="nav === 'mcp'" :state="state" />
    <LifecycleView v-else :state="state" />
  </main>

  <footer v-if="state.notices.length" class="notices">
    <p v-for="notice in state.notices" :key="notice" class="notice">{{ notice }}</p>
  </footer>
</template>

<style>
:root {
  color-scheme: light dark;
  font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
}
body { margin: 0; padding: 0 1.5rem 2rem; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
.top { display: flex; align-items: baseline; gap: 1.5rem; flex-wrap: wrap; }
h1 { font-size: 1.25rem; }
nav { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.nav { border: 1px solid #8886; background: transparent; padding: 0.3rem 0.7rem; border-radius: 0.4rem; cursor: pointer; }
.nav.on { background: #8882; }
.card { border: 1px solid #8885; border-radius: 0.6rem; padding: 1rem 1.2rem; margin: 1rem 0; max-width: 52rem; }
.field { display: block; margin: 0.6rem 0; font-size: 0.85rem; }
.field textarea, .field input { display: block; width: 100%; margin-top: 0.25rem; font-family: inherit; padding: 0.4rem; box-sizing: border-box; }
.row { display: flex; gap: 0.6rem; margin: 0.6rem 0; flex-wrap: wrap; }
button { font: inherit; }
button.primary { border: none; background: #3457d5; color: white; padding: 0.45rem 0.9rem; border-radius: 0.4rem; cursor: pointer; }
button.primary:disabled { opacity: 0.5; cursor: default; }
button.plain { border: 1px solid #8886; background: transparent; padding: 0.4rem 0.8rem; border-radius: 0.4rem; cursor: pointer; }
button.danger { border: 1px solid #c0392b; color: #c0392b; background: transparent; padding: 0.4rem 0.8rem; border-radius: 0.4rem; cursor: pointer; }
.badge { display: inline-block; padding: 0.1rem 0.5rem; border-radius: 1rem; font-size: 0.75rem; border: 1px solid #8886; }
.badge.reachable, .badge.enrolled, .badge.active, .badge.enabled, .badge.acknowledged { border-color: #1e8e3e; color: #1e8e3e; }
.badge.unreachable, .badge.closed, .badge.offline, .badge.refused, .badge.disabled { border-color: #c0392b; color: #c0392b; }
.error { color: #c0392b; }
.startup-status, .startup-error { border-radius: 0.4rem; padding: 0.6rem 0.8rem; }
.startup-status { background: #8882; }
.startup-error { background: #c0392b18; }
.notices { position: fixed; bottom: 0.5rem; right: 1rem; max-width: 24rem; }
.notice { background: #333; color: #eee; padding: 0.4rem 0.8rem; border-radius: 0.4rem; font-size: 0.8rem; }
dl { margin: 0.5rem 0; }
</style>
