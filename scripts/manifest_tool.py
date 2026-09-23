#!/usr/bin/env python3
"""Slim Better Plan v3 host helper: validate + init-plan only.

Full Designer/Worker/Reviewer CLI: check out https://github.com/Unka-Malloc/better-plan
(nightly) and use that repository's scripts/manifest_tool.py.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

MANIFEST_SCHEMA = "better-plan.manifest/v3"
PLAN_SCHEMA = "better-plan.plan/v3"
CHECKPOINTS_SCHEMA = "better-plan.checkpoints/v3"
PLAN_CODE_PREFIX = "PLAN-"
TASK_CODE_PREFIX = "TASK-"
AUTHORIZED_PHASES = frozenset({"authorized", "revising", "completed", "blocked"})
DRAFTISH_PHASES = frozenset({"draft", "designing", "ready"})


def load_json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"missing JSON file: {path}") from None
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON in {path}: {exc}") from None


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, indent=2, ensure_ascii=False, sort_keys=True) + "\n",
        encoding="utf-8",
    )


def require_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be an object")
    return value


def require_list(value: Any, label: str) -> list[Any]:
    if not isinstance(value, list):
        raise ValueError(f"{label} must be an array")
    return value


def require_string(obj: dict[str, Any], key: str, label: str) -> str:
    value = obj.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{label}.{key} must be a non-empty string")
    return value


def require_code(value: str, prefix: str, label: str) -> None:
    suffix = value.removeprefix(prefix)
    if not value.startswith(prefix) or not suffix or not all(ch.isalnum() or ch == "-" for ch in suffix):
        # Accept PLAN-001 and PLAN-001A style; keep prefix discipline.
        if not value.startswith(prefix) or len(value) <= len(prefix):
            raise ValueError(f"{label} must use {prefix}* form: {value}")


def safe_relative_path(value: str, label: str) -> Path:
    path = Path(value)
    if path.is_absolute() or not path.parts or ".." in path.parts:
        raise ValueError(f"{label} must be a workspace-relative path")
    return path


def task_codes(tasks: Any, label: str) -> list[str]:
    codes: list[str] = []
    for index, raw_task in enumerate(require_list(tasks, label)):
        task = require_object(raw_task, f"{label}[{index}]")
        code = require_string(task, "code", f"{label}[{index}]")
        require_code(code, TASK_CODE_PREFIX, f"{label}[{index}].code")
        if code in codes:
            raise ValueError(f"duplicate task code in {label}: {code}")
        codes.append(code)
    return codes


def render_plan_md(plan: dict[str, Any]) -> str:
    intent = plan.get("intent") or {}
    scope = intent.get("scope") or {}
    lines = [
        f"# {plan.get('code', 'PLAN')} {plan.get('title', '')}".rstrip(),
        "",
        f"Phase: {plan.get('phase', 'draft')} · Revision: unsealed",
        "",
        "This document is a render-only projection of `Plan.json`. Edit `Plan.json`; never edit this file.",
        "",
        "## Intent",
        "",
        f"**Goal**: {intent.get('goal', '')}",
        "",
        "**In scope**",
    ]
    for item in scope.get("in") or []:
        lines.append(f"- {item}")
    lines.extend(["", "**Out of scope**"])
    for item in scope.get("out") or []:
        lines.append(f"- {item}")
    lines.extend(["", "**Success**"])
    for item in intent.get("success") or []:
        lines.append(f"- {item}")
    lines.extend(["", "**Risk boundary**"])
    for item in intent.get("risk_boundary") or []:
        lines.append(f"- {item}")
    dossier = plan.get("dossier") or {}
    lines.extend(
        [
            "",
            "## Decisions",
            "",
            f"Dossier status: {dossier.get('status', 'not_required')}",
            "",
        ]
    )
    observed = (plan.get("ledger") or {}).get("observed") or []
    lines.append("### Observed repository facts")
    lines.append("")
    if observed:
        for item in observed:
            if isinstance(item, dict):
                fact = item.get("fact") or item.get("summary") or json.dumps(item, ensure_ascii=False)
                lines.append(f"- {fact}")
            else:
                lines.append(f"- {item}")
    else:
        lines.append("- none")
    lines.extend(
        [
            "",
            "## Requirements",
            "",
            "None recorded yet." if not (plan.get("spec") or {}).get("requirements") else "",
            "",
            "## Tasks",
            "",
            "None recorded yet." if not (plan.get("spec") or {}).get("tasks") else "",
            "",
            "## Authorization",
            "",
            "Not authorized. Designer session has not completed. Do not invent Tasks or start Workers.",
            "",
        ]
    )
    return "\n".join(line for line in lines if line is not None).rstrip() + "\n"


def plan_template(
    *,
    code: str,
    title: str,
    directory: str,
    goal: str,
    scope_in: list[str],
    scope_out: list[str],
    success: list[str],
    risk_boundary: list[str],
) -> dict[str, Any]:
    return {
        "schema": PLAN_SCHEMA,
        "code": code,
        "title": title,
        "directory": directory,
        "phase": "draft",
        "intent": {
            "goal": goal,
            "scope": {"in": scope_in, "out": scope_out},
            "success": success,
            "risk_boundary": risk_boundary,
            "autonomy": {
                "allow_in_scope_revision": True,
                "allow_reviewer_repairs": True,
                "forbid_mid_execution_questions": True,
                "blocked_branch_policy": "continue_independent_work",
            },
        },
        "ledger": {
            "observed": [],
            "user_decided": [],
            "defaulted": [],
            "unresolved": [],
        },
        "dossier": {"status": "not_required", "questions": []},
        "spec": {
            "requirements": [],
            "architecture": {"summary": "", "notes": []},
            "tasks": [],
            "full_regression": {"commands": [], "paths": []},
        },
        "lifecycle": {
            "sealed": None,
            "designer_session": None,
            "reviewer_session": None,
            "authorization": None,
            "continuation_receipts": [],
        },
    }


def validate_plan_entry(workspace: Path, raw_entry: Any, index: int) -> tuple[str, str]:
    label = f"manifest.plans[{index}]"
    entry = require_object(raw_entry, label)
    code = require_string(entry, "code", label)
    require_code(code, PLAN_CODE_PREFIX, f"{label}.code")
    directory = require_string(entry, "directory", label)
    require_string(entry, "title", label)
    plan_path = safe_relative_path(require_string(entry, "plan", label), f"{label}.plan")
    plan_dir = safe_relative_path(directory, f"{label}.directory")
    if len(plan_dir.parts) != 1:
        raise ValueError(f"{label}.directory must name one direct workspace child")
    if plan_path != plan_dir / "Plan.json":
        raise ValueError(f"{label}.plan must be {directory}/Plan.json")

    absolute_plan_dir = workspace / plan_dir
    if not absolute_plan_dir.is_dir():
        raise ValueError(f"missing plan directory: {plan_dir.as_posix()}")
    if not (absolute_plan_dir / "Plan.json").is_file():
        raise ValueError(f"missing v3 plan artifact: {(plan_dir / 'Plan.json').as_posix()}")

    plan = require_object(load_json(workspace / plan_path), plan_path.as_posix())
    if plan.get("schema") != PLAN_SCHEMA:
        raise ValueError(f"{plan_path.as_posix()}.schema must be {PLAN_SCHEMA}")
    if plan.get("code") != code:
        raise ValueError(f"{plan_path.as_posix()}.code must match manifest code {code}")
    if plan.get("directory") != directory:
        raise ValueError(f"{plan_path.as_posix()}.directory must match manifest directory")
    phase = require_string(plan, "phase", plan_path.as_posix())
    plan_spec = require_object(plan.get("spec"), f"{plan_path.as_posix()}.spec")
    tasks = plan_spec.get("tasks")
    require_list(tasks, f"{plan_path.as_posix()}.spec.tasks")
    plan_task_codes = task_codes(tasks, f"{plan_path.as_posix()}.spec.tasks")
    if phase not in DRAFTISH_PHASES and not plan_task_codes:
        raise ValueError(f"{plan_path.as_posix()}.spec.tasks must not be empty for phase {phase}")

    checkpoints_key = entry.get("checkpoints")
    checkpoints_path: Path | None = None
    if checkpoints_key is not None:
        checkpoints_path = safe_relative_path(
            require_string(entry, "checkpoints", label), f"{label}.checkpoints"
        )
        if checkpoints_path != plan_dir / "Checkpoints.json":
            raise ValueError(f"{label}.checkpoints must be {directory}/Checkpoints.json")

    checkpoints_file = absolute_plan_dir / "Checkpoints.json"
    if checkpoints_file.is_file():
        if checkpoints_path is None:
            checkpoints_path = plan_dir / "Checkpoints.json"
        checkpoints = require_object(
            load_json(workspace / checkpoints_path), checkpoints_path.as_posix()
        )
        if checkpoints.get("schema") != CHECKPOINTS_SCHEMA:
            raise ValueError(
                f"{checkpoints_path.as_posix()}.schema must be {CHECKPOINTS_SCHEMA}"
            )
        if checkpoints.get("plan") != code:
            raise ValueError(f"{checkpoints_path.as_posix()}.plan must match {code}")
        checkpoint_task_codes = task_codes(
            checkpoints.get("tasks"), f"{checkpoints_path.as_posix()}.tasks"
        )
        if plan_task_codes and checkpoint_task_codes != plan_task_codes:
            raise ValueError(
                f"{checkpoints_path.as_posix()}.tasks must match Plan.json task order"
            )
        sealed = require_object(plan.get("lifecycle"), f"{plan_path.as_posix()}.lifecycle").get(
            "sealed"
        )
        if sealed is not None:
            sealed_obj = require_object(sealed, f"{plan_path.as_posix()}.lifecycle.sealed")
            if checkpoints.get("revision") != sealed_obj.get("revision"):
                raise ValueError(
                    f"{checkpoints_path.as_posix()}.revision must match sealed revision"
                )
            if checkpoints.get("semantic_digest") != sealed_obj.get("semantic_digest"):
                raise ValueError(
                    f"{checkpoints_path.as_posix()}.semantic_digest must match sealed digest"
                )
    elif phase in AUTHORIZED_PHASES:
        raise ValueError(f"{directory}: missing authorized Checkpoints.json")

    return code, directory


def validate_workspace(target: Path) -> None:
    workspace = target if target.is_dir() else target.parent
    manifest_path = workspace / "Manifest.json" if target.is_dir() else target
    if manifest_path.name != "Manifest.json":
        raise ValueError("validate target must be a v3 plan workspace or its Manifest.json")

    manifest = require_object(load_json(manifest_path), manifest_path.as_posix())
    if manifest.get("schema") != MANIFEST_SCHEMA:
        raise ValueError(f"{manifest_path}.schema must be {MANIFEST_SCHEMA}")
    plans = require_list(manifest.get("plans"), f"{manifest_path}.plans")
    if not plans:
        raise ValueError(f"{manifest_path}.plans must not be empty")

    seen_codes: set[str] = set()
    seen_directories: set[str] = set()
    for index, entry in enumerate(plans):
        code, directory = validate_plan_entry(workspace, entry, index)
        if code in seen_codes:
            raise ValueError(f"duplicate manifest plan code: {code}")
        if directory in seen_directories:
            raise ValueError(f"duplicate manifest plan directory: {directory}")
        seen_codes.add(code)
        seen_directories.add(directory)


def split_multi(values: list[str]) -> list[str]:
    items: list[str] = []
    for value in values:
        for part in value.split("||"):
            part = part.strip()
            if part:
                items.append(part)
    if not items:
        raise ValueError("at least one value is required")
    return items


def command_validate(args: argparse.Namespace) -> int:
    try:
        validate_workspace(Path(args.path))
    except ValueError as exc:
        print(f"manifest validation failed: {exc}", file=sys.stderr)
        return 1
    print("OK: Better Plan v3 workspace is valid")
    return 0


def command_init_plan(args: argparse.Namespace) -> int:
    root = Path(args.root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    manifest_path = root / "Manifest.json"
    if manifest_path.is_file():
        manifest = require_object(load_json(manifest_path), manifest_path.as_posix())
        if manifest.get("schema") != MANIFEST_SCHEMA:
            raise SystemExit(f"{manifest_path}: schema must be {MANIFEST_SCHEMA}")
        plans = require_list(manifest.get("plans"), "manifest.plans")
    else:
        manifest = {"schema": MANIFEST_SCHEMA, "plans": []}
        plans = manifest["plans"]

    for entry in plans:
        if isinstance(entry, dict) and (
            entry.get("directory") == args.directory or entry.get("code") == args.code
        ):
            print("plan code or directory already exists", file=sys.stderr)
            return 1

    plan = plan_template(
        code=args.code,
        title=args.title,
        directory=args.directory,
        goal=args.goal,
        scope_in=split_multi(args.scope_in),
        scope_out=split_multi(args.scope_out),
        success=split_multi(args.success),
        risk_boundary=split_multi(args.risk_boundary),
    )
    plan_dir = root / args.directory
    plan_dir.mkdir(parents=True, exist_ok=False)
    write_json(plan_dir / "Plan.json", plan)
    (plan_dir / "Plan.md").write_text(render_plan_md(plan), encoding="utf-8")
    plans.append(
        {
            "code": plan["code"],
            "title": plan["title"],
            "directory": plan["directory"],
            "plan": f"{plan['directory']}/Plan.json",
        }
    )
    write_json(manifest_path, manifest)
    print(json.dumps({"plan": plan["code"], "phase": plan["phase"]}))
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Slim Better Plan v3 helper (validate + init-plan)."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    validate_parser = subparsers.add_parser("validate", help="Validate one v3 workspace.")
    validate_parser.add_argument("path")
    validate_parser.set_defaults(func=command_validate)

    init_parser = subparsers.add_parser("init-plan", help="Create one draft Delivery Plan.")
    init_parser.add_argument("root")
    init_parser.add_argument("--code", required=True)
    init_parser.add_argument("--title", required=True)
    init_parser.add_argument("--directory", required=True)
    init_parser.add_argument("--goal", required=True)
    init_parser.add_argument(
        "--scope-in",
        required=True,
        action="append",
        help="In-scope item; repeat or join with ||",
    )
    init_parser.add_argument(
        "--scope-out",
        required=True,
        action="append",
        help="Out-of-scope item; repeat or join with ||",
    )
    init_parser.add_argument(
        "--success",
        required=True,
        action="append",
        help="Success condition; repeat or join with ||",
    )
    init_parser.add_argument(
        "--risk-boundary",
        required=True,
        action="append",
        help="Risk boundary; repeat or join with ||",
    )
    init_parser.set_defaults(func=command_init_plan)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
