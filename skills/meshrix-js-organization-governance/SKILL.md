---
name: meshrix-js-organization-governance
description: Configure organization governance on a Meshrix.js instance — import a built-in organization template, preview the draft, and publish it so organization nodes exist for API Key issuance and authorization scoping. Use when an instance reports organization governance unconfigured or when API Key issuance fails with api_key_scope_denied.
---

# Meshrix.js Organization Governance

This skill owns **configuring organization governance** on a Meshrix.js
instance. Organization nodes are a prerequisite for issuing scoped API Keys
and for authorization projection; an unconfigured instance reports
`snapshot.configured: false` and rejects key issuance with
`api_key_scope_denied`.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. The configuring actor needs `auth:admin` (the initial owner has it).
   Log in through `POST <server-url>/api/auth/login` and use the session
   cookie plus CSRF headers on every mutating request.
3. Governance, grants, and key lifecycle are owned by
   `$meshrix-js-operation-permission`; this skill only publishes the
   organization shape.

## Check the current state

`GET <server-url>/api/authorization/organization-governance` returns
`snapshot.configured` and the available `templates`. A configured instance
already has nodes; do not republish over it without an explicit reason.

## Use a built-in template (default path)

The instance ships built-in templates (for example `enterprise-group`:
Group → two organization levels → department → team). Prefer a built-in
template over a hand-written draft.

1. **Import** the template to get a publishable draft:

   ```bash
   POST /api/authorization/organization-governance/import
   {"templateKey": "enterprise-group"}
   # response: { ok: true, draft: { ... } }
   ```

   The `draft` carries `schemaVersion`, `templateKey`, `templateName`,
   `description`, `organizationDepth`, `nodes`, `tags`, and `roles`.

2. **Preview** (optional) validates the draft:

   ```bash
   POST /api/authorization/organization-governance/preview
   { ...draft, expectedRevision: <current revision> }
   ```

3. **Publish** applies it:

   ```bash
   POST /api/authorization/organization-governance/publish
   { ...draft, expectedRevision: <current revision> }
   # header X-Meshrix-Safety-Confirm: true (repair_write)
   ```

   `expectedRevision` is the current `snapshot.revision` (0 for an
   unconfigured instance). Publishing returns the new `snapshot` with
   `configured: true`.

## After publishing

- `GET /api/operation-permission/v1/api-keys/issuer-scopes` now lists the
  published nodes in `eligibleNodes`; use one as `organizationNodeId` when
  issuing keys (see `$meshrix-js-api-key-issuance`).
- The organization tags and roles feed authorization projection; granting
  subjects and roles is owned by `$meshrix-js-operation-permission`.

## Boundaries

Do not hand-edit the governance store or publish a draft that did not come
from an import or an explicit operator-supplied template. Re-publishing
replaces the organization shape; confirm the current revision before
overwriting. Governance content is not secret, but keep it out of reports and
logs that do not need it.
