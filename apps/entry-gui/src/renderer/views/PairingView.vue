<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import { openAccountPage } from "../bridge.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const inviteText = ref("");
const busy = ref(false);
const browserError = ref<string | null>(null);

async function openTransaction(transactionId: string | null): Promise<void> {
  if (!transactionId) return;
  try {
    await openAccountPage(transactionId);
  } catch (error) {
    browserError.value = error instanceof Error ? error.message : "Could not open the account browser.";
  }
}

async function submit(): Promise<void> {
  busy.value = true;
  try {
    const result = await runOp<GuiState>("pairing.submitInvite", { inviteText: inviteText.value.trim() });
    if (result?.account.transactionPurpose === "login") await openTransaction(result.account.transactionId);
  } finally {
    busy.value = false;
  }
}

async function confirm(): Promise<void> {
  const result = await runOp<GuiState>("pairing.confirm");
  if (result?.account.transactionPurpose === "step_up") await openTransaction(result.account.transactionId);
}

async function continuePairing(): Promise<void> {
  const result = await runOp<GuiState>("pairing.continue");
  if (result?.account.transactionId) await openTransaction(result.account.transactionId);
}
</script>

<template>
  <section class="card">
    <h2>Pair a new endpoint</h2>
    <p>
      Paste the one-time invite created in the first Meshrix client's Personal space
      (<code class="mono">meshrix-entry://pair#…</code>, QR payload or deep link). The endpoint's identity and expiry are shown for explicit
      confirmation before this device enrolls.
    </p>
    <label class="field">
      Pairing invite
      <textarea v-model="inviteText" rows="3" placeholder="meshrix-entry://pair#…" />
    </label>
    <div class="row">
      <button class="primary" :disabled="busy || !inviteText.trim()" @click="submit">Review invite</button>
      <button class="plain" @click="runOp('pairing.reset')">Reset</button>
    </div>
    <p v-if="browserError" class="error">{{ browserError }}</p>
  </section>

  <section v-if="state.pairing.invite" class="card">
    <h3>Invite details</h3>
    <dl>
      <dt>Endpoint route</dt><dd class="mono">{{ state.pairing.invite.endpointRouteId }}</dd>
      <dt>Endpoint device</dt><dd class="mono">{{ state.pairing.invite.endpointDeviceId }}</dd>
      <dt>Decrypting party (endpoint principal)</dt><dd class="mono">{{ state.pairing.invite.endpointPrincipalRef }}</dd>
      <dt>Endpoint key pin (SPKI)</dt><dd class="mono">{{ state.pairing.invite.endpointSpkiPin }}</dd>
      <dt>Tenant / mode</dt><dd class="mono">{{ state.pairing.invite.tenantId }} / {{ state.pairing.invite.mode }}</dd>
      <dt>Vault</dt><dd class="mono">{{ state.pairing.invite.vaultId }}</dd>
      <dt>Expires</dt><dd class="mono">{{ state.pairing.invite.expiresAt }}</dd>
    </dl>
  </section>

  <section v-if="state.pairing.phase === 'challenge_issued'" class="card">
    <h3>Confirm this device's fingerprint</h3>
    <p>
      A fresh device key was minted into this device's custody. Verify the fingerprint below
      matches the one shown in the first Meshrix client's pairing flow, then confirm enrollment.
    </p>
    <p class="mono">{{ state.pairing.deviceFingerprint }}</p>
    <div class="row">
      <button class="primary" @click="confirm">Confirm — authorize and enroll this device</button>
      <button class="plain" @click="runOp('pairing.cancel')">Cancel</button>
    </div>
  </section>

  <section v-else-if="state.pairing.phase !== 'idle' && state.pairing.phase !== 'invite_ready'" class="card">
    <h3>Pairing status</h3>
    <p>
      <span class="badge" :class="state.pairing.phase">{{ state.pairing.phase }}</span>
      <span v-if="state.pairing.refusal"> — {{ state.pairing.refusal }}</span>
    </p>
    <p v-if="state.pairing.phase === 'offline'">
      The endpoint surface was unreachable. Nothing was enrolled; retry when it is reachable.
    </p>
    <p v-else-if="state.pairing.phase === 'retry_required'">
      The proof may have reached the endpoint — its state is uncertain. Confirm again to retry
      the submission safely.
      <button class="primary" @click="confirm">Retry proof</button>
    </p>
    <p v-if="state.pairing.phase === 'authorization_required' || state.account.transactionPurpose === 'step_up'">
      Approve this exact device and endpoint action in the system browser, then check the result.
      <div class="row">
        <button class="plain" @click="openTransaction(state.account.transactionId)">Open account approval</button>
        <button class="primary" @click="continuePairing">Check approval</button>
      </div>
    </p>
    <p v-else-if="state.account.transactionPurpose === 'login'">
      Sign in or activate your email account in the system browser before pairing.
      <div class="row">
        <button class="plain" @click="openTransaction(state.account.transactionId)">Open account</button>
        <button class="primary" @click="continuePairing">Check sign-in</button>
      </div>
    </p>
    <p v-if="browserError" class="error">{{ browserError }}</p>
  </section>
</template>
