/**
 * Static embedding of the Operation Permission entity config. The Node loader
 * originally scanned this directory at module load; bundling the JSON keeps
 * the catalog identical under workerd.
 */

import scopes_0 from "@meshrix/foundation/config/entity-config/tools/scopes/agent_sync-publish.json" with { type: "json" };
import scopes_1 from "@meshrix/foundation/config/entity-config/tools/scopes/auth-admin.json" with { type: "json" };
import scopes_2 from "@meshrix/foundation/config/entity-config/tools/scopes/console-read.json" with { type: "json" };
import scopes_3 from "@meshrix/foundation/config/entity-config/tools/scopes/gateway-admin.json" with { type: "json" };
import scopes_4 from "@meshrix/foundation/config/entity-config/tools/scopes/gateway-maintain.json" with { type: "json" };
import scopes_5 from "@meshrix/foundation/config/entity-config/tools/scopes/gateway-read.json" with { type: "json" };
import scopes_6 from "@meshrix/foundation/config/entity-config/tools/scopes/gateway-write.json" with { type: "json" };
import scopes_7 from "@meshrix/foundation/config/entity-config/tools/scopes/jobs-read.json" with { type: "json" };
import scopes_8 from "@meshrix/foundation/config/entity-config/tools/scopes/jobs-write.json" with { type: "json" };
import scopes_9 from "@meshrix/foundation/config/entity-config/tools/scopes/maintenance-admin.json" with { type: "json" };
import scopes_10 from "@meshrix/foundation/config/entity-config/tools/scopes/maintenance-approve.json" with { type: "json" };
import scopes_11 from "@meshrix/foundation/config/entity-config/tools/scopes/maintenance-read.json" with { type: "json" };
import scopes_12 from "@meshrix/foundation/config/entity-config/tools/scopes/maintenance-run.json" with { type: "json" };
import scopes_13 from "@meshrix/foundation/config/entity-config/tools/scopes/model-call.json" with { type: "json" };
import scopes_14 from "@meshrix/foundation/config/entity-config/tools/scopes/recording-admin.json" with { type: "json" };
import scopes_15 from "@meshrix/foundation/config/entity-config/tools/scopes/recording-read.json" with { type: "json" };
import scopes_16 from "@meshrix/foundation/config/entity-config/tools/scopes/repo-approve.json" with { type: "json" };
import scopes_17 from "@meshrix/foundation/config/entity-config/tools/scopes/repo-maintain.json" with { type: "json" };
import scopes_18 from "@meshrix/foundation/config/entity-config/tools/scopes/repo-read.json" with { type: "json" };
import scopes_19 from "@meshrix/foundation/config/entity-config/tools/scopes/repo-review.json" with { type: "json" };
import scopes_20 from "@meshrix/foundation/config/entity-config/tools/scopes/repo-write.json" with { type: "json" };
import scopes_21 from "@meshrix/foundation/config/entity-config/tools/scopes/runtime-admin.json" with { type: "json" };
import scopes_22 from "@meshrix/foundation/config/entity-config/tools/scopes/storage-read.json" with { type: "json" };
import scopes_23 from "@meshrix/foundation/config/entity-config/tools/scopes/storage-write.json" with { type: "json" };
import scopes_24 from "@meshrix/foundation/config/entity-config/tools/scopes/uploads-write.json" with { type: "json" };
import scopes_25 from "@meshrix/foundation/config/entity-config/tools/scopes/workspace-maintain.json" with { type: "json" };
import scopes_26 from "@meshrix/foundation/config/entity-config/tools/scopes/workspace-read.json" with { type: "json" };
import scopes_27 from "@meshrix/foundation/config/entity-config/tools/scopes/workspace-write.json" with { type: "json" };

