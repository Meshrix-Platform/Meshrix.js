<script setup lang="ts">
import { ref } from "vue";

import type { GuiState } from "../../shared/gui-state.ts";
import { openAccountPage } from "../bridge.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();

const selectedScopes = ref<string[]>([]);
const browserError = ref<string | null>(null);

async function loadCatalog(connectionId: string): Promise<void> {
  selectedScopes.value = [];
  await runOp("connection.grantCatalog", { connectionId });
}

async function requestGrant(connectionId: string): Promise<void> {
  const result = await runOp<GuiState>("connection.grantAccess", {
    connectionId,
    scopes: [...selectedScopes.value]
  });
  if (result?.account.transactionPurpose === "step_up" && result.account.transactionId) {
    await openTransaction(result.account.transactionId);
  }
}

async function openTransaction(transactionId: string): Promise<void> {
  browserError.value = null;
  try {
    await openAccountPage(transactionId);
  } catch (error) {
    browserError.value = error instanceof Error ? error.message : "Could not open the account browser.";
  }
}

function revokeLabel(connection: GuiState["connections"][number]): string {
  if (connection.revocation === "authority_pending") return "Retry device revoke";
  if (connection.revocation === "enforcement_pending") return "Check relay enforcement";
  return connection.mode === "personal" && connection.endpointDeviceId ? "Revoke this device" : "Disable connection";
}
</script>

<template>
  <section class="card">
    <h2>Connections</h2>
    <p v-if="!state.connections.length">
      No endpoints paired yet. Use <em>Pair New Endpoint</em> to enroll this device.
    </p>
    <article v-for="connection in state.connections" :key="connection.connectionId" class="card">
      <h3>
        {{ connection.displayLabel }}
        <span class="badge" :class="connection.routeState">{{ connection.routeState }}</span>
        <span v-if="connection.channelEstablished" class="badge reachable">channel pinned</span>
        <span v-if="connection.rePairRequired" class="badge refused">re-pair required</span>
      </h3>
      <dl>
        <dt>Decrypting party</dt><dd class="mono">{{ connection.endpointPrincipalRef }}</dd>
        <dt>Endpoint device</dt><dd class="mono">{{ connection.endpointDeviceId ?? 'unbound legacy connection' }}</dd>
        <dt>Endpoint key pin</dt><dd class="mono">{{ connection.endpointSpkiPin }}</dd>
        <dt>This device</dt><dd class="mono">{{ connection.deviceId }} ({{ connection.deviceFingerprint }})</dd>
        <dt>Route / tenant</dt><dd class="mono">{{ connection.routeId }} / {{ connection.tenantId }}</dd>
        <dt>Capability grant</dt><dd class="mono">{{ connection.capabilityGrantRef }}</dd>
        <dt v-if="connection.boundRecoveryKeyId">Bound recovery key</dt>
        <dd v-if="connection.boundRecoveryKeyId" class="mono">{{ connection.boundRecoveryKeyId }}</dd>
        <dt v-if="connection.revocation !== 'none'">Revocation</dt>
        <dd v-if="connection.revocation !== 'none'">{{ connection.revocation }}</dd>
      </dl>
      <div class="row">
        <button class="plain" :disabled="connection.rePairRequired" @click="runOp('connection.refresh', { connectionId: connection.connectionId })">Reconnect</button>
        <button class="plain" :disabled="connection.routeState === 'unreachable' && !connection.channelEstablished" @click="runOp('connection.disconnect', { connectionId: connection.connectionId })">Disconnect</button>
        <button class="plain" :disabled="connection.rePairRequired || !connection.endpointDeviceId" @click="loadCatalog(connection.connectionId)">Manage access</button>
        <button v-if="connection.mode === 'personal' && connection.endpointDeviceId" class="danger" :disabled="connection.revocation === 'remote_applied'" @click="runOp('connection.revoke', { connectionId: connection.connectionId, remote: true })">
          {{ revokeLabel(connection) }}
        </button>
        <button v-else class="danger" :disabled="connection.rePairRequired" @click="runOp('connection.revoke', { connectionId: connection.connectionId, remote: true })">
          Disable connection
        </button>
      </div>
      <div v-if="state.grant.connectionId === connection.connectionId" class="grant-box">
        <p v-if="state.grant.status === 'catalog_ready'">Choose the exact endpoint scopes to add. A fresh Passkey or authenticator approval is required.</p>
        <fieldset v-if="state.grant.status === 'catalog_ready'">
          <legend>Available endpoint scopes</legend>
          <label v-for="scope in state.grant.availableScopes" :key="scope" class="scope">
            <input v-model="selectedScopes" type="checkbox" :value="scope" />
            <span class="mono">{{ scope }}</span>
          </label>
          <button class="primary" :disabled="!selectedScopes.length" @click="requestGrant(connection.connectionId)">Authorize selected scopes</button>
        </fieldset>
        <p v-else-if="state.grant.status === 'authorization_required'">
          Pending exact target: <span class="mono">{{ state.grant.targetScopes.join(', ') }}</span>
          <span v-if="state.grant.grantRef"> ({{ state.grant.grantRef }})</span>
          <div class="row">
            <button v-if="state.account.transactionId" class="plain" @click="openTransaction(state.account.transactionId)">Open approval</button>
            <button v-if="state.account.transactionId" class="primary" @click="runOp('account.checkTransaction')">Check approval</button>
          </div>
        </p>
        <p v-else-if="state.grant.status === 'granted'">{{ state.grant.notice }}</p>
        <p v-if="state.grant.notice && state.grant.status !== 'granted'">{{ state.grant.notice }}</p>
        <p v-if="browserError" class="error">{{ browserError }}</p>
      </div>
      <p class="hint">
        Disconnecting only closes the live route. Revocation disables new use after its exact
        authority receipt; pairing records, cryptographic stores and accepted task history remain
        available for review or recovery.
      </p>
    </article>
  </section>
</template>

<style scoped>
dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.2rem 0.75rem; font-size: 0.85rem; }
dt { opacity: 0.7; }
dd { margin: 0; }
.hint { font-size: 0.78rem; opacity: 0.75; }
.grant-box { border-top: 1px solid #8885; margin-top: 0.8rem; padding-top: 0.5rem; }
fieldset { border: 1px solid #8885; border-radius: 0.4rem; }
.scope { display: flex; gap: 0.5rem; margin: 0.4rem 0; }
</style>
