<script setup lang="ts">
import type { GuiState } from "../../shared/gui-state.ts";
import { runOp } from "../store.ts";

defineProps<{ state: GuiState }>();
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
      </h3>
      <dl>
        <dt>Decrypting party</dt><dd class="mono">{{ connection.endpointPrincipalRef }}</dd>
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
        <button class="plain" @click="runOp('connection.refresh', { connectionId: connection.connectionId })">Reconnect</button>
        <button class="danger" @click="runOp('connection.revoke', { connectionId: connection.connectionId, remote: true })">
          Revoke &amp; remove
        </button>
      </div>
      <p class="hint">
        Revocation deletes this entry's device key and relay credential plus this app's own
        configuration for the connection. Remote enforcement is reported honestly as pending
        until the endpoint authority confirms it.
      </p>
    </article>
  </section>
</template>

<style scoped>
dl { display: grid; grid-template-columns: 12rem 1fr; gap: 0.2rem 0.75rem; font-size: 0.85rem; }
dt { opacity: 0.7; }
dd { margin: 0; }
.hint { font-size: 0.78rem; opacity: 0.75; }
</style>
