const STRING = Object.freeze({ type: "string", minLength: 1, maxLength: 512 });
const IDENTIFIER = Object.freeze({ type: "string", pattern: "^[A-Za-z0-9_.-]{1,128}$" });
const POSITIVE_INTEGER = Object.freeze({ type: "integer", minimum: 1 });
const PAGINATION_PROPERTIES = Object.freeze({
  page: Object.freeze({ type: "integer", minimum: 1, maximum: 10000 }),
  perPage: Object.freeze({ type: "integer", minimum: 1, maximum: 100 }),
  cursor: Object.freeze({ type: "string", minLength: 1, maxLength: 512 })
});
const REPOSITORY_PROPERTIES = Object.freeze({ owner: IDENTIFIER, repo: IDENTIFIER });
const IDEMPOTENCY_KEY = Object.freeze({ type: "string", pattern: "^[A-Za-z0-9_.:-]{8,256}$" });

function schema(required = [], properties = {}, { additionalProperties = false } = {}) {
  return Object.freeze({
    type: "object",
    required: Object.freeze([...required]),
    additionalProperties,
    properties: Object.freeze({ ...properties })
  });
}

const OPERATION_SPECS = Object.freeze([
  {
    category: "rest",
    id: "github.repository.get",
    method: "GET",
    path: "/api/coding-github/v1/repositories/:owner/:repo",
    label: "Read a GitHub repository",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo"], REPOSITORY_PROPERTIES)
  },
  {
    category: "rest",
    id: "github.repository.contents.get",
    method: "GET",
    path: "/api/coding-github/v1/repositories/:owner/:repo/contents",
    label: "Read GitHub repository contents",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "path"], {
      ...REPOSITORY_PROPERTIES,
      path: STRING,
      ref: STRING
    })
  },
  {
    category: "rest",
    id: "github.repository.compare",
    method: "GET",
    path: "/api/coding-github/v1/repositories/:owner/:repo/compare",
    label: "Compare GitHub repository refs",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "base", "head"], {
      ...REPOSITORY_PROPERTIES,
      base: STRING,
      head: STRING
    })
  },
  {
    category: "rest",
    id: "github.pullRequests.list",
    method: "GET",
    path: "/api/coding-github/v1/repositories/:owner/:repo/pull-requests",
    label: "List GitHub pull requests",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo"], {
      ...REPOSITORY_PROPERTIES,
      state: Object.freeze({ enum: ["open", "closed", "all"] }),
      base: STRING,
      head: STRING,
      ...PAGINATION_PROPERTIES
    })
  },
  {
    category: "rest",
    id: "github.pullRequests.createDraft",
    method: "POST",
    path: "/api/coding-github/v1/repositories/:owner/:repo/pull-requests/draft",
    label: "Create a draft GitHub pull request",
    scopes: ["repo:write"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "title", "head", "base", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      title: STRING,
      head: STRING,
      base: STRING,
      body: Object.freeze({ type: "string", maxLength: 65536 }),
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "rest",
    id: "github.pullRequests.review.create",
    method: "POST",
    path: "/api/coding-github/v1/repositories/:owner/:repo/pull-requests/:pullNumber/reviews",
    label: "Create a GitHub pull request review",
    scopes: ["repo:review"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "pullNumber", "event", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      pullNumber: POSITIVE_INTEGER,
      event: Object.freeze({ enum: ["COMMENT", "APPROVE", "REQUEST_CHANGES"] }),
      body: Object.freeze({ type: "string", maxLength: 65536 }),
      comments: Object.freeze({ type: "array", maxItems: 100, items: Object.freeze({ type: "object" }) }),
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "rest",
    id: "github.issues.comment.create",
    method: "POST",
    path: "/api/coding-github/v1/repositories/:owner/:repo/issues/:issueNumber/comments",
    label: "Create a GitHub issue comment",
    scopes: ["repo:review"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "issueNumber", "body", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      issueNumber: POSITIVE_INTEGER,
      body: Object.freeze({ type: "string", minLength: 1, maxLength: 65536 }),
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "rest",
    id: "github.actions.workflowRuns.list",
    method: "GET",
    path: "/api/coding-github/v1/repositories/:owner/:repo/actions/workflow-runs",
    label: "List GitHub Actions workflow runs",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo"], {
      ...REPOSITORY_PROPERTIES,
      branch: STRING,
      status: STRING,
      ...PAGINATION_PROPERTIES
    })
  },
  {
    category: "mcp",
    id: "github.mcp.tools.list",
    method: "GET",
    path: "/api/coding-github/v1/mcp/tools",
    label: "List GitHub MCP tools",
    scopes: ["repo:read"],
    inputSchema: schema([], {
      toolsets: Object.freeze({ type: "array", maxItems: 16, uniqueItems: true, items: IDENTIFIER }),
      ...PAGINATION_PROPERTIES
    })
  },
  {
    category: "mcp",
    id: "github.mcp.tools.call",
    method: "POST",
    path: "/api/coding-github/v1/mcp/tools/call",
    label: "Call a read-only GitHub MCP tool",
    scopes: ["repo:read"],
    inputSchema: schema(["toolName", "arguments"], {
      toolName: IDENTIFIER,
      arguments: Object.freeze({ type: "object", additionalProperties: true })
    })
  },
  {
    category: "codespace",
    id: "codespace.providers.manifest",
    method: "GET",
    path: "/api/coding-github/v1/codespace/providers/manifest",
    label: "Read the GitHub Codespace provider manifest",
    scopes: ["repo:read"],
    inputSchema: schema()
  },
  {
    category: "codespace",
    id: "codespace.repository.status",
    method: "GET",
    path: "/api/coding-github/v1/codespace/repository/status",
    label: "Read GitHub Codespace repository status",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "ref"], { ...REPOSITORY_PROPERTIES, ref: STRING })
  },
  {
    category: "codespace",
    id: "codespace.tree.list",
    method: "GET",
    path: "/api/coding-github/v1/codespace/tree",
    label: "List a GitHub Codespace tree",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "treeRef"], {
      ...REPOSITORY_PROPERTIES,
      treeRef: STRING,
      recursive: Object.freeze({ type: "boolean" })
    })
  },
  {
    category: "codespace",
    id: "codespace.file.read",
    method: "GET",
    path: "/api/coding-github/v1/codespace/file",
    label: "Read a GitHub Codespace file",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "path", "ref"], {
      ...REPOSITORY_PROPERTIES,
      path: STRING,
      ref: STRING
    })
  },
  {
    category: "codespace",
    id: "codespace.diff.read",
    method: "GET",
    path: "/api/coding-github/v1/codespace/diff",
    label: "Read a GitHub Codespace diff",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "base", "head"], {
      ...REPOSITORY_PROPERTIES,
      base: STRING,
      head: STRING
    })
  },
  {
    category: "codespace",
    id: "codespace.change.prepare",
    method: "POST",
    path: "/api/coding-github/v1/codespace/change/prepare",
    label: "Prepare a GitHub Codespace change",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "base", "changes"], {
      ...REPOSITORY_PROPERTIES,
      base: STRING,
      changes: Object.freeze({ type: "array", minItems: 1, maxItems: 100, items: Object.freeze({ type: "object" }) })
    })
  },
  {
    category: "codespace",
    id: "codespace.change.upload",
    method: "POST",
    path: "/api/coding-github/v1/codespace/change/upload",
    label: "Upload a prepared GitHub Codespace change",
    scopes: ["repo:write"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "preparedChangeRef", "head", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      preparedChangeRef: STRING,
      head: STRING,
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "codespace",
    id: "codespace.review.comment",
    method: "POST",
    path: "/api/coding-github/v1/codespace/review/comment",
    label: "Comment on a GitHub Codespace review",
    scopes: ["repo:review"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "pullNumber", "body", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      pullNumber: POSITIVE_INTEGER,
      body: Object.freeze({ type: "string", minLength: 1, maxLength: 65536 }),
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "codespace",
    id: "codespace.review.requestChanges",
    method: "POST",
    path: "/api/coding-github/v1/codespace/review/request-changes",
    label: "Request GitHub Codespace review changes",
    scopes: ["repo:review"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "pullNumber", "body", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      pullNumber: POSITIVE_INTEGER,
      body: Object.freeze({ type: "string", minLength: 1, maxLength: 65536 }),
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "codespace",
    id: "codespace.review.approve",
    method: "POST",
    path: "/api/coding-github/v1/codespace/review/approve",
    label: "Approve a GitHub Codespace review",
    scopes: ["repo:review"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "pullNumber", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      pullNumber: POSITIVE_INTEGER,
      body: Object.freeze({ type: "string", maxLength: 65536 }),
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "codespace",
    id: "codespace.review.status.sync",
    method: "GET",
    path: "/api/coding-github/v1/codespace/review/status",
    label: "Synchronize GitHub Codespace review status",
    scopes: ["repo:read"],
    inputSchema: schema(["owner", "repo", "pullNumber"], {
      ...REPOSITORY_PROPERTIES,
      pullNumber: POSITIVE_INTEGER
    })
  },
  {
    category: "skill-installer",
    id: "github.skills.install.plan",
    method: "POST",
    path: "/api/coding-github/v1/skills/install/plan",
    label: "Plan a GitHub-hosted skill install",
    scopes: ["repo:read", "skill:install"],
    inputSchema: schema(["owner", "repo", "ref", "path"], {
      ...REPOSITORY_PROPERTIES,
      ref: STRING,
      path: STRING
    })
  },
  {
    category: "skill-installer",
    id: "github.skills.install.apply",
    method: "POST",
    path: "/api/coding-github/v1/skills/install/apply",
    label: "Apply a GitHub-hosted skill install plan",
    scopes: ["repo:read", "skill:install"],
    risk: "safe_write",
    inputSchema: schema(["owner", "repo", "ref", "path", "planRef", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      ref: STRING,
      path: STRING,
      planRef: STRING,
      idempotencyKey: IDEMPOTENCY_KEY
    })
  },
  {
    category: "skill-installer",
    id: "github.skills.install.rollback",
    method: "POST",
    path: "/api/coding-github/v1/skills/install/rollback",
    label: "Roll back a GitHub-hosted skill install",
    scopes: ["skill:install", "workspace:maintain"],
    risk: "repair_write",
    inputSchema: schema(["owner", "repo", "ref", "path", "installRef", "idempotencyKey"], {
      ...REPOSITORY_PROPERTIES,
      ref: STRING,
      path: STRING,
      installRef: STRING,
      idempotencyKey: IDEMPOTENCY_KEY
    })
  }
]);

function routeParams(path) {
  return Object.freeze([...path.matchAll(/:([A-Za-z][A-Za-z0-9]*)/gu)].map(([, name]) => Object.freeze({
    name,
    aliases: Object.freeze([name, name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)]),
    required: true
  })));
}

function resourceFor(id, risk) {
  const category = OPERATION_SPECS.find((entry) => entry.id === id)?.category || "github";
  return Object.freeze({
    capabilityDomain: "coding_github",
    resourceKind: category,
    capabilityVerb: id.split(".").at(-1).replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`),
    effectKind: risk === "read_only" ? "read" : risk.replace(/_/gu, "-"),
    fieldMap: Object.freeze({})
  });
}

function definition(spec) {
  const risk = spec.risk || "read_only";
  const method = spec.method || "POST";
  const params = routeParams(spec.path);
  const command = spec.id.split(".");
  const resource = resourceFor(spec.id, risk);
  return Object.freeze({
    id: spec.id,
    category: spec.category,
    feature: "coding_github",
    featureId: "coding-github",
    label: spec.label,
    description: `Governed GitHub connector operation for ${spec.id}.`,
    target: Object.freeze({ controller: "plugin", method: "execute" }),
    http: Object.freeze({ method, path: spec.path, params, localInForwardMode: true }),
    rpc: Object.freeze({ method: spec.id, body: "params", params }),
    cli: Object.freeze({ command, usage: `${command.join(" ")} --body request.json` }),
    requiredScopes: Object.freeze([...spec.scopes]),
    toolsets: Object.freeze([
      spec.category === "skill-installer" ? "meshrix.skillHub.install" : "meshrix.codespace",
      risk === "read_only" ? "meshrix.repo.read" : "meshrix.repo.write"
    ]),
    readOnly: risk === "read_only",
    concurrencySafe: risk === "read_only",
    safety: Object.freeze({
      risk,
      requiresConfirmation: risk === "repair_write",
      ...(risk === "repair_write" ? { approvalScope: "workspace:maintain" } : {})
    }),
    risk,
    aspects: Object.freeze([
      "external-service",
      "operation-permission",
      "mcp",
      "dispatch",
      "authorization",
      "safety",
      "audit"
    ]),
    resource,
    resourceContext: resource,
    proof: Object.freeze({ binding: "proof-bound", lifecycle: "two-stage", substrate: "operation-proof-substrate" }),
    inputSchema: spec.inputSchema
  });
}

export const CODING_GITHUB_OPERATION_DEFINITIONS = Object.freeze(OPERATION_SPECS.map(definition));
export const PLUGIN_OPERATION_DEFINITIONS = CODING_GITHUB_OPERATION_DEFINITIONS;

function idsFor(category) {
  return Object.freeze(OPERATION_SPECS.filter((entry) => entry.category === category).map((entry) => entry.id));
}

export const GITHUB_REST_OPERATION_IDS = idsFor("rest");
export const GITHUB_MCP_OPERATION_IDS = idsFor("mcp");
export const GITHUB_CODESPACE_OPERATION_IDS = idsFor("codespace");
export const GITHUB_SKILL_INSTALLER_OPERATION_IDS = idsFor("skill-installer");
export const CODING_GITHUB_OPERATIONS_BY_ID = Object.freeze(Object.fromEntries(
  CODING_GITHUB_OPERATION_DEFINITIONS.map((operation) => [operation.id, operation])
));

export const PLUGIN_MCP_TOOL_BINDINGS = Object.freeze(Object.fromEntries(
  CODING_GITHUB_OPERATION_DEFINITIONS.map((operation) => [
    `meshrix.${operation.id}`,
    Object.freeze({ operationId: operation.id, outlet: "meshrix.gateway" })
  ])
));

export function codingGithubRouteId(operationId) {
  return `${operationId}.http`;
}
