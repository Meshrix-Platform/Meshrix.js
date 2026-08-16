function plain(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

export function assertProposal(proposal, policy) {
  if (!plain(proposal) || Object.keys(proposal).length !== 1 || !Array.isArray(proposal.operations)) {
    throw new Error("proposal_closed_schema_invalid");
  }
  if (proposal.operations.length === 0 || proposal.operations.length > policy.maxCalls) throw new Error("proposal_budget_exceeded");
  const allowedRunbook = new Set(policy.operationIds);
  const allowedOperations = new Set(policy.operationAllowlist);
  const allowedResources = new Set(policy.resourceAllowlist);
  const allowedWorkspaces = new Set(policy.workspaceSelectors);
  return Object.freeze(proposal.operations.map((operation) => {
    if (!plain(operation) || !Object.keys(operation).every((key) => ["operationId", "resourceRef", "workspaceId", "input"].includes(key)) ||
        !["operationId", "resourceRef", "workspaceId", "input"].every((key) => key in operation)) {
      throw new Error("proposal_operation_closed_schema_invalid");
    }
    if (!allowedRunbook.has(operation.operationId) || !allowedOperations.has(operation.operationId)) {
      throw new Error("proposal_operation_denied");
    }
    if (!allowedResources.has(operation.resourceRef) || !allowedWorkspaces.has(operation.workspaceId)) {
      throw new Error("proposal_resource_denied");
    }
    if (!plain(operation.input)) throw new Error("proposal_input_invalid");
    return Object.freeze(structuredClone(operation));
  }));
}
