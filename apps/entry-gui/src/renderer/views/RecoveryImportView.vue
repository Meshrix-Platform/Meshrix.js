<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const recoveryText = ref("");
const serviceUrl = ref("");
const busy = ref(false);

async function importKey(): Promise<void> {
  busy.value = true;
  try {
    // The pasted text is an argument to the trusted main process — it is
    // never stored in renderer state and never echoed back.
    await runOp("recovery.importText", {
      recoveryText: recoveryText.value.trim(),
      ...(serviceUrl.value.trim() ? { serviceUrl: serviceUrl.value.trim() } : {})
    });
    recoveryText.value = "";
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h2>Recover this device</h2>
    <p>
      Fresh-install recovery needs two things: the recovery text you saved once, and the
      endpoint's service address. A fresh device key is minted locally — no old key,
      cookie or grant is ever restored.
    </p>
    <label class="field">
      Recovery text
      <textarea v-model="recoveryText" rows="4" placeholder="mrk1-…" autocomplete="off" spellcheck="false" />
    </label>
    <label class="field">
      Endpoint service address (required on a fresh install)
      <input v-model="serviceUrl" placeholder="https://endpoint.example" />
    </label>
    <button class="primary" :disabled="busy || !recoveryText.trim()" @click="importKey">
      Recover
    </button>
  </section>

  <section v-if="state.recoveryImport.phase !== 'idle'" class="card">
    <h3>Recovery status</h3>
    <p>
      <span class="badge" :class="state.recoveryImport.phase">{{ state.recoveryImport.phase }}</span>
      <span v-if="state.recoveryImport.detail"> — {{ state.recoveryImport.detail }}</span>
    </p>
    <p v-if="state.recoveryImport.phase === 'snapshot_missing'">
      No snapshot exists for that recovery key at the endpoint's vault — check the text and
      the service address.
    </p>
    <p v-else-if="state.recoveryImport.phase === 'snapshot_unusable'">
      The snapshot could not be used: {{ state.recoveryImport.detail }}.
    </p>
    <p v-else-if="state.recoveryImport.phase === 'enrolled'">
      This device enrolled a fresh identity under the recovered configuration. The endpoint
      verified the recovery authority; the inner channel now pins the new device key.
    </p>
  </section>
</template>
