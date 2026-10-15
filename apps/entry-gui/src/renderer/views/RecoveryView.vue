<script setup lang="ts">
import { computed, onUnmounted, ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import type { RecoveryRevealResult } from "../../shared/ipc-contract.ts";
import { openAccountPage } from "../bridge.ts";
import { runOp } from "../store.ts";

const props = defineProps<{ state: GuiState }>();

/**
 * The revealed text lives only in this component's local state — never in the
 * shared store, never in the pushed snapshot — and is cleared on confirm or
 * when the view unmounts.
 */
const revealedText = ref<string | null>(null);
const busy = ref(false);
const showText = ref(false);

const recovery = computed(() => props.state.recovery);

async function reveal(): Promise<void> {
  busy.value = true;
  try {
    const result = await runOp<RecoveryRevealResult>("recovery.revealKey");
    if (result) {
      revealedText.value = result.recoveryText;
      showText.value = true;
    }
  } finally {
    busy.value = false;
  }
}

async function confirmSaved(): Promise<void> {
  busy.value = true;
  try {
    const ok = await runOp<GuiState>("recovery.confirmSaved");
    if (ok !== null) revealedText.value = null;
    if (ok?.account.transactionPurpose === "step_up" && ok.account.transactionId) {
      await openAccountPage(ok.account.transactionId);
    }
  } finally {
    busy.value = false;
  }
}

async function retryWriterRegistration(): Promise<void> {
  busy.value = true;
  try {
    const result = await runOp<GuiState>("recovery.retryWriterRegistration");
    if (result?.account.transactionPurpose === "step_up" && result.account.transactionId) {
      await openAccountPage(result.account.transactionId);
    }
  } finally {
    busy.value = false;
  }
}

async function checkWriterRegistration(): Promise<void> {
  await runOp("account.checkTransaction");
}

async function beginSetup(): Promise<void> {
  busy.value = true;
  try { await runOp("recovery.beginSetup"); } finally { busy.value = false; }
}

async function beginRotation(): Promise<void> {
  busy.value = true;
  try { await runOp("recovery.beginRotation"); } finally { busy.value = false; }
}

async function abortRotation(): Promise<void> {
  busy.value = true;
  try { await runOp("recovery.abortRotation"); } finally { busy.value = false; }
}

async function retryRotation(): Promise<void> {
  busy.value = true;
  try { await runOp("recovery.retryRotation"); } finally { busy.value = false; }
}

const rotationOpen = computed(() =>
  recovery.value.rotation !== null
  && recovery.value.rotation.state !== "completed"
  && recovery.value.rotation.state !== "aborted");

onUnmounted(() => {
  revealedText.value = null;
});
</script>

<template>
  <section class="card">
    <h2>Recovery key</h2>
    <p v-if="recovery.state === 'not_configured'">
      No recovery key is configured. Generate one now — it is shown exactly once and stays
      in your hands. Losing it means the encrypted backup cannot be recovered on a fresh install.
    </p>
    <p v-else>
      <span class="badge" :class="recovery.state">{{ recovery.state }}</span>
      key <code class="mono">{{ recovery.keyId }}</code> · generation {{ recovery.generation }} ·
      vault <code class="mono">{{ recovery.vaultId }}</code>
    </p>

    <div class="row" v-if="recovery.state === 'not_configured'">
      <button class="primary" :disabled="busy" @click="beginSetup">Generate recovery key</button>
    </div>
    <div class="row" v-else>
      <button class="plain" :disabled="busy" @click="beginRotation">Rotate recovery key…</button>
    </div>
  </section>

  <section v-if="recovery.state === 'awaiting_save'" class="card">
    <h3>Save your recovery key — shown once</h3>
    <p>
      Write this down or store it in a password manager. It is displayed exactly once;
      after you confirm it is saved, this app keeps only the derived signing material —
      never the key text itself.
    </p>
    <div class="row">
      <button class="primary" :disabled="busy || recovery.keyRevealed" @click="reveal">Show once</button>
      <button class="plain" @click="showText = !showText" :disabled="!revealedText">
        {{ showText ? "Hide" : "Unmask" }}
      </button>
      <button class="plain" :disabled="busy" @click="abortRotation">Cancel unsaved key</button>
    </div>
    <p v-if="revealedText" class="mono recovery-text">
      {{ showText ? revealedText : "••••-••••-••••-••••-••••-••••-••••-••••" }}
    </p>
    <button class="primary" :disabled="busy || !recovery.keyRevealed" @click="confirmSaved">
      I saved it — finish setup
    </button>
  </section>

  <section v-if="recovery.writerRegistration.state !== 'unmanaged'" class="card">
    <h3>Account vault writer</h3>
    <p><span class="badge" :class="recovery.writerRegistration.state">{{ recovery.writerRegistration.state }}</span></p>
    <p v-if="recovery.writerRegistration.detail">{{ recovery.writerRegistration.detail }}</p>
    <p v-if="state.account.transactionPurpose === 'step_up' && state.account.actionPurpose === 'grant_access'">
      Approve the exact new vault keys in the system browser before cloud backup can continue.
    </p>
    <div class="row">
      <button
        v-if="state.account.transactionId"
        class="plain"
        @click="openAccountPage(state.account.transactionId)"
      >Open approval</button>
      <button
        v-if="state.account.transactionId"
        class="primary"
        :disabled="busy"
        @click="checkWriterRegistration"
      >Check approval</button>
      <button
        v-if="recovery.writerRegistration.state === 'prepare_pending' || recovery.writerRegistration.state === 'service_pending' || (recovery.writerRegistration.state === 'authorization_required' && !state.account.transactionId)"
        class="plain"
        :disabled="busy"
        @click="retryWriterRegistration"
      >Retry registration</button>
    </div>
  </section>

  <section v-if="recovery.rotation" class="card">
    <h3>{{ rotationOpen ? "Rotation in progress" : (recovery.rotation.state === "aborted" ? "Rotation aborted" : "Rotation completed") }}</h3>
    <p>
      <span class="badge" :class="recovery.rotation.state">{{ recovery.rotation.state }}</span>
      candidate generation {{ recovery.rotation.candidateGeneration }}
    </p>
    <ul>
      <li v-for="endpoint in recovery.rotation.endpoints" :key="endpoint.endpointRouteId">
        <code class="mono">{{ endpoint.endpointRouteId }}</code>
        <span class="badge" :class="endpoint.state">{{ endpoint.state }}</span>
      </li>
    </ul>
    <p v-if="rotationOpen && recovery.rotation.endpoints.some((endpoint) => endpoint.state !== 'acknowledged')">
      The rotation completes only when every endpoint acknowledges. Pending or unreachable
      endpoints keep it open — nothing here is claimed finished early.
    </p>
    <p v-if="recovery.rotation.state === 'aborted'">
      The staged candidate was discarded; endpoints keep the current recovery key. A fresh
      rotation can be started at any time.
    </p>
    <div v-if="rotationOpen" class="row">
      <button class="plain" :disabled="busy" @click="retryRotation">
        Retry pending endpoints
      </button>
      <button class="plain" :disabled="busy" @click="abortRotation">
        Abort rotation — keep the current key
      </button>
    </div>
  </section>

  <section class="card">
    <h3>Encrypted backup</h3>
    <p v-if="recovery.backup.lastSuccessAt">
      Last published revision {{ recovery.backup.lastCommittedRevision }} at
      {{ recovery.backup.lastSuccessAt }}.
    </p>
    <p v-else>No snapshot published yet.</p>
    <p v-if="recovery.backup.lastError" class="error">{{ recovery.backup.lastError }}</p>
  </section>
</template>

<style scoped>
.recovery-text {
  padding: 0.75rem;
  border: 1px dashed #8886;
  border-radius: 0.4rem;
  letter-spacing: 0.08em;
}
</style>
