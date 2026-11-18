# Format conversion

Operator-facing functionality of the `file-parser/format-convert` service.
This document projects the canonical multipart contract. The repository-local
implementation exposes no JSON/Base64 document transport compatibility route.

## Conversions

| Input | `targetFormat` | Result |
| --- | --- | --- |
| `.txt` | omitted or `pdf` | DOCX is generated temporarily and rendered to PDF |
| `.txt` | `docx` | DOCX |
| `.doc` or `.docx` | omitted or `pdf` | PDF |

TXT input must be valid UTF-8; a UTF-8 BOM is accepted. Blank lines delimit
paragraphs, and wrapped lines inside a paragraph are joined with spaces. The
generated DOCX uses A4 pages, fixed margins, Liberation Serif, justified body
text, first-line indentation, and consistent paragraph spacing.

## Operation

- The service is configured through environment variables; defaults are
  documented in the [service README](../../services/file-parser/format-convert/README.md).
- Readiness is reported on `GET /readyz`.
- The container runs unprivileged with a read-only root filesystem. Mount an
  ephemeral `tmpfs` scratch directory and deny outbound network access.
- The image ships a fixed font set (DejaVu Core, Liberation 2, Noto CJK).
  Install additional organization-required fonts into a derived image and keep
  the font set fixed; font substitutions change pagination and line wrapping.

## Meshrix integration

Through the Meshrix upstream gateway, MCP and other JSON-only callers pass an
owner-bound artifact reference in the `file` argument; the result is stored as
an owner-bound artifact and returned as an MCP `resource_link`. Document bytes
are not embedded in JSON or Base64 encoded in the canonical contract. See
[protocols/convert-api.md](../protocols/convert-api.md) and the importable
[upstream-service descriptor](../examples/file-parser-format-convert.upstream.json).
