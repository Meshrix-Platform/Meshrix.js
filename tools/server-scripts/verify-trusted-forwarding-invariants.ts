#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  assertConsumedGovernedExecutionPermit,
  consumeGovernedExecutionPermit,
  mintGovernedExecutionPermit
} from "../../packages/foundation/src/security/governed-execution-permit-authority.ts";

const source: any = async (path?: any) : Promise<any> => fs.readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const dispatcher: any = await source("packages/server-runtime/src/composition/dispatch-operation-core.ts");
const dispatcherInput: any = await source("packages/server-runtime/src/composition/dispatch-operation-input.ts");
const proofLifecycle: any = await source("packages/server-runtime/src/composition/dispatch-operation-proof-lifecycle.ts");
const proxy: any = await source("apps/server/runtime/http-server-proxy.ts");
const payloadContract: any = await source("packages/agents/src/upstream-gateway/payload-contract.ts");
const authorizationStore: any = await source("packages/foundation/src/security/authorization/authorization-store.ts");
const operationPermissionRuntime: any = await source("packages/capabilities/src/operation-permission-core/runtime.ts");

assert.match(dispatcher, /mintGovernedExecutionPermit/u);
assert.match(dispatcherInput, /consumeGovernedExecutionPermit/u);
assert.match(dispatcher, /operation_outcome_in_doubt/u);
assert.match(proofLifecycle, /operation_proof_substrate_required/u);
assert.doesNotMatch(proxy, /headers\.(?:set|append)\(\s*["'](?:authorization|cookie|x-meshrix-tool-token)/iu);
assert.match(proxy, /["']location["']/u);
assert.match(payloadContract, /assertDeclaredSha256Digest/u);
assert.doesNotMatch(authorizationStore, /INSERT\s+OR\s+REPLACE\s+INTO\s+authorization_/iu);
assert.match(operationPermissionRuntime, /revalidateGrantForExecution/u);

const binding: Record<string, any> = {
  operationId: "verify.protected",
  audience: "verify-sink",
  principal: { type: "workload", subjectId: "verify-subject", generation: "1" },
  resource: { resourceId: "verify-resource" },
  requestDigest: "a".repeat(64)
};
const permit: any = mintGovernedExecutionPermit({
  ...binding,
  proofRef: "verify-proof",
  authorization: { revision: 1 },
  approval: {},
  risk: { class: "safe_write" }
});
const receipt: any = consumeGovernedExecutionPermit(permit, binding);
assert.equal(assertConsumedGovernedExecutionPermit(receipt, binding), receipt);
assert.throws(
  () : any => consumeGovernedExecutionPermit(permit, binding),
  (error?: any) : any => error?.code === "governed_execution_permit_unknown_or_replayed"
);

console.log("[trusted-forwarding] focused invariants ok");
