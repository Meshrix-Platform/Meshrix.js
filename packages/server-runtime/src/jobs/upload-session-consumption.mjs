export const UPLOAD_SESSION_CONSUMPTION_SCHEMA_VERSION =
  "v0.0.1:jobs:upload-session-consumption-1";

function nonNegativeInteger(value) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : 0;
}

export function createUploadSessionConsumption({
  expectedFileCount = 0,
  persistedFileCount = 0
} = {}) {
  const expected = nonNegativeInteger(expectedFileCount);
  const persisted = nonNegativeInteger(persistedFileCount);
  return Object.freeze({
    schemaVersion: UPLOAD_SESSION_CONSUMPTION_SCHEMA_VERSION,
    status: expected === persisted ? "persisted" : "incomplete",
    complete: expected === persisted,
    expectedFileCount: expected,
    persistedFileCount: persisted
  });
}

export function uploadSessionConsumptionComplete(value = null) {
  return Boolean(
    value &&
    value.schemaVersion === UPLOAD_SESSION_CONSUMPTION_SCHEMA_VERSION &&
    value.status === "persisted" &&
    value.complete === true &&
    Number.isSafeInteger(value.expectedFileCount) &&
    value.expectedFileCount >= 0 &&
    value.persistedFileCount === value.expectedFileCount
  );
}
