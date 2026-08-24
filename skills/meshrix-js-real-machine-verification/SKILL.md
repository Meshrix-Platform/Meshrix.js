---
name: meshrix-js-real-machine-verification
description: Run the optional Meshrix.js real-machine verification workflow after a current candidate-bound functional-complete receipt — Linux VM closed-loop delivery checks, environment qualification, and the environment support claim. It must never block or replace functional acceptance. Functional acceptance is owned by $meshrix-js-platform-acceptance-workflow.
---

# Meshrix.js Real-Machine Verification

This skill owns the **optional real-machine verification workflow** for
Meshrix.js: Linux VM closed-loop delivery checks, environment qualification,
and the environment support claim. Functional acceptance is owned by
`$meshrix-js-platform-acceptance-workflow`.

## Establish authority

1. Run `git status --short` for every repository boundary before editing.
2. Treat this workflow as strictly optional and subordinate: it may run only
   after consuming a current, candidate-bound `functional-complete` receipt
   from `$meshrix-js-platform-acceptance-workflow`.

## Scope and boundary

Real-machine execution, publisher identity, credential, signing, notarization,
listing, store access, and network-server availability are outside the
mandatory functional-completeness claim. They must not make functional
acceptance or an otherwise eligible project release fail.

This workflow may issue an environment support claim for the tested candidate
and target, but it must never revoke, block, or replace functional acceptance.
Layer tests and claim-specific profiles supply scoped evidence; they do not
independently establish another claim's readiness.

## Run the workflow

Plan-scoped offline delivery and the current plan receipt may close on a Linux
operating system inside a virtual machine. Prefer Ubuntu; accept Debian. A
macOS operator host is allowed when that Linux VM is reachable. This path is
not `npm run verify:acceptance`. Native Linux, Ubuntu, Debian, and environment
qualification remain remaining required work after this workflow.

Run the closed loop inside the Linux VM: environment check, repository
contract discovery, build, runtime start, and health verification. Keep the
VM's operating system, reachability, and qualification facts in the bounded
environment support claim.

## Report

Report only the environment support claim, the tested candidate and target,
and the VM operating system and reachability facts. Never claim functional
readiness from this workflow, and never let its failure affect an otherwise
eligible functional acceptance.
