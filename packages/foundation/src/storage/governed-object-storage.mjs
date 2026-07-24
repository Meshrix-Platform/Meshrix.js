const BYTE_STORE_OPERATIONS = Object.freeze([
  "putObject",
  "putObjectsFromFiles",
  "getObject",
  "readObject",
  "statObject",
  "resolveStoredObjectPath",
]);

const OWNERSHIP_OPERATIONS = Object.freeze([
  "findObjectOwner",
  "listObjectStoragePathsByOwner",
  "deleteObjectRecordsByOwner",
  "getDeletionOperationByOwnerId",
  "upsertDeletionOperation",
  "updateDeletionOperation",
  "deleteDeletionOperation",
  "listPendingDeletionOperations",
]);

export const GOVERNED_OBJECT_STORAGE_DISCIPLINE = Object.freeze({
  id: "governed-object-storage",
  byteStore: Object.freeze({
    capabilityId: "object-store",
    kind: "blob-store",
    operations: BYTE_STORE_OPERATIONS,
  }),
  ownershipAuthority: Object.freeze({
    capabilityId: "storage-object-ownership",
    kind: "metadata",
    operations: OWNERSHIP_OPERATIONS,
  }),
  separation: Object.freeze({
    sharedObjectBytes: "object-store",
    ownershipRecords: "storage-object-ownership",
    ownershipMutationViaByteStore: "forbidden",
  }),
});

function capabilityById(capabilities, capabilityId) {
  return capabilities.find((entry) => entry?.id === capabilityId) ?? null;
}

function operationsMatch(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    expected.every((operation, index) => actual[index] === operation);
}

export function assertGovernedObjectStorageCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw new Error("Governed object storage capabilities must be an array.");
  }
  const byteStore = capabilityById(capabilities, GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.capabilityId);
  const ownership = capabilityById(
    capabilities,
    GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.capabilityId,
  );
  if (!byteStore || byteStore.kind !== GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.kind) {
    throw new Error("Shared object bytes must remain behind the governed object-store capability.");
  }
  if (!ownership || ownership.kind !== GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.kind) {
    throw new Error("Object ownership authority must remain in governed metadata capabilities.");
  }
  if (!operationsMatch(byteStore.operations, GOVERNED_OBJECT_STORAGE_DISCIPLINE.byteStore.operations)) {
    throw new Error("Governed object-store operations changed without updating the byte-store contract.");
  }
  if (!operationsMatch(ownership.operations, GOVERNED_OBJECT_STORAGE_DISCIPLINE.ownershipAuthority.operations)) {
    throw new Error("Governed ownership operations changed without updating the ownership contract.");
  }
  return true;
}
