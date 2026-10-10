<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const inviteText = ref("");
const pairingService = ref("");
const busy = ref(false);

async function submit(): Promise<void> {
  busy.value = true;
  try {
    await runOp("pairing.submitInvite", {
      inviteText: inviteText.value.trim(),
      ...(pairingService.value.trim() ? { pairingService: pairingService.value.trim() } : {})
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="card">
    <h2>Pair a new endpoint</h2>
    <p>
      Paste the invite from your endpoint admin (<code class="mono">meshrix-entry://pair#…</code>,
      QR payload or deep link). The endpoint's identity and expiry are shown for explicit
      confirmation before this device enrolls.
    </p>
    <label class="field">
      Pairing invite
      <textarea v-model="inviteText" rows="3" placeholder="meshrix-entry://pair#…" />
    </label>
    <label class="field">
      Endpoint service address (optional — defaults to the invite's relay host)
      <input v-model="pairingService" placeholder="https://endpoint.example" />
    </label>
    <div class="row">
      <button class="primary" :disabled="busy || !inviteText.trim()" @click="submit">Review invite</button>
      <button class="plain" @click="runOp('pairing.reset')">Reset</button>
    </div>
  </section>

  <section v-if="state.pairing.invite" class="card">
    <h3>Invite details</h3>
    <dl>
      <dt>Endpoint route</dt><dd class="mono">{{ state.pairing.invite.endpointRouteId }}</dd>
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
      matches the one your endpoint admin shows, then confirm enrollment.
    </p>
    <p class="mono">{{ state.pairing.deviceFingerprint }}</p>
    <div class="row">
      <button class="primary" @click="runOp('pairing.confirm')">Confirm — enroll this device</button>
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
      <button class="primary" @click="runOp('pairing.confirm')">Retry proof</button>
    </p>
  </section>
</template>
