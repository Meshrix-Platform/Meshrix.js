<script setup lang="ts">
import { ref, watch } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import { openAccountPage } from "../bridge.ts";
import { runOp } from "../store.ts";

const props = defineProps<{ state: GuiState }>();
const busy = ref(false);
const inviteText = ref<string | null>(null);
const notice = ref<string | null>(null);
const browserError = ref<string | null>(null);
const copied = ref(false);
let enrollmentRequested = false;
let openedTransactionId: string | null = null;

watch(() => props.state.account.transactionId, (transactionId) => {
  if (!enrollmentRequested || !transactionId || transactionId === openedTransactionId) return;
  if (props.state.account.transactionPurpose !== "step_up") return;
  openedTransactionId = transactionId;
  void openAccountPage(transactionId).catch((error: unknown) => {
    browserError.value = error instanceof Error ? error.message : "Could not open the account browser.";
  });
});

async function enroll(): Promise<void> {
  enrollmentRequested = true;
  busy.value = true;
  notice.value = null;
  try {
    const state = await runOp<GuiState>("personal.enroll");
    if (state?.personalEndpoint.state === "connected") notice.value = "This installation is enrolled and connected.";
  } finally {
    busy.value = false;
    enrollmentRequested = false;
  }
}

async function createInvite(): Promise<void> {
  busy.value = true;
  notice.value = null;
  try {
    const result = await runOp<{ inviteText: string }>("personal.createInvite");
    if (result) inviteText.value = result.inviteText;
  } finally {
    busy.value = false;
  }
}

async function copyInvite(): Promise<void> {
  if (!inviteText.value) return;
  await navigator.clipboard.writeText(inviteText.value);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <section class="card">
    <h2>Your personal Meshrix space</h2>
    <p v-if="state.account.state !== 'authenticated'">
      Sign in or create your account first. Passkey, password plus authenticator, and linked Google, GitHub, or Apple sign-in are managed by the secure account page.
    </p>
    <p v-else>This profile is signed in as <span class="mono">{{ state.account.accountId }}</span>.</p>
    <div class="endpoint">
      <span class="badge" :class="state.personalEndpoint.state">{{ state.personalEndpoint.state }}</span>
      <span v-if="state.personalEndpoint.deviceId" class="mono">Device {{ state.personalEndpoint.deviceId }}</span>
      <span v-if="state.personalEndpoint.fingerprint" class="mono">Fingerprint {{ state.personalEndpoint.fingerprint }}</span>
    </div>
    <p v-if="state.personalEndpoint.state === 'action_required'" class="hint">
      This profile needs its release-configured relay address before it can host a personal route. No device was enrolled yet.
    </p>
    <p v-if="notice">{{ notice }}</p>
    <p v-if="browserError" class="error">{{ browserError }}</p>
    <div class="row">
      <button
        class="primary"
        :disabled="busy || state.account.state !== 'authenticated' || state.personalEndpoint.state === 'connected'"
        @click="enroll"
      >{{ state.personalEndpoint.state === 'connected' ? 'Personal space ready' : 'Set up this device as your personal space' }}</button>
      <button class="plain" :disabled="busy || !state.personalEndpoint.canCreatePairingInvite" @click="createInvite">Create device pairing invite</button>
    </div>
    <div v-if="inviteText" class="invite">
      <h3>One-time pairing invite</h3>
      <p>Open Pair New Device on your second Meshrix installation and paste this invite there. Anyone who obtains it before it expires may attempt to pair.</p>
      <textarea readonly rows="4" :value="inviteText" />
      <button class="plain" @click="copyInvite">{{ copied ? 'Copied' : 'Copy invite' }}</button>
    </div>
  </section>
</template>

<style scoped>
.endpoint { display: flex; align-items: center; gap: 0.7rem; flex-wrap: wrap; }
.invite { margin-top: 1rem; border-top: 1px solid #8885; padding-top: 0.5rem; }
.invite textarea { width: 100%; box-sizing: border-box; margin: 0.5rem 0; }
.hint { font-size: 0.85rem; opacity: 0.75; }
</style>
