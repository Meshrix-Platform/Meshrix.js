# Local Temporary Reports

All temporary assessments, audits, stage reports, implementation reviews, and
similar non-authoritative working reports belong under `docs/report/`.

## Repository Boundary

- Files under `docs/report/` are tracked in local Git history so local work can
  be reviewed and recovered.
- Report content is committed only on the local `local/reports` branch. Keep
  `nightly` and every remote-facing development branch free of report content.
- These files are local-only material. They must not be pushed to a remote
  repository, included in a pull request, published as release evidence, or
  shipped in a source or container artifact.
- The repository pre-push hook inspects every outgoing commit, including the
  complete reachable history of a new remote reference, and rejects an update
  when any outgoing tree contains `docs/report/`.
- `.gitattributes` excludes the directory from Git archives. The source-package,
  container, and public-artifact boundaries also exclude it.

Tracking a report is not permission to publish it. Do not bypass the pre-push
hook or copy a report into another tracked path to evade this boundary.

## Content Rules

- Use synthetic or redacted evidence only. Do not retain credentials, personal
  data, machine identity, local absolute paths, private service data, raw
  runtime rows, or unreviewed command output.
- Keep Better Plan authority in `docs/plan/`. `Plan.md`, `Checkpoints.json`,
  `Requirements.md`, `Architecture.md`, `Validation.md`, `Evidence.md`, and the
  plan manifest are planning assets, not temporary reports.
- Move an implemented and verified technical fact into the formal document
  that owns that behavior. The temporary report remains non-authoritative.
- Run the repository local-information and privacy checks before committing a
  new or changed report.

## Local Workflow

1. Create or move the report under `docs/report/`.
2. Remove obsolete copies from other directories in the same change.
3. Review and redact the report, then run the repository hygiene checks.
4. Commit the report on `local/reports`, never on `nightly` or a branch intended
   for remote publication.
5. Start implementation and publication branches from `nightly`, not from
   `local/reports`.
6. Before any remote publication, keep every commit containing `docs/report/`
   outside the outgoing update.
