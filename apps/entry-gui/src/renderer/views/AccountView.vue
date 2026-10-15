<script setup lang="ts">
import type { GuiState } from "../../shared/gui-state.ts";
import { openAccountPage } from "../bridge.ts";
import { runOp } from "../store.ts";
import { ref } from "vue";

defineProps<{ state: GuiState }>();
const browserError = ref<string | null>(null);

async function safeOpen(transactionId?: string | null): Promise<void> {
  browserError.value = null;
  try {
    await openAccountPage(transactionId);
  } catch (error) {
    browserError.value = error instanceof Error ? error.message : "Could not open the account browser.";
  }
}

async function beginLogin(): Promise<void> {
  const result = await runOp<GuiState>("account.beginLogin");
  if (result?.account.transactionId) await safeOpen(result.account.transactionId);
}

async function checkTransaction(): Promise<void> {
  await runOp("account.checkTransaction");
}

async function openSettings(): Promise<void> {
  await safeOpen();
}
</script>

<template>
  <section class="card">
    <h2>Account and authentication</h2>
    <p v-if="state.account.state === 'unconfigured'" class="error">
      Account sign-in is unavailable until the operator configures the stable HTTPS account origin.
    </p>
    <p v-else-if="!state.account.custodyAvailable" class="error">
      Account sessions require the platform OS key store; this device cannot retain an account session safely.
    </p>
    <p v-else>
      {{ state.account.state === 'authenticated' ? 'Signed in' : state.account.state === 'transaction_pending' ? 'A browser transaction is waiting' : 'Signed out' }}
      <span v-if="state.account.accountId" class="mono"> — {{ state.account.accountId }}</span>
    </p>
    <p v-if="state.account.notice">{{ state.account.notice }}</p>
    <p v-if="state.account.transactionPurpose === 'step_up'">
      The browser transaction approves one exact {{ state.account.actionPurpose }} action. It does not grant general device access.
    </p>
    <div class="row">
      <button
        v-if="state.account.state === 'signed_out' || state.account.state === 'unconfigured' || state.account.state === 'authenticated'"
        class="primary"
        :disabled="!state.account.originAvailable || !state.account.custodyAvailable"
        @click="beginLogin"
      >{{ state.account.state === 'authenticated' ? 'Refresh account session' : 'Sign in or create account' }}</button>
      <button v-if="state.account.transactionId" class="plain" @click="safeOpen(state.account.transactionId)">Open transaction in browser</button>
      <button v-if="state.account.transactionId" class="primary" @click="checkTransaction">Check transaction</button>
      <button v-if="state.account.state === 'authenticated'" class="plain" :disabled="!state.account.originAvailable" @click="openSettings">Manage factors and linked accounts</button>
      <button v-if="state.account.state === 'authenticated'" class="danger" @click="runOp('account.signOut')">Sign out on this device</button>
    </div>
    <p v-if="browserError" class="error">{{ browserError }}</p>
    <p class="hint">
      Passkeys, password plus authenticator, linked Google, GitHub and Apple sign-in, recovery and recovery-code replacement are managed on the hosted account page.
      Mail delivery quota affects new email delivery only; existing factor sign-in remains available.
    </p>
  </section>
</template>

<style scoped>
.hint { font-size: 0.85rem; opacity: 0.75; }
</style>
