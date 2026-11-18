#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createOrganizationGovernanceService } from "../../packages/foundation/src/security/authorization/organization-model.ts";
import { createTagManagementStore } from "../../packages/server-runtime/src/state/tag-management-store.ts";

const userDataPath: any = await fs.mkdtemp(path.join(os.tmpdir(), "meshrix-organization-governance-"));
try {
  const store: any = createTagManagementStore({ userDataPath });
  try {
    const service: any = createOrganizationGovernanceService({ tagManagementStore: store });
    const empty: any = service.getOrganizationGovernance();
    assert.equal(empty.configured, false);
    assert.equal(empty.revision, 0);
    assert.deepEqual(empty.tags, []);
    assert.deepEqual(empty.roles, []);
    const catalog: any = service.listOrganizationGovernanceTemplates();
    assert.equal(catalog.some((entry?: any) : any => entry.templateKey === "enterprise-group"), true);
    const draft: any = service.importOrganizationGovernance({ templateKey: "enterprise-group" });
    const preview: any = service.previewOrganizationGovernance(draft);
    assert.equal(preview.organizationDepth, 2);
    assert.deepEqual(service.getOrganizationGovernance(), empty);
    assert.equal(preview.roles.every((role?: any) : any =>
      role.businessResourceActions.length === 0 && role.assignedSubjectIds.length === 0), true);
    const published: any = service.publishOrganizationGovernance({ ...draft, expectedRevision: 0 });
    assert.equal(published.revision, 1);
    assert.deepEqual(published.nodes, preview.nodes);
    assert.deepEqual(published.tags, [...preview.tags].sort((a?: any, b?: any) : any => a.tagId.localeCompare(b.tagId)));
    assert.throws(
      () : any => service.publishOrganizationGovernance({ ...draft, expectedRevision: 0 }),
      (error?: any) : any => error?.code === "organization_governance_revision_conflict" && error?.currentRevision === 1
    );
  } finally { store.close(); }
  console.log("organization governance model verifier passed");
} finally {
  await fs.rm(userDataPath, { recursive: true, force: true });
}
