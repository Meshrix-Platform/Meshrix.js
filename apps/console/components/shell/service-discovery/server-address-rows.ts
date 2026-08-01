import type { ServerAddressRow, ServerAddressValidationStatus } from "./types";

let serverAddressRowSequence: any = 0;

export function createServerAddressRow(
  url: any = "",
  validationStatus: ServerAddressValidationStatus = "idle",
  validationMessage: any = "",
): ServerAddressRow {
  serverAddressRowSequence += 1;
  return {
    id: `server-address-${Date.now()}-${serverAddressRowSequence}`,
    url,
    validationStatus,
    validationMessage,
  };
}