import toolsets_0 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.admin.json" with { type: "json" };
import toolsets_1 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.agent.sync.publish.json" with { type: "json" };
import toolsets_2 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.agent.workspace.json" with { type: "json" };
import toolsets_3 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.agent.workspace.maintain.json" with { type: "json" };
import toolsets_4 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.agent.workspace.read.json" with { type: "json" };
import toolsets_5 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.authorization.admin.json" with { type: "json" };
import toolsets_6 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.console.read.json" with { type: "json" };
import toolsets_7 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.gateway.admin.json" with { type: "json" };
import toolsets_8 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.gateway.maintain.json" with { type: "json" };
import toolsets_9 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.gateway.read.json" with { type: "json" };
import toolsets_10 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.gateway.write.json" with { type: "json" };
import toolsets_11 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.jobs.read.json" with { type: "json" };
import toolsets_12 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.jobs.write.json" with { type: "json" };
import toolsets_13 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.maintenance.maintain.json" with { type: "json" };
import toolsets_14 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.maintenance.read.json" with { type: "json" };
import toolsets_15 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.maintenance.run.json" with { type: "json" };
import toolsets_16 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.model.call.json" with { type: "json" };
import toolsets_17 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.mount.dev.json" with { type: "json" };
import toolsets_18 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.result.export.json" with { type: "json" };
import toolsets_19 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.runtime.maintain.json" with { type: "json" };
import toolsets_20 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.runtime.read.json" with { type: "json" };
import toolsets_21 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.storage.read.json" with { type: "json" };
import toolsets_22 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.storage.write.json" with { type: "json" };
import toolsets_23 from "@meshrix/foundation/config/entity-config/tools/toolsets/meshrix.uploads.write.json" with { type: "json" };

import profiles_0 from "@meshrix/foundation/config/entity-config/tools/profiles/admin-operator.json" with { type: "json" };

const SCOPES: readonly Record<string, unknown>[] = [
  scopes_0 as Record<string, unknown>,
  scopes_1 as Record<string, unknown>,
  scopes_2 as Record<string, unknown>,
  scopes_3 as Record<string, unknown>,
  scopes_4 as Record<string, unknown>,
  scopes_5 as Record<string, unknown>,
  scopes_6 as Record<string, unknown>,
  scopes_7 as Record<string, unknown>,
  scopes_8 as Record<string, unknown>,
  scopes_9 as Record<string, unknown>,
  scopes_10 as Record<string, unknown>,
  scopes_11 as Record<string, unknown>,
  scopes_12 as Record<string, unknown>,
  scopes_13 as Record<string, unknown>,
  scopes_14 as Record<string, unknown>,
  scopes_15 as Record<string, unknown>,
  scopes_16 as Record<string, unknown>,
  scopes_17 as Record<string, unknown>,
  scopes_18 as Record<string, unknown>,
  scopes_19 as Record<string, unknown>,
  scopes_20 as Record<string, unknown>,
  scopes_21 as Record<string, unknown>,
  scopes_22 as Record<string, unknown>,
  scopes_23 as Record<string, unknown>,
  scopes_24 as Record<string, unknown>,
  scopes_25 as Record<string, unknown>,
  scopes_26 as Record<string, unknown>,
  scopes_27 as Record<string, unknown>,
];

const TOOLSETS: readonly Record<string, unknown>[] = [
  toolsets_0 as Record<string, unknown>,
  toolsets_1 as Record<string, unknown>,
  toolsets_2 as Record<string, unknown>,
  toolsets_3 as Record<string, unknown>,
  toolsets_4 as Record<string, unknown>,
  toolsets_5 as Record<string, unknown>,
  toolsets_6 as Record<string, unknown>,
  toolsets_7 as Record<string, unknown>,
  toolsets_8 as Record<string, unknown>,
  toolsets_9 as Record<string, unknown>,
  toolsets_10 as Record<string, unknown>,
  toolsets_11 as Record<string, unknown>,
  toolsets_12 as Record<string, unknown>,
  toolsets_13 as Record<string, unknown>,
  toolsets_14 as Record<string, unknown>,
  toolsets_15 as Record<string, unknown>,
  toolsets_16 as Record<string, unknown>,
  toolsets_17 as Record<string, unknown>,
  toolsets_18 as Record<string, unknown>,
  toolsets_19 as Record<string, unknown>,
  toolsets_20 as Record<string, unknown>,
  toolsets_21 as Record<string, unknown>,
  toolsets_22 as Record<string, unknown>,
  toolsets_23 as Record<string, unknown>,
];

const PROFILES: readonly Record<string, unknown>[] = [
  profiles_0 as Record<string, unknown>,
];

export const ENTITY_CONFIG = Object.freeze({
  scopes: Object.freeze([...SCOPES]),
  toolsets: Object.freeze([...TOOLSETS]),
  profiles: Object.freeze([...PROFILES]),
} as const);
