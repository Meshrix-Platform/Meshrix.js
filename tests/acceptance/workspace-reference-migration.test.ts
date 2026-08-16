#!/usr/bin/env node
import assert from "node:assert/strict";

import {
  assertWorkspaceCollaborationResidue,
  assertWorkspaceReferenceMigration
} from "../../tools/server-scripts/verify-workspace-collaboration-migration.ts";

export async function assertWorkspaceReferenceMigrationAcceptance() : Promise<any> {
  const residue: any = assertWorkspaceCollaborationResidue();
  assert.equal(residue.residueAbsent, true);
  const assertion: any = await assertWorkspaceReferenceMigration();
  assert.equal(assertion.peersConverged, true);
  assert.equal(assertion.cleanTurnApplyCalls, 0);
  assert.equal(assertion.dirtyTurnChangeSets, 1);
  assert.equal(assertion.restoreAsNewChange, true);
  assert.equal(assertion.suggestionsDualWrite, false);
  assert.equal(assertion.capacityCertified, false);
  return assertion;
}

const executedDirectly: any = process.argv[1]
  && new URL(import.meta.url).pathname === process.argv[1];
if (executedDirectly) {
  await assertWorkspaceReferenceMigrationAcceptance();
}
