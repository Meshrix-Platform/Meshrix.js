import type { ServerAddressRow, ServerAddressValidationStatus } from "./types";

let serverAddressRowSequence = 0;

export function createServerAddressRow(
  url = "",
  validationStatus: ServerAddressValidationStatus = "idle",
  validationMessage = "",
): ServerAddressRow {
  serverAddressRowSequence += 1;
  return {
    id: `server-address-${Date.now()}-${serverAddressRowSequence}`,
    url,
    validationStatus,
    validationMessage,
  };
}
