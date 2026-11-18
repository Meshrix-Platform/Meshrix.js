export type ServerAddressValidationStatus = "idle" | "checking" | "available" | "unavailable";

export type ServerAddressRow = {
  id: string;
  url: string;
  validationStatus: ServerAddressValidationStatus;
  validationMessage: string;
};
