import { readonly, ref } from "vue";
import { getApiKeyIssuerScopes } from "../lib/api-key-distribution-client";

const eligible = ref(false);
const loaded = ref(false);
let pending: Promise<boolean> | null = null;
let availabilityRevision = 0;
let pendingRevision = -1;

export function setApiKeyDistributionAvailability(value: boolean): void {
  availabilityRevision += 1;
  eligible.value = value;
  loaded.value = true;
}

export async function loadApiKeyDistributionAvailability(): Promise<boolean> {
  if (!pending || pendingRevision !== availabilityRevision) {
    const requestRevision = availabilityRevision;
    const request = getApiKeyIssuerScopes()
      .then((result) => {
        const visibleNodes = result.eligibleNodes?.length || result.eligibleRoots?.length || 0;
        if (requestRevision === availabilityRevision) {
          eligible.value = visibleNodes > 0;
          loaded.value = true;
        }
        return eligible.value;
      })
      .catch(() => {
        if (requestRevision === availabilityRevision) {
          eligible.value = false;
          loaded.value = true;
        }
        return false;
      })
      .finally(() => {
        if (pending === request) pending = null;
      });
    pending = request;
    pendingRevision = requestRevision;
  }
  return pending;
}

export function useApiKeyDistributionAvailability() {
  return {
    eligible: readonly(eligible),
    loaded: readonly(loaded),
    load: loadApiKeyDistributionAvailability,
  };
}
