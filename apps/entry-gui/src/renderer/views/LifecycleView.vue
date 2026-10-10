<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import type { OwnedPathsResult } from "../../shared/ipc-contract.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const ownedPaths = ref<readonly string[] | null>(null);

async function loadOwned(): Promise<void> {
  const result = await runOp<OwnedPathsResult>("lifecycle.ownedPaths");
  if (result) ownedPaths.value = result.ownedPaths;
}
</script>

<template>
  <section class="card">
    <h2>App &amp; lifecycle</h2>
    <dl>
      <dt>Version</dt><dd class="mono">{{ state.appVersion }}</dd>
      <dt>State</dt><dd><span class="badge unknown">{{ state.lifecycle.state }}</span></dd>
      <dt>Data directory</dt><dd class="mono">{{ state.lifecycle.dataDir }}</dd>
      <dt>Config file</dt><dd class="mono">{{ state.lifecycle.configPath }}</dd>
      <dt>Update policy</dt><dd>{{ state.lifecycle.updatePolicy }} — updates install only via the package you choose; the app never self-executes a binary update.</dd>
      <dt>Custody</dt><dd>{{ state.custody.tier }} — {{ state.custody.reason }}</dd>
    </dl>
    <button class="plain" @click="loadOwned">Show owned paths</button>
    <ul v-if="ownedPaths">
      <li v-for="path in ownedPaths" :key="path" class="mono">{{ path }}</li>
    </ul>
    <p class="hint">
      Uninstall removes exactly the owned paths above plus the custody entries this app
      minted (entry-gui.* refs). Nothing else on this device is touched. On macOS quit the
      app, then delete the .app bundle; on Windows use the NSIS uninstaller.
    </p>
  </section>
</template>

<style scoped>
dl { display: grid; grid-template-columns: 10rem 1fr; gap: 0.3rem 0.75rem; font-size: 0.85rem; }
dt { opacity: 0.7; }
dd { margin: 0; }
.hint { font-size: 0.78rem; opacity: 0.75; }
</style>
